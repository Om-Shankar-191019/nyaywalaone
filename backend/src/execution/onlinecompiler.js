import { config } from '../config.js';
import { AppError } from '../lib/http.js';
import { classifyRuntimeDetail, STATUS } from './status.js';

/**
 * onlinecompiler.io adapter - the Week 3 replacement for Judge0.
 *
 * Three properties of this API shape the code below, and all three come from
 * the published OpenAPI document rather than from guesswork:
 *
 *   1. The `Authorization` header carries the *bare* key. `Bearer <key>` is
 *      explicitly rejected with a 404 "Invalid or inactive API key", which reads
 *      like a wrong key when it is really a formatting mistake.
 *   2. A program that fails - compile error, segfault, timeout - still answers
 *      HTTP 200. The verdict lives in `status` and `exit_code`, never in the
 *      HTTP status line.
 *   3. There is no `compile_output` field. Compiler diagnostics and stderr share
 *      one `error` string, so compile failures are recognised by their shape.
 *
 * Compiler flags cannot be passed: the platform runs a fixed
 * `gcc -O2 code.c -o code.out -lm`. `capabilities.compilerFlags = false` says so
 * out loud, so the rule set, the evaluation key and the report's limitations
 * block all reflect what this sandbox can actually do.
 */

/** The only exit codes the API documents. */
export const ONLINE_COMPILER_EXIT_CODES = new Map([
  [0, STATUS.ACCEPTED],
  [71, STATUS.RUNTIME_ERROR_OTHER], // too many processes / threads
  [124, STATUS.TIME_LIMIT_EXCEEDED],
  [134, STATUS.RUNTIME_ERROR_SIGABRT], // 128 + 6
  [136, STATUS.RUNTIME_ERROR_SIGFPE], // 128 + 8
  [137, STATUS.RUNTIME_ERROR_OTHER], // 128 + 9, the OOM kill
  [139, STATUS.RUNTIME_ERROR_SIGSEGV], // 128 + 11
  [153, STATUS.RUNTIME_ERROR_SIGXFSZ], // 128 + 25, output flood
  [-1, STATUS.INTERNAL_ERROR],
]);

/**
 * `code.c:12:5: error: ...` is the compiler. Anything else on a non-zero exit is
 * the program talking. Requiring the file/line prefix stops a program that
 * prints the word "error:" to stderr from being graded as a compile failure.
 */
const COMPILE_DIAGNOSTIC = /^\s*(?:[^\s:]+\.c|code\.c):\d+:\d+:\s*(?:fatal\s+)?error:/m;

export const looksLikeCompileError = (text) => COMPILE_DIAGNOSTIC.test(String(text ?? ''));

/**
 * The published key has no `Bearer` prefix, but a key pasted from a tutorial or
 * a proxy config often keeps one. Strip it rather than failing with a 404 that
 * blames the credential.
 */
const bareKey = (value) => String(value ?? '').replace(/^\s*Bearer\s+/i, '').trim();

/** `time`, `total` and `memory` are decimal *strings* on this API. */
const secondsToMs = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : null;
};

const kb = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export function createOnlineCompilerProvider() {
  const baseUrl = config.ONLINECOMPILER_BASE_URL.replace(/\/$/, '');
  const apiKey = bareKey(config.ONLINECOMPILER_API_KEY);

  const headers = () => ({
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: apiKey } : {}),
  });

  async function request(path, { method = 'GET', body, timeoutMs = 25_000 } = {}) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new AppError(
        502,
        'PROVIDER_UNAVAILABLE',
        timedOut
          ? 'The execution sandbox did not answer in time. Try again; the run may still be finishing.'
          : `Could not reach the execution sandbox: ${error.message}`,
        { provider: 'onlinecompiler' },
      );
    }

    // Read the body once: every documented failure is `{ "error": "..." }`, but
    // a proxy in front of the API can answer with HTML, which is not JSON.
    const raw = await response.text().catch(() => '');
    let parsedBody = null;
    try {
      parsedBody = raw ? JSON.parse(raw) : null;
    } catch {
      parsedBody = null;
    }
    const message = parsedBody?.error ?? raw.slice(0, 300);

    if (response.status === 429) {
      throw new AppError(
        429,
        'PROVIDER_RATE_LIMITED',
        'The execution sandbox is rate limiting us (30 runs/minute, 2 at a time). Wait a moment and retry.',
        { provider: 'onlinecompiler', detail: message },
      );
    }
    if (response.status === 404) {
      throw new AppError(
        502,
        'PROVIDER_AUTH',
        'onlinecompiler.io rejected the API key. Check ONLINECOMPILER_API_KEY: it must be the bare key with no "Bearer " prefix, and it must be an API key rather than a WebSocket/widget key.',
        { provider: 'onlinecompiler', detail: message },
      );
    }
    if (response.status === 403) {
      throw new AppError(
        502,
        'PROVIDER_AUTH',
        'onlinecompiler.io refused the key: a widget/WebSocket key cannot call the REST API.',
        { provider: 'onlinecompiler', detail: message },
      );
    }
    if (response.status === 503) {
      throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'The execution queue is unavailable. Retry shortly.', {
        provider: 'onlinecompiler',
        detail: message,
      });
    }
    if (!response.ok) {
      throw new AppError(502, 'PROVIDER_ERROR', `Execution sandbox returned HTTP ${response.status}`, {
        provider: 'onlinecompiler',
        detail: message,
      });
    }

    if (!parsedBody) {
      throw new AppError(502, 'PROVIDER_ERROR', 'Execution sandbox returned a body that is not JSON', {
        provider: 'onlinecompiler',
        detail: raw.slice(0, 300),
      });
    }
    return parsedBody;
  }

  function normalize(result) {
    const exitCode = Number.isFinite(result.exit_code) ? result.exit_code : null;
    const errorText = String(result.error ?? '');

    const compileFailed = looksLikeCompileError(errorText);
    let code = ONLINE_COMPILER_EXIT_CODES.get(exitCode) ?? (exitCode === 0 ? STATUS.ACCEPTED : STATUS.RUNTIME_ERROR_NZEC);
    if (compileFailed) code = STATUS.COMPILATION_ERROR;

    const description =
      exitCode === null
        ? String(result.status ?? 'unknown')
        : compileFailed
          ? 'Compilation Error'
          : exitCode === 0
            ? 'Accepted'
            : `Exited with ${exitCode}`;

    return {
      provider: 'onlinecompiler',
      token: null,
      status: {
        id: exitCode,
        code,
        description,
        detail:
          classifyRuntimeDetail({ code, stderr: errorText }) ??
          (exitCode === 137
            ? 'SIGKILL'
            : exitCode === 153
              ? 'SIGXFSZ'
              : exitCode === 71
                ? 'TOO_MANY_PROCESSES'
                : null),
      },
      stdout: String(result.output ?? ''),
      // Compile diagnostics and stderr share one field on this API; keep the
      // runtime view clean so a report does not show the compiler twice.
      stderr: compileFailed ? '' : errorText,
      compileOutput: compileFailed ? errorText : '',
      message: result.truncated ? 'Output was truncated at the provider ceiling.' : '',
      timeMs: secondsToMs(result.time),
      totalMs: secondsToMs(result.total),
      memoryKb: kb(result.memory),
      timeLimitSeconds: Number.isFinite(result.time_limit) ? result.time_limit : null,
      truncated: Boolean(result.truncated),
    };
  }

  return {
    name: 'onlinecompiler',

    /**
     * What this sandbox can and cannot be asked to do. The coordinator reads
     * this so a rule set never promises `-Wall` output the provider cannot
     * produce, and the report's limitations block stays truthful.
     */
    capabilities: Object.freeze({
      compilerFlags: false,
      cpuTimeLimit: false,
      memoryLimit: false,
      processLimit: false,
      networkControl: false,
      perRunTimeLimit: true,
      maxTimeLimitSeconds: 30,
      synchronous: true,
      // The API accepts two concurrent runs and answers 429 beyond that.
      maxConcurrentRuns: 2,
    }),

    async run({ source, stdin = '', limits }) {
      // `time_limit` is the only knob the API exposes, and compilation counts
      // against it, so a two-second run needs more headroom than two seconds.
      const requested = limits?.wallTimeLimitSeconds ?? 5;
      const timeLimit = Math.min(30, Math.max(1, Math.ceil(requested)));

      const result = await request('/api/run-code-sync/', {
        method: 'POST',
        body: {
          compiler: config.ONLINECOMPILER_COMPILER,
          code: source,
          input: stdin ?? '',
          time_limit: timeLimit,
        },
        timeoutMs: (config.ONLINECOMPILER_TIMEOUT_SECONDS + timeLimit) * 1000,
      });

      return normalize(result);
    },

    /** Liveness. `/api/health/` needs no key and spends no quota. */
    async ping() {
      const health = await request('/api/health/', { timeoutMs: 10_000 });
      return {
        provider: 'onlinecompiler',
        version: String(health?.version ?? health?.status ?? 'ok'),
        compiler: config.ONLINECOMPILER_COMPILER,
      };
    },

    /** This month's spend, so `/meta/usage` can show real numbers. */
    async usage() {
      if (!config.ONLINECOMPILER_API_KEY) return null;
      try {
        return await request('/api/usage/', { timeoutMs: 10_000 });
      } catch {
        // Usage is decoration, not evidence: never fail a request over it.
        return null;
      }
    },

    sanitizerFlags: [],
    statusCodes: STATUS,
  };
}
