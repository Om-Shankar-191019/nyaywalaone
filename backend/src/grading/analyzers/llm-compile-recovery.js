import { z } from 'zod';
import { chatJson } from '../llm/client.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(1).default(0),
    max_source_chars: z.number().int().min(500).max(20_000).default(6000),
    // The ceiling for marks awarded without a single successful run. A compiler
    // error means nothing was executed, so most of the grade must still be lost.
    max_credit: z.number().min(0.05).max(0.6).default(0.4),
    show_corrected_source: z.boolean().default(true),
    require_logic_correct: z.boolean().default(true),
  })
  .strict();

const SYSTEM = [
  'A first-year C program failed to compile. You are reading it for a human marker.',
  'Do two things: explain each compiler error in plain language, and judge whether the *intended* logic is correct.',
  'Judge logic only from what the code is clearly trying to do. If the intent is ambiguous, say so and set confidence low.',
  'Never claim the program has been run: it has not.',
  'Return JSON only:',
  '{"logic_sound": true|false, "confidence": 0-1, "summary": "<2 sentences for the student>", "errors": [{"message": "<compiler line>", "explanation": "<plain language, one sentence>"}], "corrected_source": "<the whole program with the compile errors fixed, or null>"}',
  'At most 5 errors. Keep corrected_source faithful - fix only what stops it compiling.',
].join(' ');

/**
 * Marks for a program that never ran.
 *
 * A typo (`printf` without its semicolon), a missing `#include`, a misspelled
 * variable name: the logic can be complete and correct while the compiler still
 * refuses the file. Today every metric except syntax becomes `unavailable` and
 * the grade is 0, which is defensible but unhelpful.
 *
 * This analyzer reads the source and the compiler output, explains the errors,
 * offers a corrected file, and - only when the logic looks sound - produces a
 * credit fraction. The coordinator turns that into marks capped by
 * `max_credit` (40% by default), reports it separately, and adds a limitation
 * saying where those marks came from. Nothing is executed, so nothing is
 * claimed to have been executed.
 */
export const llmCompileRecoveryAnalyzer = {
  name: 'llm_compile_recovery',
  supports: ['source'],
  onCompileFailure: true,
  paramsSchema,

  async run(ctx, params) {
    const source = String(ctx.source ?? '').slice(0, params.max_source_chars);
    const compilerOutput = String(ctx.compileOutput ?? '').slice(0, 4000);

    const user = [
      'The compiler said:',
      '```',
      compilerOutput.trim() || '(the sandbox reported a compilation error without diagnostics)',
      '```',
      '',
      'The program:',
      '```c',
      source,
      '```',
    ].join('\n');

    const result = await chatJson({
      purpose: 'llm_compile_recovery',
      system: SYSTEM,
      user,
      temperature: params.temperature,
      maxTokens: 1400,
    });

    if (!result.ok) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: result.code, detail: result.message, provider: result.provider ?? null },
        feedback: 'The compile errors could not be explained, and no recovery marks were considered.',
      };
    }

    const logicSound = Boolean(result.json?.logic_sound);
    const confidence = clamp01(Number(result.json?.confidence ?? 0));
    const eligible = logicSound && (!params.require_logic_correct || logicSound);
    const credit = eligible ? round3(clamp01(confidence)) : 0;

    const errors = (Array.isArray(result.json?.errors) ? result.json.errors : [])
      .slice(0, 5)
      .map((error) => ({
        message: String(error?.message ?? '').slice(0, 240),
        explanation: String(error?.explanation ?? '').slice(0, 300),
      }))
      .filter((error) => error.message || error.explanation);

    const corrected =
      params.show_corrected_source && typeof result.json?.corrected_source === 'string'
        ? result.json.corrected_source.slice(0, 8000)
        : null;

    return {
      score: credit,
      status: 'ok',
      evidence: {
        logic_sound: logicSound,
        eligible,
        confidence: Math.round(confidence * 1000) / 1000,
        credit_fraction: credit,
        max_credit: params.max_credit,
        awarded_hundredths: Math.round(credit * params.max_credit * 10_000),
        summary: String(result.json?.summary ?? '').slice(0, 600),
        errors,
        corrected_source: corrected,
        provider: result.provider,
        model: result.model,
        cached: result.cached,
      },
      feedback: logicSound
        ? `Logic looks sound (confidence ${Math.round(confidence * 100)}%); the program fails only to compile. Up to ${Math.round(params.max_credit * 100)} marks were considered for its logic.`
        : `Logic also looks incomplete, so no recovery marks were awarded. ${String(result.json?.summary ?? '').slice(0, 200)}`.trim(),
    };
  },
};
