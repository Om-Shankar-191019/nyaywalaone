import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { looksBinary, violatesShape } from '../../src/lib/guards.js';
import { clampLimitsFor } from '../../src/execution/limits.js';
import { looksLikeCompileError } from '../../src/execution/onlinecompiler.js';
import { capabilitiesOf } from '../../src/execution/provider.js';
import { defaultsFor, zodToSchema } from '../../src/grading/schema.js';
import { registry } from '../../src/grading/registry.js';
import { submissionScopedKey } from '../../src/services/submission-service.js';
import { parseBulkTests, diffRules, weightProblem } from '../../../frontend/src/lib/rules.js';

describe('onlinecompiler exit-code mapping', () => {
  it('recognises a compiler diagnostic and not a program that prints "error:"', () => {
    assert.equal(looksLikeCompileError("code.c: In function 'main':\ncode.c:3:5: error: expected ';'"), true);
    assert.equal(looksLikeCompileError('error: could not open file'), false);
    assert.equal(looksLikeCompileError(''), false);
  });

  it('declares that it cannot take compiler flags', () => {
    const caps = capabilitiesOf('onlinecompiler');
    assert.equal(caps.compilerFlags, false);
    assert.equal(caps.memoryLimit, false);
    assert.equal(caps.maxTimeLimitSeconds, 30);
  });
});

describe('clampLimitsFor', () => {
  it('caps the wall clock at the provider ceiling and says what was applied', () => {
    const limits = clampLimitsFor(capabilitiesOf('onlinecompiler'), { wallTimeLimitSeconds: 120, memoryLimitKb: 8192 });
    assert.equal(limits.wallTimeLimitSeconds, 30);
    assert.equal(limits.applied.memory_limit_enforced, false);
    assert.equal(limits.applied.memory_limit_kb, null);
  });

  it('leaves a Judge0-style provider with its full feature set', () => {
    const limits = clampLimitsFor({ compilerFlags: true, cpuTimeLimit: true, memoryLimit: true, processLimit: true, perRunTimeLimit: true, maxTimeLimitSeconds: 20 }, { wallTimeLimitSeconds: 5 });
    assert.equal(limits.wallTimeLimitSeconds, 5);
    assert.equal(limits.applied.memory_limit_enforced, true);
  });
});

describe('zodToSchema', () => {
  it('converts every analyzer parameter schema without throwing', () => {
    for (const analyzer of registry.all()) {
      const schema = zodToSchema(analyzer.paramsSchema);
      assert.equal(schema.type, 'object');
      assert.ok(schema.properties, `${analyzer.name} produced no properties`);
    }
  });

  it('carries bounds, defaults and enums across the wire', () => {
    const schema = zodToSchema(registry.get('edge_case_runner').paramsSchema);
    assert.equal(schema.properties.no_oracle_cap.type, 'number');
    assert.equal(schema.properties.no_oracle_cap.minimum, 0);
    assert.equal(schema.properties.no_oracle_cap.maximum, 1);
    assert.equal(schema.properties.dedupe_tests.type, 'boolean');
    assert.ok(schema.properties.cases.items.enum.includes('int_overflow'));
  });

  it('extracts usable defaults', () => {
    const defaults = defaultsFor(registry.get('similarity_flag').paramsSchema);
    assert.equal(defaults.shingle_size, 7);
    assert.equal(defaults.num_perm, 128);
  });
});

describe('request shape guard', () => {
  it('accepts a realistic rule set', () => {
    const rules = { metrics: [{ name: 'a', weight: 1, params: { cases: ['zero', 'negatives'] } }] };
    assert.equal(violatesShape(rules), null);
  });

  it('rejects a deeply nested body', () => {
    let nested = {};
    let cursor = nested;
    for (let index = 0; index < 20; index += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
    assert.match(violatesShape(nested), /nesting deeper/);
  });

  it('rejects an absurd array', () => {
    assert.match(violatesShape({ metrics: new Array(500).fill({ name: 'x' }) }), /array longer/);
  });
});

describe('binary detection', () => {
  it('accepts ordinary C source', () => {
    assert.equal(looksBinary('#include <stdio.h>\nint main(void){return 0;}\n'), false);
  });

  it('rejects a null byte and a control-character soup', () => {
    assert.equal(looksBinary('int main\u0000(void)'), true);
    assert.equal(looksBinary('\u0001'.repeat(24) + 'x'), true);
  });
});

describe('evaluation keys for duplicate submissions', () => {
  it('salts the key per submission so a resubmission owns its own report', () => {
    const base = 'a'.repeat(64);
    const first = submissionScopedKey(base, '11111111-1111-4111-8111-111111111111');
    const second = submissionScopedKey(base, '22222222-2222-4222-8222-222222222222');
    assert.notEqual(first, second);
    assert.equal(first.length, 64);
    // Same inputs, same key: the property a regrade relies on.
    assert.equal(first, submissionScopedKey(base, '11111111-1111-4111-8111-111111111111'));
  });
});

describe('rules helpers shared with the editor', () => {
  it('flags weights that do not sum to 1.00', () => {
    assert.equal(weightProblem([{ weight: 0.5 }, { weight: 0.5 }]), null);
    assert.match(weightProblem([{ weight: 0.5 }, { weight: 0.4 }]).message, /sum to 0.90/);
  });

  it('names each change between two rule sets', () => {
    const before = { problem: 'p', on_unavailable: 'renormalize', limits: { time_limit_s: 1 }, metrics: [{ name: 'a', analyzer: 'io_tests', weight: 0.5, params: {} }] };
    const after = { ...before, on_unavailable: 'zero', limits: { time_limit_s: 2 }, metrics: [{ name: 'a', analyzer: 'io_tests', weight: 0.6, params: {} }] };
    const labels = diffRules(before, after).map((change) => change.label);
    assert.ok(labels.includes('a weight'));
    assert.ok(labels.includes('unavailable metrics'));
    assert.ok(labels.includes('limit · time_limit_s'));
  });

  it('parses input|||expected pairs and reports bad lines', () => {
    const { rows, problems } = parseBulkTests('# heading\n40 2|||42\\n\nnonsense line\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stdin, '40 2');
    assert.equal(rows[0].expectedStdout, '42\n');
    assert.equal(problems.length, 1);
  });
});
