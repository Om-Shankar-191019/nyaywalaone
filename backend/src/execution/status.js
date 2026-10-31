/**
 * One vocabulary for both providers. Judge0's numeric ids are stable; its
 * human-readable descriptions are not, so nothing downstream ever reads them.
 */
export const STATUS = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  WRONG_ANSWER: 'WRONG_ANSWER',
  TIME_LIMIT_EXCEEDED: 'TIME_LIMIT_EXCEEDED',
  COMPILATION_ERROR: 'COMPILATION_ERROR',
  RUNTIME_ERROR_SIGSEGV: 'RUNTIME_ERROR_SIGSEGV',
  RUNTIME_ERROR_SIGFPE: 'RUNTIME_ERROR_SIGFPE',
  RUNTIME_ERROR_SIGABRT: 'RUNTIME_ERROR_SIGABRT',
  RUNTIME_ERROR_SIGXFSZ: 'RUNTIME_ERROR_SIGXFSZ',
  RUNTIME_ERROR_NZEC: 'RUNTIME_ERROR_NZEC',
  RUNTIME_ERROR_OTHER: 'RUNTIME_ERROR_OTHER',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  EXEC_FORMAT_ERROR: 'EXEC_FORMAT_ERROR',
  PENDING: 'PENDING',
});

const JUDGE0_STATUS = {
  1: STATUS.PENDING,
  2: STATUS.PENDING,
  3: STATUS.ACCEPTED,
  4: STATUS.WRONG_ANSWER,
  5: STATUS.TIME_LIMIT_EXCEEDED,
  6: STATUS.COMPILATION_ERROR,
  7: STATUS.RUNTIME_ERROR_SIGSEGV,
  8: STATUS.RUNTIME_ERROR_SIGXFSZ,
  9: STATUS.RUNTIME_ERROR_SIGFPE,
  10: STATUS.RUNTIME_ERROR_SIGABRT,
  11: STATUS.RUNTIME_ERROR_NZEC,
  12: STATUS.RUNTIME_ERROR_OTHER,
  13: STATUS.INTERNAL_ERROR,
  14: STATUS.EXEC_FORMAT_ERROR,
};

const JUDGE0_DESCRIPTION = {
  1: 'In Queue',
  2: 'Processing',
  3: 'Accepted',
  4: 'Wrong Answer',
  5: 'Time Limit Exceeded',
  6: 'Compilation Error',
  7: 'Runtime Error (SIGSEGV)',
  8: 'Runtime Error (SIGXFSZ)',
  9: 'Runtime Error (SIGFPE)',
  10: 'Runtime Error (SIGABRT)',
  11: 'Runtime Error (NZEC)',
  12: 'Runtime Error (Other)',
  13: 'Internal Error',
  14: 'Exec Format Error',
};

export function mapJudge0Status(id) {
  return {
    id: Number(id),
    code: JUDGE0_STATUS[id] ?? STATUS.RUNTIME_ERROR_OTHER,
    description: JUDGE0_DESCRIPTION[id] ?? 'Unknown status',
  };
}

export const isPending = (status) => status.code === STATUS.PENDING;


export const isTerminal = (status) => !isPending(status);

/** Signals that mean "the program crashed", as opposed to "the program lied". */
export const isRuntimeError = (code) => typeof code === 'string' && code.startsWith('RUNTIME_ERROR');

/**
 * Day 6 finding: ce.judge0.com 1.14.0 collapses SIGSEGV and SIGFPE into
 * `Runtime Error (NZEC)`, id 11. The signal is still visible in stderr, where
 * the shell that launched the binary says so. This is a best-effort *detail*
 * for the report - `status.code` stays exactly what the provider said, and no
 * score depends on this.
 */
const STDERR_SIGNATURES = [
  [/Segmentation fault/i, 'SIGSEGV'],
  [/Floating point exception/i, 'SIGFPE'],
  [/Aborted/i, 'SIGABRT'],
  [/Killed/i, 'SIGKILL'],
];

export function classifyRuntimeDetail({ code, stderr }) {
  if (!isRuntimeError(code) && code !== STATUS.RUNTIME_ERROR_NZEC) return null;
  const text = String(stderr ?? '');
  for (const [pattern, detail] of STDERR_SIGNATURES) {
    if (pattern.test(text)) return detail;
  }
  return null;
}
