import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyRuntimeDetail, isPending, isRuntimeError, mapJudge0Status, STATUS } from '../../src/execution/status.js';

describe('mapJudge0Status', () => {
  it('maps the statuses the taxonomy depends on', () => {
    assert.equal(mapJudge0Status(3).code, STATUS.ACCEPTED);
    assert.equal(mapJudge0Status(4).code, STATUS.WRONG_ANSWER);
    assert.equal(mapJudge0Status(5).code, STATUS.TIME_LIMIT_EXCEEDED);
    assert.equal(mapJudge0Status(6).code, STATUS.COMPILATION_ERROR);
    assert.equal(mapJudge0Status(7).code, STATUS.RUNTIME_ERROR_SIGSEGV);
    assert.equal(mapJudge0Status(9).code, STATUS.RUNTIME_ERROR_SIGFPE);
    assert.equal(mapJudge0Status(11).code, STATUS.RUNTIME_ERROR_NZEC);
  });

  it('treats queued and processing as pending', () => {
    assert.ok(isPending(mapJudge0Status(1)));
    assert.ok(isPending(mapJudge0Status(2)));
    assert.ok(!isPending(mapJudge0Status(3)));
  });

  it('falls back to a runtime error for an unknown id instead of throwing', () => {
    assert.equal(mapJudge0Status(99).code, STATUS.RUNTIME_ERROR_OTHER);
    assert.equal(mapJudge0Status(99).id, 99);
  });

  it('recognises runtime error codes as crashes', () => {
    assert.ok(isRuntimeError(STATUS.RUNTIME_ERROR_SIGSEGV));
    assert.ok(!isRuntimeError(STATUS.ACCEPTED));
  });
});

describe('classifyRuntimeDetail', () => {
  // Measured on ce.judge0.com 1.14.0, where both crashes are reported as NZEC.
  it('recovers the signal the provider collapsed into NZEC', () => {
    assert.equal(
      classifyRuntimeDetail({ code: STATUS.RUNTIME_ERROR_NZEC, stderr: 'run.sh: line 1: 3 Segmentation fault (core dumped) ./a.out' }),
      'SIGSEGV',
    );
    assert.equal(
      classifyRuntimeDetail({ code: STATUS.RUNTIME_ERROR_NZEC, stderr: 'run.sh: line 1: 3 Floating point exception(core dumped) ./a.out' }),
      'SIGFPE',
    );
    assert.equal(classifyRuntimeDetail({ code: STATUS.RUNTIME_ERROR_NZEC, stderr: 'run.sh: line 1: 3 Killed ./a.out' }), 'SIGKILL');
  });

  it('returns null for a successful run or an unreadable message', () => {
    assert.equal(classifyRuntimeDetail({ code: STATUS.ACCEPTED, stderr: 'Segmentation fault' }), null);
    assert.equal(classifyRuntimeDetail({ code: STATUS.RUNTIME_ERROR_NZEC, stderr: '' }), null);
  });
});
