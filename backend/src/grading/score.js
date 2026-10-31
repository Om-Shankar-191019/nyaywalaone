/** Small, shared scoring arithmetic. Pure functions, no clock, no randomness. */
export const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * 1.0 at or below `full`, 0.0 at or above `zero`, linear between. This is the
 * "piecewise linear against the rules' thresholds" formula from section 8.2,
 * written once so every analyzer agrees on what 9 decision points means.
 */
export function decayScore(value, full, zero = full * 2) {
  if (!Number.isFinite(value)) return 0;
  if (value <= full) return 1;
  if (value >= zero) return 0;
  return clamp01(1 - (value - full) / (zero - full));
}

/** Three decimals is enough for a score and keeps evidence readable. */
export const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * Integer hundredths of a percent: a full-mark metric contributes 10000, so a
 * grade is an integer from 0 to 10000 and 67.35% is stored as 6735. No
 * floating-point accumulation reaches the final grade.
 */
export const contributionOf = (score, weight) => Math.round(clamp01(score) * weight * 10_000);

export function formatPercent(score) {
  return `${Math.round(clamp01(score) * 100)}%`;
}
