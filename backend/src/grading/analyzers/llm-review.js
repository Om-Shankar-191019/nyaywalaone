import { z } from 'zod';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { sha256Hex, stableStringify } from '../canonical-utils.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    model: z.string().min(1).max(120).default('llama-3.3-70b-versatile'),
    temperature: z.number().min(0).max(1).default(0),
    seed: z.number().int().min(0).max(1_000_000).default(42),
    advisory_only: z.boolean().default(true),
    max_source_chars: z.number().int().min(500).max(20_000).default(6000),
  })
  .strict();

const SYSTEM = [
  'You are a C programming tutor grading a first-year assignment.',
  'Return JSON only: {"score": <0-10 integer>, "feedback": "<at most 80 words>"}.',
  'Judge readability and clarity only. Do not guess the assignment or invent requirements.',
  'No student name, id or email is present; do not ask for one.',
].join(' ');

const parseResponse = (content) => {
  const text = String(content ?? '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

/**
 * Optional LLM feedback. Off the scoring path by default (weight 0.00), run at
 * temperature 0 with a fixed seed, and cached by prompt hash so a re-grade
 * returns the same prose. Without a key the metric is `unavailable` and the
 * rule set's policy applies - it is never a silent zero.
 */
export const llmReviewAnalyzer = {
  name: 'llm_review',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    if (!config.GROQ_API_KEY) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: 'GROQ_API_KEY is not set', model: params.model },
        feedback: 'The optional language-model review is not configured on this server.',
      };
    }

    const source = String(ctx.source).slice(0, params.max_source_chars);
    const prompt = `${SYSTEM}\n\nRules of engagement: judge clarity, naming and comments. Return JSON only.\n\n--- source ---\n${source}`;
    const promptHash = sha256Hex(prompt);
    const paramsHash = sha256Hex(stableStringify({ model: params.model, temperature: params.temperature, seed: params.seed }));

    const cached = await prisma.llmCache.findUnique({ where: { promptHash } });
    if (cached) {
      const parsed = cached.response;
      return {
        score: round3(clamp01((parsed.score ?? 0) / 10)),
        status: 'ok',
        evidence: { model: params.model, cached: true, score_out_of_10: parsed.score ?? null },
        feedback: parsed.feedback ?? 'No feedback returned.',
      };
    }

    let response;
    try {
      response = await fetch(`${config.GROQ_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: params.model,
          temperature: params.temperature,
          seed: params.seed,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return {
        score: 0,
        status: 'error',
        evidence: { reason: `request failed: ${error.message}`, model: params.model },
        feedback: 'The optional review could not be reached; the rest of the report is unaffected.',
      };
    }

    if (!response.ok) {
      return {
        score: 0,
        status: 'error',
        evidence: { reason: `HTTP ${response.status}`, model: params.model },
        feedback: 'The optional review was rejected by the provider; the rest of the report is unaffected.',
      };
    }

    const payload = await response.json();
    const parsed = parseResponse(payload?.choices?.[0]?.message?.content);
    if (!parsed) {
      return {
        score: 0,
        status: 'error',
        evidence: { reason: 'unparseable_response', model: params.model },
        feedback: 'The optional review returned something that was not JSON, so it was ignored.',
      };
    }

    const stored = { score: Number(parsed.score) || 0, feedback: String(parsed.feedback ?? '').slice(0, 600) };
    await prisma.llmCache.upsert({ where: { promptHash }, create: { promptHash, model: params.model, paramsHash, response: stored }, update: {} }).catch(() => {});

    return {
      score: round3(clamp01(stored.score / 10)),
      status: 'ok',
      evidence: { model: params.model, cached: false, score_out_of_10: stored.score, advisory_only: params.advisory_only },
      feedback: stored.feedback || 'No feedback returned.',
    };
  },
};
