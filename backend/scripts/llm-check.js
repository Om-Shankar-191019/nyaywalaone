#!/usr/bin/env node
/**
 * Which language-model providers work from this machine, right now?
 *
 *   npm run llm:check
 *
 * Prints one line per provider (key present, `/models` reachable, chat answer)
 * and exits non-zero when nothing works. It never prints a key, and it spends at
 * most one tiny completion per provider, which is well inside every free tier.
 */
import 'dotenv/config';

const { providerChain, llmStatus, chatJson } = await import('../src/grading/llm/client.js');

const status = llmStatus();
console.log(`LLM enabled: ${status.enabled}`);
console.log(`Order: ${status.order.map((entry) => `${entry.name}${entry.has_key ? '' : ' (no key)'}`).join(' → ')}`);

if (!status.enabled) {
  console.log('\nLLM_ENABLED=false: every language-model metric will report `unavailable` and the grade is unaffected.');
  process.exit(0);
}

const chain = providerChain();
if (!chain.length) {
  console.log('\nNo key found. Set one of:');
  for (const entry of status.order) console.log(`  ${entry.name.padEnd(11)} ${entry.keys}`);
  console.log('\nWithout a key the grade is unaffected: LLM metrics report `unavailable`, not zero.');
  process.exit(1);
}

let working = 0;

for (const provider of chain) {
  const models = provider.models.slice(0, 4);
  console.log(`\n${provider.label} (${provider.name})  key …${provider.apiKey.slice(-4)}  ${provider.baseUrl}`);
  console.log(`  candidates: ${models.join(', ')}`);

  for (const model of models) {
    const started = Date.now();
    const result = await chatJson({
      purpose: 'llm_check',
      system: 'Return JSON only.',
      user: 'Reply with exactly {"ok": true} and nothing else.',
      maxTokens: 20,
      cache: false,
    });
    const ms = Date.now() - started;
    if (result.ok) {
      working += 1;
      console.log(`  OK   ${result.model ?? model}  ${ms} ms  (answered via ${result.provider})`);
      break;
    }
    const attempt = (result.attempts ?? []).find((entry) => entry.model === model);
    console.log(`  FAIL ${model}  ${attempt?.code ?? result.code}${attempt?.status ? ` HTTP ${attempt.status}` : ''}  ${String(attempt?.message ?? result.message).slice(0, 120)}`);
  }
}

console.log(`\n${working} provider(s) answered.`);
if (!working) {
  console.log('Nothing answered. The grading engine is unaffected: these metrics report `unavailable`.');
  console.log('A 404 model_not_found means the model name is retired for this key; set e.g. GROQ_MODEL to a model your account lists.');
}
process.exit(working ? 0 : 1);
