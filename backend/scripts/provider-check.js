#!/usr/bin/env node
/**
 * Verifies the configured execution sandbox end to end, using the same adapter
 * the grader uses. Run it after pasting a key into `.env`:
 *
 *   npm run exec:check
 *
 * It prints only the API's answers. The key is never echoed, so this is safe to
 * paste into a bug report.
 */
import { config } from '../src/config.js';
import { createOnlineCompilerProvider } from '../src/execution/onlinecompiler.js';
import { capabilitiesOf } from '../src/execution/provider.js';
import { STATUS } from '../src/execution/status.js';

const provider = createOnlineCompilerProvider();
const caps = capabilitiesOf('onlinecompiler');

const cases = [
  {
    name: 'accepted',
    expect: STATUS.ACCEPTED,
    source: '#include <stdio.h>\nint main(void){int a,b;if(scanf("%d %d",&a,&b)!=2)return 3;printf("%d\\n",a+b);return 0;}',
    stdin: '40 2',
    wantStdout: '42\n',
  },
  {
    name: 'compile_error',
    expect: STATUS.COMPILATION_ERROR,
    source: 'int main(void){ return 0 }',
    stdin: '',
  },
  {
    name: 'segfault',
    expect: STATUS.RUNTIME_ERROR_SIGSEGV,
    source: 'int main(void){ int *p = (int*)0; *p = 1; return 0; }',
    stdin: '',
  },
  {
    name: 'timeout',
    expect: STATUS.TIME_LIMIT_EXCEEDED,
    source: 'int main(void){ volatile unsigned long x = 0; for(;;) { x++; } return 0; }',
    stdin: '',
  },
];

const log = (label, value) => console.log(`  ${label.padEnd(12)} ${value}`);

console.log(`\nProvider      ${config.EXECUTION_PROVIDER}`);
console.log(`Base URL      ${config.ONLINECOMPILER_BASE_URL}`);
console.log(`Compiler      ${config.ONLINECOMPILER_COMPILER}`);
console.log(`Key present   ${config.ONLINECOMPILER_API_KEY ? `yes (${config.ONLINECOMPILER_API_KEY.length} chars)` : 'NO - set ONLINECOMPILER_API_KEY or JUDGE0_API_KEY'}`);
console.log(`Capabilities  ${JSON.stringify(caps)}\n`);

if (!config.ONLINECOMPILER_API_KEY) {
  console.error('No API key configured. Nothing to test.');
  process.exit(2);
}

try {
  const ping = await provider.ping();
  console.log(`ping -> ${ping.provider} ${ping.version} (${ping.compiler})\n`);
} catch (error) {
  console.error(`ping FAILED: ${error.message}`);
  console.error('Fix the credential before grading: every submission needs this endpoint.');
  process.exit(1);
}

let failures = 0;

for (const testCase of cases) {
  process.stdout.write(`${testCase.name}\n`);
  try {
    const result = await provider.run({ source: testCase.source, stdin: testCase.stdin, limits: { wallTimeLimitSeconds: 6 } });
    log('status', result.status.code);
    log('exit_code', result.status.id);
    log('time', `${result.timeMs ?? '?'} ms`);
    log('memory', `${result.memoryKb ?? '?'} KB`);
    if (result.stdout) log('stdout', JSON.stringify(result.stdout.slice(0, 60)));
    if (result.stderr) log('stderr', JSON.stringify(result.stderr.slice(0, 60)));
    if (result.compileOutput) log('compile', JSON.stringify(result.compileOutput.split('\n')[0].slice(0, 80)));

    const statusOk = result.status.code === testCase.expect;
    const stdoutOk = testCase.wantStdout === undefined || result.stdout === testCase.wantStdout;
    if (statusOk && stdoutOk) {
      console.log('  PASS\n');
    } else {
      failures += 1;
      console.log(`  FAIL  expected ${testCase.expect}${testCase.wantStdout !== undefined ? ` / ${JSON.stringify(testCase.wantStdout)}` : ''}\n`);
    }
  } catch (error) {
    failures += 1;
    console.log(`  ERROR ${error.code ?? ''} ${error.message}\n`);
    if (error.details) console.log(`        ${JSON.stringify(error.details)}\n`);
  }
  // Two runs are allowed at once and 30 per minute; stay well inside both.
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

if (failures) {
  console.log(`${failures} case(s) did not behave as expected.`);
  process.exit(1);
}
console.log('All cases behaved as expected.');
