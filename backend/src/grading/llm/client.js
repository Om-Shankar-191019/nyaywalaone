import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { sha256Hex, stableStringify } from '../canonical-utils.js';

/**
 * One place that talks to a language model.
 *
 * Three things went wrong when this logic lived inside `llm-review.js`:
 *
 * 1. A single hard-coded model. Groq retired `llama-3.3-70b-versatile` for new
 *    keys, every request came back `404 model_not_found`, and the report showed
 *    a red `error` badge on every submission. The fix is not a new model name -
 *    that will rot too - but a fallback chain that treats `model_not_found` as
 *    "try the next model", not as "the feature is broken".
 * 2. A single provider. A free tier runs out, a key gets revoked, a campus
 *    firewall blocks a host. Any provider with an OpenAI-compatible
 *    `/chat/completions` endpoint can serve the same request, so the chain
 *    walks providers in a configured order.
 * 3. An exception on every failure path. The caller saw `error`, which reads as
 *    "the grading engine is broken". A model being unreachable is *unavailable*
 *    evidence: it must never look like a zero, and it must never fail a report.
 *
 * Everything here is deliberately boring: no SDK, `fetch` only, temperature 0,
 * a seed where the provider honours one, a 20 s timeout, at most two requests in
 * flight, and a response cache keyed by the exact prompt. A re-grade of the same
 * submission returns the same prose.
 */

export const PROVIDERS = Object.freeze({
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Verified against a live free key on 2026-11-04: the 70B Llama models are
    // gone from new accounts, gpt-oss and qwen are present.
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile'],
    keys: 'https://console.groq.com/keys',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    keys: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // The `:free` variants cost nothing and need no card.
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen-2.5-72b-instruct:free'],
    keys: 'https://openrouter.ai/keys',
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b', 'gpt-oss-120b'],
    keys: 'https://cloud.cerebras.ai',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest'],
    keys: 'https://console.mistral.ai/api-keys',
  },
});

const DEFAULT_ORDER = 'groq,gemini,openrouter,cerebras,mistral';

/** Read at call time, not import time, so tests and long-lived processes agree. */
const env = (key) => {
  const raw = process.env[key];
  if (typeof raw !== 'string') return '';
  return raw.replace(/^\uFEFF/, '').replace(/[\r\n]+$/g, '').trim();
};

export const llmEnabled = () => {
  const raw = env('LLM_ENABLED').toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return config.LLM_ENABLED !== false;
};

/**
 * Providers that have a key, in the order the operator asked for them.
 * `LLM_PROVIDER=qwen` style shortcuts are not supported on purpose: one name
 * means one place to look when a key stops working.
 */
export function providerChain({ includeWithoutKey = false } = {}) {
  const order = (env('LLM_PROVIDER_ORDER') || DEFAULT_ORDER)
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const chain = [];
  for (const name of order) {
    const preset = PROVIDERS[name];
    if (!preset) continue;
    const upper = name.toUpperCase();
    const apiKey = env(`${upper}_API_KEY`);
    if (!apiKey && !includeWithoutKey) continue;
    const baseUrl = (env(`${upper}_BASE_URL`) || preset.baseUrl).replace(/\/+$/, '');
    const requested = env(`${upper}_MODEL`);
    const models = [requested, ...preset.models].filter(Boolean).filter((model, index, all) => all.indexOf(model) === index);
    chain.push({ name, label: preset.label, apiKey, baseUrl, models, keys: preset.keys });
  }
  return chain;
}

export const llmConfigured = () => llmEnabled() && providerChain().length > 0;

/** A short, secret-free description for reports, health checks and the UI. */
export function llmStatus() {
  const chain = providerChain({ includeWithoutKey: true });
  const configured = providerChain();
  return {
    enabled: llmEnabled(),
    configured: configured.length > 0,
    order: chain.map((provider) => ({
      name: provider.name,
      label: provider.label,
      has_key: Boolean(provider.apiKey),
      model: provider.models[0] ?? null,
      base_url: provider.baseUrl,
      keys: provider.keys,
    })),
  };
}

/* --------------------------------------------------------------- concurrency */

/**
 * Free tiers meter requests per minute and reject bursts with 429. Two in
 * flight is enough for four analyzers and stays inside every free tier we use.
 */
const MAX_IN_FLIGHT = 2;
let inFlight = 0;
const waiting = [];

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      inFlight += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          inFlight -= 1;
          const next = waiting.shift();
          if (next) next();
        });
    };
    if (inFlight < MAX_IN_FLIGHT) run();
    else waiting.push(run);
  });
}

/* ------------------------------------------------------------------- parsing */

/**
 * Models sometimes wrap JSON in prose or a fenced block even when asked not to.
 * Take the largest balanced object rather than the first `{`, so a brace inside
 * a string literal does not truncate the payload.
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const withoutFence = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const direct = tryParse(withoutFence);
  if (direct) return direct;

  const start = withoutFence.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < withoutFence.length; index += 1) {
    const char = withoutFence[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return tryParse(withoutFence.slice(start, index + 1));
    }
  }
  return null;
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- caching */

async function readCache(promptHash) {
  // Unit tests must not need a database connection.
  if (config.isTest) return null;
  try {
    const row = await prisma.llmCache.findUnique({ where: { promptHash } });
    return row?.response ?? null;
  } catch {
    return null;
  }
}

async function writeCache(promptHash, model, paramsHash, response) {
  if (config.isTest) return;
  try {
    await prisma.llmCache.upsert({
      where: { promptHash },
      create: { promptHash, model, paramsHash, response },
      update: {},
    });
  } catch {
    // A cache that cannot be written is a slower run, not a failed one.
  }
}

/* ------------------------------------------------------------------ requests */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const classify = (status, message) => {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404 || /model_not_found|does not exist|not found/i.test(message)) return 'model_missing';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'provider_unavailable';
  if (status === 400) return 'bad_request';
  return 'http_error';
};

const summarize = (body, fallback) => {
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    return String(parsed?.error?.message ?? parsed?.message ?? fallback).slice(0, 300);
  } catch {
    return String(body ?? fallback).slice(0, 300);
  }
};

async function postChat({ provider, model, system, user, temperature, maxTokens, jsonMode, seed }) {
  return withSlot(async () => {
    const timeout = Number(process.env.LLM_TIMEOUT_MS) > 0 ? Number(process.env.LLM_TIMEOUT_MS) : config.LLM_TIMEOUT_MS;
    const body = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      // Only sent where it is honoured; an unknown field can be a 400 elsewhere.
      ...(provider.name === 'groq' ? { seed: seed ?? 42 } : {}),
    };

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.name === 'openrouter'
          ? { 'HTTP-Referer': 'https://nyaywala.local', 'X-Title': 'Nyaywala grading' }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: classify(response.status, text),
        message: summarize(text, `HTTP ${response.status}`),
        retryAfterMs: Math.min(5000, Math.max(0, Number(response.headers.get('retry-after') ?? 0) * 1000)),
      };
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, status: response.status, code: 'bad_json', message: 'The provider returned a non-JSON envelope.' };
    }
    const content = payload?.choices?.[0]?.message?.content ?? '';
    const json = extractJson(content);
    if (!json) {
      return { ok: false, status: response.status, code: 'bad_json', message: 'The reply was not the JSON object that was requested.' };
    }
    return { ok: true, json, model: payload?.model ?? model, usage: payload?.usage ?? null };
  });
}

/**
 * Ask for a JSON object and never throw.
 *
 * Returns `{ ok: true, json, provider, model, cached }` or
 * `{ ok: false, code, message, attempts }`. The caller decides whether that
 * means `unavailable` (grading continues) or `partial` (heuristics only).
 */
export async function chatJson({
  purpose,
  system,
  user,
  temperature = 0,
  maxTokens = 900,
  cache = true,
  jsonMode = true,
  seed,
}) {
  if (!llmEnabled()) {
    return { ok: false, code: 'disabled', message: 'Language-model features are switched off (LLM_ENABLED=false).', attempts: [] };
  }

  const chain = providerChain();
  if (!chain.length) {
    return {
      ok: false,
      code: 'not_configured',
      message: 'No language-model API key is configured (GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, CEREBRAS_API_KEY or MISTRAL_API_KEY).',
      attempts: [],
    };
  }

  const promptHash = sha256Hex(stableStringify({ v: 2, purpose, system, user, temperature, maxTokens }));
  if (cache) {
    const hit = await readCache(promptHash);
    if (hit && typeof hit === 'object') {
      return {
        ok: true,
        json: hit.json ?? hit,
        provider: hit.provider ?? 'cache',
        model: hit.model ?? 'cached',
        cached: true,
        attempts: [],
      };
    }
  }

  const attempts = [];
  let last = null;

  for (const provider of chain) {
    for (const model of provider.models) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let result;
        try {
          result = await postChat({ provider, model, system, user, temperature, maxTokens, jsonMode, seed });
        } catch (error) {
          const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
          result = {
            ok: false,
            status: 0,
            code: timedOut ? 'timeout' : 'network_error',
            message: `${error?.name ?? 'Error'}: ${error?.message ?? error}`.slice(0, 200),
          };
        }

        attempts.push({ provider: provider.name, model, code: result.ok ? 'ok' : result.code, status: result.status ?? 0, message: result.ok ? undefined : result.message });

        if (result.ok) {
          const stored = { json: result.json, provider: provider.name, model: result.model ?? model };
          await writeCache(promptHash, stored.model, promptHash.slice(0, 16), stored);
          return { ok: true, ...stored, cached: false, attempts };
        }

        last = { code: result.code, message: result.message, provider: provider.name, model };

        // A bad model name is a routing problem: try the next model at once.
        if (result.code === 'model_missing') break;

        // Some OpenAI-compatible servers reject `response_format`; retry plain.
        if (result.code === 'bad_request' && jsonMode && /response_format|json/i.test(String(result.message))) {
          result = await postChat({ provider, model, system, user, temperature, maxTokens, jsonMode: false, seed }).catch((error) => ({
            ok: false,
            status: 0,
            code: 'network_error',
            message: String(error?.message ?? error),
          }));
          if (result.ok) {
            const stored = { json: result.json, provider: provider.name, model: result.model ?? model };
            await writeCache(promptHash, stored.model, promptHash.slice(0, 16), stored);
            return { ok: true, ...stored, cached: false, attempts };
          }
          break;
        }

        // A dead key will not recover within this evaluation: move on.
        if (result.code === 'auth_failed') break;

        // Rate limits and 5xx are worth one wait, then the next model.
        if ((result.code === 'rate_limited' || result.code === 'provider_unavailable') && attempt === 0) {
          await sleep(result.retryAfterMs > 0 ? result.retryAfterMs : 800);
          continue;
        }
        break;
      }
    }
  }

  return {
    ok: false,
    code: last?.code ?? 'all_failed',
    message: last?.message ?? 'Every configured language-model provider failed.',
    provider: last?.provider ?? null,
    model: last?.model ?? null,
    attempts,
  };
}

/** Does this provider answer at all? Used by `npm run llm:check`. */
export async function probeProvider(provider) {
  const started = Date.now();
  const timeout = Number(process.env.LLM_TIMEOUT_MS) > 0 ? Number(process.env.LLM_TIMEOUT_MS) : config.LLM_TIMEOUT_MS;
  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(Math.min(timeout, 12_000)),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      message: response.ok ? null : summarize(text, `HTTP ${response.status}`),
    };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, message: `${error?.name}: ${error?.message}` };
  }
}
