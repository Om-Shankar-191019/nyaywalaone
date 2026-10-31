import { config } from '../config.js';
import { AppError } from '../lib/http.js';
import { classifyRuntimeDetail, isPending, mapJudge0Status, STATUS } from './status.js';

const FIELDS = 'token,stdout,stderr,compile_output,message,status,time,memory';

const authHeaders = () =>
  config.JUDGE0_API_KEY
    ? {
        'X-RapidAPI-Key': config.JUDGE0_API_KEY,
        ...(config.JUDGE0_API_HOST ? { 'X-RapidAPI-Host': config.JUDGE0_API_HOST } : {}),
      }
    : {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Judge0 CE adapter.
 *
 * `wait=true` is used as an optimisation, but it is documented as disabled on
 * some hosts, so a submission that comes back pending is always polled. That
 * twenty-line fallback is the difference between a working demo and a broken
 * one on a host that ignores the flag.
 */
export function createJudge0Provider() {
  const baseUrl = config.JUDGE0_BASE_URL.replace(/\/$/, '');

  async function request(path, init) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      throw new AppError(502, 'PROVIDER_UNAVAILABLE', `Could not reach the execution sandbox: ${error.message}`);
    }

    if (response.status === 429) {
      throw new AppError(429, 'PROVIDER_RATE_LIMITED', 'The execution sandbox is rate limiting us. Wait a minute and retry.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, 'PROVIDER_AUTH', 'The execution sandbox rejected our credentials. Check JUDGE0_API_KEY / JUDGE0_API_HOST.');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError(502, 'PROVIDER_ERROR', `Execution sandbox returned HTTP ${response.status}`, text.slice(0, 500));
    }

    return response.json();
  }

  function normalize(result) {
    const status = mapJudge0Status(result.status?.id);
    const seconds = Number.parseFloat(result.time ?? '0');

    return {
      provider: 'judge0',
      token: result.token ?? null,
      status: { ...status, detail: classifyRuntimeDetail({ code: status.code, stderr: result.stderr }) },
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      compileOutput: result.compile_output ?? '',
      message: result.message ?? '',
      timeMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
      memoryKb: typeof result.memory === 'number' ? result.memory : null,
    };
  }

  async function poll(token, { attempts = 12, baseDelayMs = 250, factor = 1.5 } = {}) {
    let delay = baseDelayMs;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await request(`/submissions/${token}?base64_encoded=false&fields=${FIELDS}`);
      const normalized = normalize(result);
      if (!isPending(normalized.status)) return normalized;
      await sleep(delay);
      delay = Math.round(delay * factor);
    }
    throw new AppError(504, 'PROVIDER_TIMEOUT', 'The execution sandbox did not finish in time');
  }

  return {
    name: 'judge0',

    async run({ source, stdin = '', compilerOptions, limits }) {
      const body = {
        source_code: source,
        language_id: config.JUDGE0_LANGUAGE_ID,
        stdin,
        compiler_options: compilerOptions,
        cpu_time_limit: limits.cpuTimeLimitSeconds,
        wall_time_limit: limits.wallTimeLimitSeconds,
        memory_limit: limits.memoryLimitKb,
        max_processes_and_or_threads: limits.maxProcesses,
        enable_network: limits.enableNetwork,
      };

      const created = await request('/submissions?base64_encoded=false&wait=true&fields=' + FIELDS, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      // Some hosts ignore wait=true and answer 201 with only a token.
      if (!created.status) {
        if (!created.token) throw new AppError(502, 'PROVIDER_ERROR', 'Execution sandbox returned no token');
        return poll(created.token);
      }

      const normalized = normalize(created);
      if (isPending(normalized.status) && normalized.token) return poll(normalized.token);
      if (!normalized.status.code) throw new AppError(502, 'PROVIDER_ERROR', 'Execution sandbox returned an unknown status');
      return normalized;
    },

    /** Cheap liveness probe used by /api/health and the taxonomy script. */
    async ping() {
      const about = await request('/about');
      return { provider: 'judge0', version: about.version ?? 'unknown' };
    },

    /** Never used for grading, only for the human-readable notes on Day 6. */
    sanitizerFlags: ['-fsanitize=address', '-fsanitize=undefined'],
    statusCodes: STATUS,
  };
}
