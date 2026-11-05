import '../setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chatJson, extractJson, providerChain } from '../../src/grading/llm/client.js';
import { copySignals, heuristicReview } from '../../src/grading/llm/heuristics.js';
import { llmStyleAnalyzer } from '../../src/grading/analyzers/llm-style.js';
import { llmPlagiarismAnalyzer } from '../../src/grading/analyzers/llm-originality.js';
import { llmCompileRecoveryAnalyzer } from '../../src/grading/analyzers/llm-compile-recovery.js';
import { llmFeedbackAnalyzer } from '../../src/grading/analyzers/llm-feedback.js';
import { recoveryCreditFor } from '../../src/grading/coordinator.js';

/**
 * Everything here runs offline: `fetch` is replaced per test and the response
 * cache is skipped because NODE_ENV=test. No key, no database, no quota.
 */

const KEYS = [
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY',
  'LLM_ENABLED',
  'LLM_PROVIDER_ORDER',
  'OPENROUTER_MODEL',
  'OPENROUTER_BASE_URL',
];

const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

const clearKeys = () => {
  for (const key of KEYS) delete process.env[key];
};

const useOpenRouter = ({ model } = {}) => {
  clearKeys();
  process.env.LLM_ENABLED = 'true';
  process.env.LLM_PROVIDER_ORDER = 'openrouter';
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_BASE_URL = 'https://openrouter.test/v1';
  if (model) process.env.OPENROUTER_MODEL = model;
};

const reply = (payload, status = 200, headers = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });

const completion = (content) => reply({ model: 'test/model', choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] });

const withFetch = async (handler, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

const ctxFor = (source, extra = {}) => ({ source, sourceHash: 'a'.repeat(64), assignmentTitle: 'Add two integers', metrics: [], ...extra });

test.after(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test('without any key the client reports not_configured instead of throwing', async () => {
  clearKeys();
  process.env.LLM_ENABLED = 'true';
  assert.equal(providerChain().length, 0);

  const result = await chatJson({ purpose: 'test', system: 's', user: 'u' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_configured');
});

test('LLM_ENABLED=false reports disabled even when a key exists', async () => {
  useOpenRouter();
  process.env.LLM_ENABLED = 'false';
  const result = await chatJson({ purpose: 'test', system: 's', user: 'u' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'disabled');
});

test('JSON is recovered from fenced or chatty replies, including braces in strings', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":"}{"} — hope it helps'), { a: '}{' });
  assert.equal(extractJson('no json at all'), null);
});

test('a retired model name falls through to the next model on the same provider', async () => {
  // The exact production failure: 404 model_not_found made every report an error.
  useOpenRouter({ model: 'retired/model' });
  const seen = [];

  const result = await withFetch(
    async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.model);
      if (body.model === 'retired/model') {
        return reply({ error: { message: 'The model `retired/model` does not exist or you do not have access to it.' } }, 404);
      }
      return completion({ ok: true });
    },
    () => chatJson({ purpose: 'test', system: 's', user: 'u' }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.json.ok, true);
  assert.equal(seen[0], 'retired/model');
  assert.ok(seen.length >= 2, 'a second model must have been tried');
  assert.ok(result.attempts.some((attempt) => attempt.code === 'model_missing'));
});

test('a rate limit is retried once and then succeeds', async () => {
  useOpenRouter({ model: 'primary/model' });
  let calls = 0;

  const result = await withFetch(
    async () => {
      calls += 1;
      if (calls === 1) return reply({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' });
      return completion({ ok: true });
    },
    () => chatJson({ purpose: 'test', system: 's', user: 'u' }),
  );

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.ok(result.attempts.some((attempt) => attempt.code === 'rate_limited'));
});

test('every provider failing returns a reason, never an exception', async () => {
  useOpenRouter({ model: 'primary/model' });
  const result = await withFetch(
    async () => reply({ error: { message: 'upstream exploded' } }, 500),
    () => chatJson({ purpose: 'test', system: 's', user: 'u' }),
  );
  assert.equal(result.ok, false);
  assert.ok(['provider_unavailable', 'all_failed'].includes(result.code));
  assert.ok(result.message);
});

test('deterministic signals catch pasted chat output without any API', () => {
  const pasted = [
    'Here is the corrected code:',
    '```c',
    '#include <stdio.h>',
    '// Function to add two numbers',
    'int main() { return 0; }',
    '```',
    'I hope this helps!',
  ].join('\n');

  const signals = copySignals(pasted);
  assert.ok(signals.some((signal) => signal.id === 'markdown_fence'));
  assert.ok(signals.some((signal) => signal.id === 'assistant_prose'));
  assert.ok(signals.some((signal) => signal.id === 'tutorial_comments'));

  const review = heuristicReview(pasted);
  assert.ok(review.ai_likelihood > 0.6, `expected a high heuristic likelihood, got ${review.ai_likelihood}`);
});

test('plagiarism review falls back to heuristics and reports partial, not error', async () => {
  clearKeys();
  const result = await llmPlagiarismAnalyzer.run(ctxFor('```c\nint main(void){return 0;}\n```'), llmPlagiarismAnalyzer.paramsSchema.parse({}));
  assert.equal(result.status, 'partial');
  assert.ok(result.evidence.heuristic_signals.length > 0);
  assert.equal(result.evidence.web_lookup, 'not_configured');
});

test('plagiarism review combines the model opinion with the heuristic signals', async () => {
  useOpenRouter();
  const result = await withFetch(
    () =>
      completion({
        ai_generated: { likelihood: 0.92, reason: 'uniform style, no personal comments' },
        copied: { likelihood: 0.2, reason: 'nothing web-specific' },
        indicators: ['no comments at all', 'textbook variable names'],
        confidence: 0.7,
      }),
    () =>
      llmPlagiarismAnalyzer.run(
        ctxFor('/* average of three numbers */\n#include <stdio.h>\nint main(void){int a=1,b=2,c=3;printf("%d",(a+b+c)/3);return 0;}'),
        llmPlagiarismAnalyzer.paramsSchema.parse({}),
      ),
  );

  assert.equal(result.status, 'ok');
  assert.ok(result.evidence.ai_likelihood > 0.5, `ai likelihood was ${result.evidence.ai_likelihood}`);
  assert.equal(result.evidence.verdict, 'review_recommended');
  assert.ok(result.evidence.indicators.includes('no comments at all'));
});

test('readability review normalises the rubric out of 10', async () => {
  useOpenRouter();
  const result = await withFetch(
    () =>
      completion({
        criteria: {
          naming: { score: 8, note: 'clear names' },
          formatting: { score: 7, note: 'consistent braces' },
          comments: { score: 4, note: 'comments say what, not why' },
          structure: { score: 6, note: 'main does too much' },
          error_handling: { score: 5, note: 'scanf unchecked' },
        },
        score: 6,
        top_issues: ['main does too much', 'scanf result ignored'],
      }),
    () => llmStyleAnalyzer.run(ctxFor('int main(void){return 0;}'), llmStyleAnalyzer.paramsSchema.parse({})),
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.score, 0.6);
  assert.equal(result.evidence.criteria.naming.score, 8);
  assert.match(result.feedback, /main does too much/);
});

test('compile recovery awards a capped credit only when the logic looks sound', async () => {
  useOpenRouter();
  const params = llmCompileRecoveryAnalyzer.paramsSchema.parse({ max_credit: 0.2 });

  const sound = await withFetch(
    () =>
      completion({
        logic_sound: true,
        confidence: 0.9,
        summary: 'The arithmetic is right; a semicolon is missing.',
        errors: [{ message: "error: expected ';' before '}' token", explanation: 'A statement is missing its semicolon.' }],
        corrected_source: 'int main(void){return 0;}',
      }),
    () => llmCompileRecoveryAnalyzer.run({ ...ctxFor('int main(void){}'), compileOutput: "error: expected ';'" }, params),
  );

  assert.equal(sound.status, 'ok');
  assert.equal(sound.score, 0.9);
  assert.equal(sound.evidence.awarded_hundredths, 1800, '0.9 confidence of a 20% ceiling');
  assert.ok(sound.evidence.corrected_source);

  const credit = recoveryCreditFor({
    metrics: [{ analyzer: 'llm_compile_recovery', status: 'ok', score: sound.score, evidence: sound.evidence }],
    rules: { metrics: [{ analyzer: 'llm_compile_recovery', params }] },
  });
  assert.equal(credit.awarded_hundredths, 1800);
  assert.equal(credit.logic_sound, true);

  const unsound = await withFetch(
    () => completion({ logic_sound: false, confidence: 0.95, summary: 'The loop never terminates.', errors: [] }),
    () => llmCompileRecoveryAnalyzer.run({ ...ctxFor('int main(void){'), compileOutput: 'error' }, params),
  );
  assert.equal(unsound.score, 0);
  assert.equal(unsound.evidence.awarded_hundredths, 0);
});

test('no recovery metric in the rule set means no recovery credit at all', () => {
  assert.equal(recoveryCreditFor({ metrics: [], rules: { metrics: [] } }), null);
});

test('narrative feedback carries the metric digest and never scores', async () => {
  useOpenRouter();
  const metrics = [
    { name: 'correctness', analyzer: 'io_tests', weight: 0.2, score: 1, contribution: 2000, status: 'ok', feedback: 'All 3 tests passed.' },
    { name: 'readability', analyzer: 'style_analysis', weight: 0.1, score: 0.4, contribution: 400, status: 'ok', feedback: '91% of identifiers are one letter' },
  ];

  let sent = '';
  const result = await withFetch(
    (url, init) => {
      sent = init.body;
      return completion({ summary: 'Tests pass; naming needs work.', strengths: ['all tests pass'], improvements: ['use descriptive names'], next_steps: ['rename a, b, c'] });
    },
    () => llmFeedbackAnalyzer.run(ctxFor('int main(void){int a,b;scanf("%d%d",&a,&b);printf("%d",a+b);return 0;}', { metrics }), llmFeedbackAnalyzer.paramsSchema.parse({})),
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.score, 0, 'advice must never move a mark');
  assert.deepEqual(result.evidence.strengths, ['all tests pass']);
  assert.ok(sent.includes('readability'), 'the prompt must include the metric digest');
});
