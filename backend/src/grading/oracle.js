import { normalizeOutput } from './canonical.js';
import { sha256Hex, stableStringify } from './canonical-utils.js';
import { runCached } from '../execution/compile.js';
import { STATUS } from '../execution/status.js';

/**
 * The oracle. A generated input is worthless without an expected answer, so in
 * order of preference we use:
 *
 *   1. the instructor's reference program, run once per input and cached by
 *      `sha256(input + reference_hash)`;
 *   2. nothing - the case still detects a crash or a timeout, but no
 *      correctness claim is made and the metric is capped by `no_oracle_cap`.
 *
 * Property checks (commutativity, sum against a big-integer) belong here too,
 * but only where the problem's contract is known; claiming one generically
 * would be a lie.
 */
export async function oracleFor({ stdin, reference, referenceHash, compilerOptions, limits }) {
  if (!reference) return { oracle: 'none', expected: null };

  const run = await runCached({
    kind: 'oracle',
    source: reference,
    sourceHash: referenceHash ?? sha256Hex(reference),
    stdin,
    compilerOptions,
    limits,
  });

  if (run.status.code !== STATUS.ACCEPTED) {
    return { oracle: 'reference_failed', expected: null, reason: run.status.code };
  }
  return { oracle: 'reference', expected: normalizeOutput(run.stdout) };
}

export const oracleCacheKey = (stdin, referenceHash) => sha256Hex(stableStringify({ stdin, referenceHash }));
