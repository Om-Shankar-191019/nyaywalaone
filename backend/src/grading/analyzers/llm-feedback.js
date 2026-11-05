import { z } from 'zod';
import { chatJson } from '../llm/client.js';
import { codeSummary } from '../llm/heuristics.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(1).default(0),
    max_source_chars: z.number().int().min(500).max(20_000).default(6000),
    max_metrics: z.number().int().min(3).max(30).default(14),
  })
  .strict();

const SYSTEM = [
  'You are a patient C programming tutor writing feedback for a first-year student.',
  'You are given the marks the engine already awarded, the evidence behind them, and the source.',
  'Write specific, kind, actionable feedback. Quote line numbers or identifiers where you can.',
  'Do not invent test results and do not contradict the marks: if a metric scores full marks, do not claim it is broken.',
  'Return JSON only, with exactly these keys:',
  '{"summary": "<2-3 sentences>", "strengths": ["..."], "improvements": ["..."], "next_steps": ["..."]}',
  'At most 3 items per list, each under 20 words.',
].join(' ');

/**
 * The narrative a student actually reads.
 *
 * It runs *after* the deterministic metrics, because its whole value is joining
 * them up: "your tests pass but 91% of identifiers are one letter" is a sentence
 * no single analyzer can write. It has weight 0 - advice must never move a mark -
 * and it is excluded from the report hash, because model prose is not
 * reproducible evidence.
 */
export const llmFeedbackAnalyzer = {
  name: 'llm_feedback',
  supports: ['source'],
  needsMetrics: true,
  paramsSchema,

  async run(ctx, params) {
    const digest = (ctx.metrics ?? []).slice(0, params.max_metrics).map((metric) => ({
      metric: metric.name,
      analyzer: metric.analyzer,
      score: round3(metric.score ?? 0),
      weight: metric.weight ?? 0,
      status: metric.status ?? 'ok',
      evidence: truncate(metric.feedback ?? '', 160),
    }));

    const grade = Math.round((ctx.metrics ?? []).reduce((sum, metric) => sum + (metric.contribution ?? 0), 0) / 100);
    const source = String(ctx.source ?? '').slice(0, params.max_source_chars);

    const user = [
      `Assignment: ${ctx.assignmentTitle ?? 'a C exercise'}`,
      `Current grade: ${grade} / 100 (from the metrics below).`,
      `Code size: ${JSON.stringify(codeSummary(source))}`,
      '',
      'Metrics:',
      JSON.stringify(digest, null, 2),
      '',
      'Source:',
      '```c',
      source,
      '```',
    ].join('\n');

    const result = await chatJson({
      purpose: 'llm_feedback',
      system: SYSTEM,
      user,
      temperature: params.temperature,
      maxTokens: 700,
      ...(params.model ? { model: params.model } : {}),
    });

    if (!result.ok) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: result.code, detail: result.message, provider: result.provider ?? null },
        feedback: 'The written feedback could not be generated, so the per-metric notes above are the complete feedback for this submission.',
      };
    }

    const strengths = asList(result.json.strengths);
    const improvements = asList(result.json.improvements);
    const nextSteps = asList(result.json.next_steps);
    const summary = truncate(result.json.summary, 700) || 'No summary was returned.';

    return {
      score: 0,
      status: 'ok',
      evidence: {
        summary,
        strengths,
        improvements,
        next_steps: nextSteps,
        provider: result.provider,
        model: result.model,
        cached: result.cached,
      },
      feedback: summary,
    };
  },
};

const asList = (value) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => truncate(typeof item === 'string' ? item : item?.text ?? JSON.stringify(item), 240))
    .filter(Boolean)
    .slice(0, 3);

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

export const __testing = { clamp01 };
