import './../setup.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { signAccessToken } from '../../src/auth/jwt.js';
import {
  TEST_PASSWORD,
  agent,
  api,
  assertDatabaseReachable,
  cookieValue,
  config,
  prisma,
  registerStudent,
  resetDatabase,
  uniqueEmail,
} from '../helpers.js';

before(assertDatabaseReachable);
beforeEach(resetDatabase);
after(async () => {
  await prisma.$disconnect();
});

describe('POST /api/auth/register', () => {
  it('creates a student, sets both cookies and returns the public user', async () => {
    const client = agent();
    const email = uniqueEmail('ada');

    const response = await client.post('/api/auth/register').send({
      fullName: 'Ada Lovelace',
      email,
      password: TEST_PASSWORD,
      role: 'student',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.user.email, email);
    assert.equal(response.body.data.user.role, 'STUDENT');
    assert.equal(response.body.data.user.passwordHash, undefined, 'the hash must never leave the server');

    assert.ok(cookieValue(response, 'ag_at'), 'access cookie set');
    assert.ok(cookieValue(response, 'ag_rt'), 'refresh cookie set');
  });

  it('rejects a duplicate email with 409', async () => {
    const { email } = await registerStudent();
    const second = await api().post('/api/auth/register').send({
      fullName: 'Someone Else',
      email,
      password: TEST_PASSWORD,
      role: 'student',
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'EMAIL_TAKEN');
  });

  it('rejects a short password with a field-level message', async () => {
    const response = await api().post('/api/auth/register').send({
      fullName: 'Too Short',
      email: uniqueEmail('short'),
      password: 'short',
      role: 'student',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(response.body.error.details.some((detail) => detail.path === 'password'));
  });

  it('requires the signup code for an instructor when one is configured', async () => {
    if (!config.INSTRUCTOR_SIGNUP_CODE) return; // open signup is a valid configuration

    const response = await api().post('/api/auth/register').send({
      fullName: 'No Code',
      email: uniqueEmail('prof'),
      password: TEST_PASSWORD,
      role: 'instructor',
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in and returns the enrolments', async () => {
    const { email } = await registerStudent({ fullName: 'Grace Hopper' });
    const client = agent();

    const response = await client.post('/api/auth/login').send({ email, password: TEST_PASSWORD });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.fullName, 'Grace Hopper');
    assert.ok(Array.isArray(response.body.data.enrollments));
  });

  it('answers a wrong password and an unknown account identically', async () => {
    const { email } = await registerStudent();

    const wrong = await api().post('/api/auth/login').send({ email, password: 'definitely-wrong' });
    const unknown = await api().post('/api/auth/login').send({ email: uniqueEmail('nobody'), password: 'definitely-wrong' });

    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error.message, unknown.body.error.message);
  });

  it('rate limits the sixth attempt for the same email', async () => {
    const { email } = await registerStudent();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await api().post('/api/auth/login').send({ email, password: 'wrong-password' });
      assert.equal(response.status, 401);
    }

    const blocked = await api().post('/api/auth/login').send({ email, password: 'wrong-password' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a cookie', async () => {
    const response = await api().get('/api/auth/me');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
  });

  it('returns the current user for a valid access token', async () => {
    const client = agent();
    const { response } = await registerStudent();
    assert.equal(response.status, 201);

    const email = response.body.data.user.email;
    const login = await client.post('/api/auth/login').send({ email, password: TEST_PASSWORD });
    assert.equal(login.status, 200);

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, email);
    assert.equal(me.body.data.taughtCount, 0);
  });

  it('rejects an expired access token with 401', async () => {
    const { response } = await registerStudent();
    assert.equal(response.status, 201);
    const userId = response.body.data.user.id;

    const expired = signAccessToken({ userId, role: 'STUDENT' }, { expiresIn: '-1s' });
    const me = await api().get('/api/auth/me').set('Cookie', `ag_at=${expired}`);

    assert.equal(me.status, 401);
    assert.equal(me.body.error.code, 'UNAUTHENTICATED');
  });
});

describe('refresh rotation', () => {
  it('issues a new refresh token and refuses the replayed one', async () => {
    const client = agent();
    const registered = await registerStudent();
    const email = registered.response.body.data.user.email;

    const login = await client.post('/api/auth/login').send({ email, password: TEST_PASSWORD });
    const firstRefresh = cookieValue(login, 'ag_rt');
    assert.ok(firstRefresh);

    const rotated = await client.post('/api/auth/refresh').set('Cookie', `ag_rt=${firstRefresh}`);
    assert.equal(rotated.status, 200);
    const secondRefresh = cookieValue(rotated, 'ag_rt');
    assert.ok(secondRefresh);
    assert.notEqual(secondRefresh, firstRefresh, 'the token must rotate');

    // Replay the old token: this is the signature of a stolen cookie.
    const replay = await api().post('/api/auth/refresh').set('Cookie', `ag_rt=${firstRefresh}`);
    assert.equal(replay.status, 401);
    assert.match(replay.body.error.message, /reuse|revoked/i);

    // Replay detection revokes the whole family, including the newest token.
    const afterReplay = await api().post('/api/auth/refresh').set('Cookie', `ag_rt=${secondRefresh}`);
    assert.equal(afterReplay.status, 401);

    const liveTokens = await prisma.refreshToken.count({ where: { revokedAt: null } });
    assert.equal(liveTokens, 0, 'every session for that user is revoked');
  });

  it('rejects a refresh with no cookie', async () => {
    const response = await api().post('/api/auth/refresh');
    assert.equal(response.status, 401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token and clears the cookies', async () => {
    const client = agent();
    const { response } = await registerStudent();
    const email = response.body.data.user.email;

    const login = await client.post('/api/auth/login').send({ email, password: TEST_PASSWORD });
    const refreshToken = cookieValue(login, 'ag_rt');

    const logout = await client.post('/api/auth/logout');
    assert.equal(logout.status, 200);

    const reuse = await api().post('/api/auth/refresh').set('Cookie', `ag_rt=${refreshToken}`);
    assert.equal(reuse.status, 401);
  });
});
