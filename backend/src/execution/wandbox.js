import { config } from '../config.js';
import { AppError } from '../lib/http.js';
import { STATUS } from './status.js';

const SIGNAL_STATUS = {
  SIGSEGV: STATUS.RUNTIME_ERROR_SIGSEGV,
  SIGFPE: STATUS.RUNTIME_ERROR_SIGFPE,
  SIGABRT: STATUS.RUNTIME_ERROR_SIGABRT,
  SIGXFSZ: STATUS.RUNTIME_ERROR_SIGXFSZ,
  SIGKILL: STATUS.RUNTIME_ERROR_OTHER,
};

/**
 * Wandbox fallback. Keyless, which is useful when the public Judge0 instance
 * is busy - but it has no CPU, memory or process limits and no timing data, so
 * a report produced with it is not equivalent to one produced with Judge0.
 * That difference is recorded in `provider` on every result and in the report.
 */
export function createWandboxProvider() {
  const baseUrl = config.WANDBOX_BASE_URL.replace(/\/$/, '');

  return {
    name: 'wandbox',

    async run({ source, stdin = '', compilerOptions, limits }) {
      const options = String(compilerOptions ?? '')
        .split(/\s+/)
        .filter(Boolean);

      let response;
      try {
        response = await fetch(`${baseUrl}/api/compile.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            compiler: config.WANDBOX_COMPILER,
            code: source,
            stdin,
            'compiler-option-raw': options.join('\n'),
            'runtime-option-raw': '',
            save: false,
          }),
          // Wandbox compiles on demand and can be slow under load; the run
          // limit is enforced by the program, not by this HTTP timeout.
          signal: AbortSignal.timeout(Math.max(30_000, (limits?.wallTimeLimitSeconds ?? 5) * 1000 + 20_000)),
        });
      } catch (error) {
        throw new AppError(502, 'PROVIDER_UNAVAILABLE', `Could not reach Wandbox: ${error.message}`);
      }

      if (!response.ok) {
        throw new AppError(502, 'PROVIDER_ERROR', `Wandbox returned HTTP ${response.status}`);
      }

      const result = await response.json();
      const compileOutput = [result.compiler_error, result.compiler_output].filter(Boolean).join('\n').trim();
      // Wandbox signals a compile failure with an empty exit status.
      const compileFailed = compileOutput.length > 0 && String(result.status ?? '') === '';
      const signal = String(result.signal ?? '');

      let code = STATUS.ACCEPTED;
      if (compileFailed) code = STATUS.COMPILATION_ERROR;
      else if (signal) code = SIGNAL_STATUS[signal] ?? STATUS.RUNTIME_ERROR_OTHER;
      else if (String(result.status) !== '0') code = STATUS.RUNTIME_ERROR_NZEC;

      return {
        provider: 'wandbox',
        token: null,
        status: { id: null, code, description: compileFailed ? 'Compilation Error' : signal || `exit ${result.status ?? '?'}` },
        stdout: result.program_output ?? '',
        stderr: result.program_error ?? '',
        compileOutput,
        message: result.program_message ?? '',
        // Wandbox does not report resource usage; null is honest, zero is not.
        timeMs: null,
        memoryKb: null,
      };
    },

    async ping() {
      const response = await fetch(`${baseUrl}/api/list.json`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new AppError(502, 'PROVIDER_ERROR', `Wandbox returned HTTP ${response.status}`);
      const list = await response.json();
      const available = list.some((entry) => entry.name === config.WANDBOX_COMPILER);
      return { provider: 'wandbox', version: config.WANDBOX_COMPILER, compilerAvailable: available };
    },

    sanitizerFlags: ['-fsanitize=address', '-fsanitize=undefined'],
    statusCodes: STATUS,
  };
}
