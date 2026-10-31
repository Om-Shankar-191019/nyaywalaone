import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRateLimiter } from '../../src/lib/rateLimit.js';

const fakeRes = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  set(name, value) {
    this.headers[name] = value;
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe('createRateLimiter', () => {
  it('allows the first N requests and refuses the next one', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5, keyFn: (req) => req.ip });
    const req = { ip: '203.0.113.9' };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = fakeRes();
      let passed = false;
      limiter(req, res, () => {
        passed = true;
      });
      assert.ok(passed, `request ${attempt + 1} should pass`);
    }

    const blocked = fakeRes();
    limiter(req, blocked, () => assert.fail('the sixth request must not pass'));
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers['Retry-After']) >= 1);
  });

  it('counts each key separately', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, keyFn: (req) => req.ip });

    const first = fakeRes();
    limiter({ ip: 'a' }, first, () => {});
    const second = fakeRes();
    let passed = false;
    limiter({ ip: 'b' }, second, () => {
      passed = true;
    });
    assert.ok(passed, 'a different key has its own window');
  });

  it('can be reset between tests', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, keyFn: (req) => req.ip });
    limiter({ ip: 'c' }, fakeRes(), () => {});
    limiter.reset();
    let passed = false;
    limiter({ ip: 'c' }, fakeRes(), () => {
      passed = true;
    });
    assert.ok(passed);
  });
});
