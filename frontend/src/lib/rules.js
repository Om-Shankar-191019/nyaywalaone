/**
 * Rule-set arithmetic and diffing, kept away from the components so the weight
 * guard and the "what changes" confirmation use the same numbers the server
 * will validate against.
 */

export const WEIGHT_EPSILON = 1e-9;

export function weightTotal(metrics = []) {
  return metrics.reduce((sum, metric) => sum + (Number.isFinite(metric?.weight) ? metric.weight : 0), 0);
}

/** The blocking condition the server enforces: weights must sum to exactly 1.00. */
export function weightProblem(metrics = []) {
  const total = weightTotal(metrics);
  if (Math.abs(total - 1) <= WEIGHT_EPSILON) return null;
  const delta = total - 1;
  return {
    total,
    message: `Weights sum to ${total.toFixed(2)}. They must sum to 1.00 - ${delta > 0 ? 'remove' : 'add'} ${Math.abs(delta).toFixed(2)}.`,
  };
}

const show = (value) => {
  if (value === undefined || value === null) return 'not set';
  if (typeof value === 'string') return value === '' ? 'empty' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What publishing this draft would change, in words an instructor can read back
 * to a class. Ordered as: metrics, then limits, then policy.
 */
export function diffRules(previous, next) {
  const changes = [];
  const before = previous ?? {};
  const after = next ?? {};

  const beforeMetrics = new Map((before.metrics ?? []).map((metric) => [metric.name, metric]));
  const afterMetrics = new Map((after.metrics ?? []).map((metric) => [metric.name, metric]));

  for (const [name, metric] of afterMetrics) {
    if (!beforeMetrics.has(name)) {
      changes.push({ label: `add metric "${name}"`, from: null, to: `${metric.weight} weight (${metric.analyzer})` });
    }
  }
  for (const [name] of beforeMetrics) {
    if (!afterMetrics.has(name)) changes.push({ label: `remove metric "${name}"`, from: name, to: null });
  }

  for (const [name, metric] of afterMetrics) {
    const old = beforeMetrics.get(name);
    if (!old) continue;

    if (old.weight !== metric.weight) {
      changes.push({ label: `${name} weight`, from: `${(old.weight * 100).toFixed(0)}%`, to: `${(metric.weight * 100).toFixed(0)}%` });
    }
    if (old.analyzer !== metric.analyzer) {
      changes.push({ label: `${name} analyzer`, from: old.analyzer, to: metric.analyzer });
    }

    const oldParams = old.params ?? {};
    const newParams = metric.params ?? {};
    for (const key of new Set([...Object.keys(oldParams), ...Object.keys(newParams)])) {
      if (!same(oldParams[key], newParams[key])) {
        changes.push({ label: `${name} · ${key}`, from: show(oldParams[key]), to: show(newParams[key]) });
      }
    }
  }

  if (before.on_unavailable !== after.on_unavailable) {
    changes.push({ label: 'unavailable metrics', from: show(before.on_unavailable), to: show(after.on_unavailable) });
  }
  if (before.problem !== after.problem) {
    changes.push({ label: 'problem name', from: show(before.problem), to: show(after.problem) });
  }
  for (const key of new Set([...Object.keys(before.limits ?? {}), ...Object.keys(after.limits ?? {})])) {
    if (!same(before.limits?.[key], after.limits?.[key])) {
      changes.push({ label: `limit · ${key}`, from: show(before.limits?.[key]), to: show(after.limits?.[key]) });
    }
  }

  return changes;
}

/**
 * `input|||output` pairs, one per line.
 *
 * The separator is `|||` because a real test case can contain commas, tabs and
 * newlines, and asking an instructor to paste a CSV of C inputs is a bug report
 * waiting to happen. Lines starting with `#` are comments so a pasted block can
 * keep its headings.
 */
export function parseBulkTests(text, { namePrefix = 'case' } = {}) {
  const rows = [];
  const problems = [];

  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const marker = line.indexOf('|||');
      if (marker === -1) {
        problems.push(`Line ${index + 1} has no "|||" separator, so it was skipped.`);
        return;
      }

      const stdin = line.slice(0, marker).replace(/\\n/g, '\n');
      const expectedStdout = line.slice(marker + 3).replace(/\\n/g, '\n');
      if (!stdin.trim() && !expectedStdout.trim()) {
        problems.push(`Line ${index + 1} is empty on both sides of the separator.`);
        return;
      }

      rows.push({ name: `${namePrefix} ${rows.length + 1}`.trim(), stdin, expectedStdout, isHidden: true });
    });

  return { rows, problems };
}

/** Mask passwords and keys before a rule set is echoed into a browser tab. */
export const redactRules = (rules) => JSON.parse(JSON.stringify(rules ?? {}));
