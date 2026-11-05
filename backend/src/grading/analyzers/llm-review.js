import { z } from 'zod';
import { chatJson } from '../llm/client.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    // Optional on purpose: an empty value lets the client pick a model that the
    // account actually has. A dead model name in a rule set must not break a grade.
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(1).default(0),
    max_source_chars: z.number().int().min(500).max(20_000).default(6000),
    strictness: z.enum(['light', 'normal', 'strict']).default('normal'),
    // Kept so a stored rule set written before 2.1.0 still validates. It is
    // forwarded to providers that honour a seed; others ignore it.
    seed: z.number().int().min(0).max(1_000_000).default(42),
    advisory_only: z.boolean().default(true),
  })
  .strict();

const SYSTEM = [
  'You are a C programming tutor grading a first-year assignment.',
  'Return JSON only: {"score": <0-10 integer>, "feedback": "<at most 80 words>"}.',
  'Judge readability and clarity only. Do not guess the assignment or invent requirements.',
  'No student name, id or email is present; do not ask for one.',
].join(' ');

const STRICTNESS = {
  light: 'Be encouraging; this is an early attempt.',
  normal: 'Hold the standard of a first-year student at the end of the course.',
  strict: 'Hold a professional review standard.',
};

/**
 * The original advisory review, kept for rule sets that already name it.
 *
 * Two behaviour changes, both from a real failure: the model is optional (the
 * client walks a chain of models and providers instead of hard-coding one that
 * the account may no longer have), and a failed call is `unavailable`, never
 * `error`. `error` on a zero-weight advisory metric made every report look
 * broken when all that had happened was a retired model name.
 */
export const llmReviewAnalyzer = {
  name: 'llm_review',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const source = String(ctx.source ?? '').slice(0, params.max_source_chars);
    const user = [
      STRICTNESS[params.strictness],
      '',
      'Return JSON only.',
      '',
      '--- source ---',
      source,
    ].join('\n');

    const result = await chatJson({
      purpose: 'llm_review',
      system: SYSTEM,
      user,
      temperature: params.temperature,
      maxTokens: 400,
      seed: params.seed,
    });

    if (!result.ok) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: {
          reason: result.code,
          detail: result.message,
          provider: result.provider ?? null,
          attempts: Array.isArray(result.attempts) ? result.attempts.slice(0, 6) : [],
        },
        feedback:
          result.code === 'not_configured' || result.code === 'disabled'
            ? 'The optional language-model review is not configured on this server. The grade is unaffected.'
            : 'The optional language-model review could not be reached. The grade is unaffected.',
      };
    }

    const raw = Number(result.json?.score);
    const outOfTen = Number.isFinite(raw) ? Math.max(0, Math.min(10, raw)) : 0;
    const feedback = String(result.json?.feedback ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);

    return {
      score: round3(clamp01(outOfTen / 10)),
      status: 'ok',
      evidence: {
        model: result.model,
        provider: result.provider,
        cached: result.cached,
        score_out_of_10: outOfTen,
        advisory_only: params.advisory_only,
      },
      feedback: feedback || 'No feedback returned.',
    };
  },
};
