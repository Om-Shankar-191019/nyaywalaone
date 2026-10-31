#!/usr/bin/env node
/**
 * Day 6: prove the failure taxonomy end to end against the configured provider.
 *
 * This talks to the provider directly (no database, no API), so it is the first
 * thing to run after the campaign that decides whether grading can exist.
 * It costs about eight provider calls.
 *
 *   npm run exec:taxonomy
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { DEFAULT_COMPILER_OPTIONS, resolveLimits } from '../src/execution/limits.js';
import { getProvider } from '../src/execution/provider.js';

const here = dirname(fileURLToPath(import.meta.url));

const CASES = [
  {
    name: 'accepted',
    note: 'hello world',
    source: '#include <stdio.h>\nint main(void){printf("hello\\n");return 0;}\n',
  },
  {
    name: 'compile_error',
    note: 'missing semicolon',
    source: '#include <stdio.h>\nint main(void){printf("hi")\nreturn 0;}\n',
  },
  {
    name: 'tle',
    note: 'infinite loop',
    source: 'int main(void){while(1){}return 0;}\n',
    limits: { cpuTimeLimitSeconds: 1, wallTimeLimitSeconds: 3 },
  },
  {
    name: 'sigsegv',
    note: 'null dereference',
    source: 'int main(void){int *p = (int*)0; *p = 1; return 0;}\n',
  },
  {
    name: 'sigfpe',
    note: 'integer division by zero',
    source: 'int main(void){volatile int zero = 0; return 1/zero;}\n',
  },
  {
    name: 'process_limit',
    note: 'while(1) fork()',
    source: '#include <unistd.h>\nint main(void){while(1){fork();}return 0;}\n',
    limits: { cpuTimeLimitSeconds: 1, wallTimeLimitSeconds: 3, maxProcesses: 30 },
  },
  {
    name: 'mle',
    note: 'touches 128 MB with a 64 MB limit',
    source:
      '#include <stdlib.h>\n#include <string.h>\nint main(void){size_t n = 128u*1024u*1024u; char *p = malloc(n); if(!p) return 2; memset(p, 1, n); return p[0];}\n',
  },
  {
    name: 'asan_startup',
    note: 'AddressSanitizer attempt, expected to fail under the address-space limit',
    source: '#include <stdlib.h>\nint main(void){char *p = malloc(4); p[8] = 1; free(p); return 0;}\n',
    compilerOptions: `${DEFAULT_COMPILER_OPTIONS} -fsanitize=address -g`,
  },
];

const provider = getProvider(config.EXECUTION_PROVIDER);
const results = [];
let providerVersion = 'unknown';

try {
  const ping = await provider.ping();
  providerVersion = ping.version ?? 'unknown';
  console.log(`Provider: ${provider.name} ${providerVersion}\n`);
} catch (error) {
  console.log(`Provider ping failed (continuing): ${error.message}\n`);
}

for (const testCase of CASES) {
  const limits = resolveLimits(testCase.limits);
  const compilerOptions = testCase.compilerOptions ?? DEFAULT_COMPILER_OPTIONS;
  const startedAt = process.hrtime.bigint();

  try {
    const result = await provider.run({ source: testCase.source, stdin: '', compilerOptions, limits });
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    results.push({
      name: testCase.name,
      note: testCase.note,
      status: result.status,
      timeMs: result.timeMs,
      memoryKb: result.memoryKb,
      latencyMs: Math.round(latencyMs),
      compileOutput: result.compileOutput.slice(0, 300),
      stderr: result.stderr.slice(0, 300),
      stdout: result.stdout.slice(0, 100),
    });

    console.log(
      `${testCase.name.padEnd(16)} ${String(result.status.code).padEnd(24)} id=${String(result.status.id).padEnd(3)} ` +
        `cpu=${String(result.timeMs ?? '?').padStart(5)}ms mem=${String(result.memoryKb ?? '?').padStart(6)}KB ` +
        `roundtrip=${Math.round(latencyMs)}ms`,
    );
  } catch (error) {
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    results.push({ name: testCase.name, note: testCase.note, error: error.message, latencyMs: Math.round(latencyMs) });
    console.log(`${testCase.name.padEnd(16)} ERROR ${error.message}`);
  }
}

const outputPath = resolve(here, '../../docs/execution-metrics.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    { capturedAt: new Date().toISOString(), provider: provider.name, providerVersion, compilerOptions: DEFAULT_COMPILER_OPTIONS, results },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`\nWritten to ${outputPath}`);
