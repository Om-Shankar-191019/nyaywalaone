import { z } from 'zod';
import { chatJson } from '../llm/client.js';
import { codeSummary, copySignals, heuristicReview, likelihoodFrom } from '../llm/heuristics.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(1).default(0),
    max_source_chars: z.number().int().min(500).max(20_000).default(6000),
    review_threshold: z.number().min(0.3).max(0.95).default(0.6),
  })
  .strict();

const SYSTEM = [
  'You are an academic-integrity assistant reviewing a first-year C submission.',
  'Estimate two things separately and conservatively:',
  '1) the likelihood the code was produced by a language model rather than typed by a student;',
  '2) the likelihood it was copied from a tutorial, a question-and-answer site or another public source.',
  'Base this only on textual evidence: comment voice, variable naming, structure, defensive code, phrasing, formatting.',
  'A competent student can look polished, so low confidence is the correct answer when unsure.',
  'Return JSON only:',
  '{"ai_generated": {"likelihood": 0-1, "reason": "<one sentence>"}, "copied": {"likelihood": 0-1, "reason": "<one sentence>"}, "indicators": ["..."], "confidence": 0-1}',
  'At most 4 indicators, each under 20 words. Never accuse anyone; describe evidence.',
].join(' ');

const clampLikelihood = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  // Accept both 0-1 and 0-100 answers.
  return clamp01(number > 1 ? number / 100 : number);
};

/**
 * Originality beyond the peer corpus.
 *
 * `similarity_flag` compares this file with the other submissions in the same
 * assignment, which catches one student copying another. It cannot catch code
 * pasted from a chat window or a tutorial, because there is no local file to
 * compare against. This analyzer covers that gap with two independent parts:
 *
 * - deterministic signals that cost nothing and always run (fences, assistant
 *   phrasing, textbook comments, smart punctuation, mixed naming conventions);
 * - a model's reading of style and voice.
 *
 * It reports `review_recommended`, never "plagiarised". The evidence keeps the
 * matched snippets and the reasons so an instructor can decide in seconds, and
 * the score is advisory: the shipped rule sets give it weight 0.
 */
export const llmPlagiarismAnalyzer = {
  name: 'llm_plagiarism',
  supports: ['source'],
  needsMetrics: true,
  // Text-only, so a file that does not compile can still be reviewed for it.
  runsWithoutBinary: true,
  paramsSchema,

  async run(ctx, params) {
    const source = String(ctx.source ?? '').slice(0, params.max_source_chars);
    const heuristics = heuristicReview(source);

    const peer = (ctx.metrics ?? []).find((metric) => metric.analyzer === 'similarity_flag');
    const topMatch = peer?.evidence?.top_matches?.[0] ?? null;

    const user = [
      'Submission:',
      '```c',
      source,
      '```',
      '',
      `Peer comparison already run by the engine: ${peer ? `top similarity ${Math.round(Number(peer.evidence?.max_similarity ?? 0) * 100)}%` : 'not available'}.`,
      `Deterministic signals already found: ${JSON.stringify(heuristics.signals.map((signal) => signal.id))}.`,
      `Size: ${JSON.stringify(codeSummary(source))}`,
    ].join('\n');

    const result = await chatJson({
      purpose: 'llm_plagiarism',
      system: SYSTEM,
      user,
      temperature: params.temperature,
      maxTokens: 600,
    });

    const llmOnly = !result.ok;
    const llmAi = result.ok ? clampLikelihood(result.json?.ai_generated?.likelihood) : 0;
    const llmCopy = result.ok ? clampLikelihood(result.json?.copied?.likelihood) : 0;

    // The heuristic part is deterministic and always present; the model part is
    // a second opinion and is discounted 15%, because a confident model is the
    // easiest thing to be wrong about. Taking the maximum means either kind of
    // evidence can raise a flag, and neither can talk the other down.
    const MODEL_DISCOUNT = 0.85;
    const aiLikelihood = round3(llmOnly ? heuristics.ai_likelihood : Math.max(heuristics.ai_likelihood, llmAi * MODEL_DISCOUNT));
    const copyLikelihood = round3(llmOnly ? heuristics.copy_likelihood : Math.max(heuristics.copy_likelihood, llmCopy * MODEL_DISCOUNT));
    const peerLikelihood = clamp01(Number(peer?.evidence?.max_similarity ?? 0));
    const combined = round3(Math.max(aiLikelihood, copyLikelihood, peerLikelihood));

    const indicators = [];
    for (const signal of [...heuristics.signals].sort((a, b) => b.weight - a.weight).slice(0, 4)) {
      indicators.push(signal.label);
    }
    if (result.ok) {
      for (const item of Array.isArray(result.json?.indicators) ? result.json.indicators : []) {
        const text = String(item ?? '').slice(0, 200);
        if (text && !indicators.includes(text)) indicators.push(text);
      }
    }

    const verdict =
      combined >= 0.8 ? 'strong_signal' : combined >= params.review_threshold ? 'review_recommended' : combined >= 0.35 ? 'inconclusive' : 'likely_original';

    return {
      score: round3(clamp01(1 - combined)),
      status: llmOnly ? 'partial' : 'ok',
      evidence: {
        verdict,
        ai_likelihood: aiLikelihood,
        copy_likelihood: copyLikelihood,
        peer_similarity: round3(peerLikelihood),
        combined: combined,
        threshold: params.review_threshold,
        indicators: indicators.slice(0, 8),
        heuristic_signals: heuristics.signals,
        heuristic_likelihood: heuristics.ai_likelihood,
        llm: result.ok
          ? {
              used: true,
              ai_reason: String(result.json?.ai_generated?.reason ?? '').slice(0, 300),
              copy_reason: String(result.json?.copied?.reason ?? '').slice(0, 300),
              confidence: clampLikelihood(result.json?.confidence),
            }
          : { used: false, reason: result.code, detail: result.message },
        web_lookup: 'not_configured',
        // Saying so is cheaper than pretending: this is not a web search.
        note: 'No live internet search was performed. "Copied" means the style matches public tutorial code, not that a specific page was found. A flag is a reason to look, not a finding.',
        provider: result.provider ?? null,
        model: result.model ?? null,
        cached: result.cached ?? false,
      },
      feedback:
        verdict === 'likely_original'
          ? `No copy-paste signal above ${Math.round(params.review_threshold * 100)}% was found${llmOnly ? ' (deterministic checks only)' : ''}.`
          : `Integrity signal at ${Math.round(combined * 100)}%: ${indicators[0] ?? 'style differs from the rest of the class'}. Review recommended, not a conclusion.`,
    };
  },
};

export const __testing = { likelihoodFrom, copySignals };
