import { z } from 'zod';
import { chatJson } from '../llm/client.js';
import { codeSummary } from '../llm/heuristics.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(1).default(0),
    max_source_chars: z.number().int().min(500).max(20_000).default(6000),
    strictness: z.enum(['light', 'normal', 'strict']).default('normal'),
  })
  .strict();

const SYSTEM = [
  'You are reviewing C code for readability, the way an experienced teaching assistant would.',
  'Judge only what is on the page: naming, formatting and style, comments, layout and structure, and how errors are handled.',
  'Never reward or punish behaviour or correctness; those are measured by tests elsewhere.',
  'Score each criterion from 0 to 10 where 5 is "a first-year student doing fine" and 10 is "publication quality".',
  'Return JSON only:',
  '{"criteria": {"naming": {"score": 0-10, "note": "<one sentence>"}, "formatting": {...}, "comments": {...}, "structure": {...}, "error_handling": {...}}, "score": 0-10, "top_issues": ["...", "..."]}',
  'Be concrete: name the identifier or the line. At most 4 top_issues, each under 22 words.',
].join(' ');

const CRITERIA = ['naming', 'formatting', 'comments', 'structure', 'error_handling'];

const STRICTNESS_HINT = {
  light: 'Be generous; this is an early attempt and only clear problems should cost points.',
  normal: 'Apply the standard expected of a first-year student at the end of the course.',
  strict: 'Apply a professional code-review standard.',
};

/**
 * Readability as a rubric, not a vibe.
 *
 * `style_analysis` already measures the countable parts (identifier length,
 * comment ratio, line length, indentation). This metric answers the part that
 * cannot be counted: are the names *intentional*, is the layout *consistent*,
 * does the comment say why rather than what. Advisory by default: it can be
 * given a weight in a rule set, but the shipped rule sets keep it at 0.
 */
export const llmStyleAnalyzer = {
  name: 'llm_style_review',
  supports: ['source'],
  // Reads only the source, so it still works when the file does not compile.
  runsWithoutBinary: true,
  paramsSchema,

  async run(ctx, params) {
    const source = String(ctx.source ?? '').slice(0, params.max_source_chars);
    const user = [
      STRICTNESS_HINT[params.strictness],
      `Measured facts: ${JSON.stringify(codeSummary(source))}`,
      '',
      '```c',
      source,
      '```',
    ].join('\n');

    const result = await chatJson({
      purpose: 'llm_style_review',
      system: SYSTEM,
      user,
      temperature: params.temperature,
      maxTokens: 800,
    });

    if (!result.ok) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: result.code, detail: result.message, provider: result.provider ?? null },
        feedback: 'The detailed readability review did not run; the measured readability metric above still applies.',
      };
    }

    const criteria = {};
    for (const name of CRITERIA) {
      const entry = result.json?.criteria?.[name];
      const value = typeof entry === 'number' ? entry : Number(entry?.score);
      criteria[name] = {
        score: Number.isFinite(value) ? Math.max(0, Math.min(10, Math.round(value * 10) / 10)) : null,
        note: String(entry?.note ?? '').slice(0, 240),
      };
    }

    const raw = Number(result.json?.score);
    const overall = Number.isFinite(raw)
      ? Math.max(0, Math.min(10, raw))
      : average(criteria);

    const issues = (Array.isArray(result.json?.top_issues) ? result.json.top_issues : [])
      .map((issue) => String(issue ?? '').slice(0, 240))
      .filter(Boolean)
      .slice(0, 4);

    return {
      score: round3(clamp01((overall ?? 0) / 10)),
      status: 'ok',
      evidence: {
        score_out_of_10: overall === null ? null : Math.round(overall * 10) / 10,
        criteria,
        top_issues: issues,
        strictness: params.strictness,
        provider: result.provider,
        model: result.model,
        cached: result.cached,
      },
      feedback: issues.length
        ? `Readability review: ${issues.join(' ')}`
        : `Readability review: ${Math.round((overall ?? 0) * 10) / 10} out of 10 with no blocking issues.`,
    };
  },
};

function average(criteria) {
  const scores = Object.values(criteria)
    .map((entry) => entry.score)
    .filter((score) => Number.isFinite(score));
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}
