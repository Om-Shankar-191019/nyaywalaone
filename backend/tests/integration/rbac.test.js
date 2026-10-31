import './../setup.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { TEST_PASSWORD, agent, api, assertDatabaseReachable, prisma, resetDatabase } from '../helpers.js';

before(assertDatabaseReachable);
beforeEach(resetDatabase);
after(async () => {
  await prisma.$disconnect();
});

/** Register through a persistent agent so the cookies come along. */
async function signedIn(role) {
  const client = agent();
  const email = `${role}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.edu`;
  const response = await client.post('/api/auth/register').send({
    fullName: role === 'instructor' ? 'Prof Test' : 'Student Test',
    email,
    password: TEST_PASSWORD,
    role,
    ...(role === 'instructor' ? { instructorCode: process.env.INSTRUCTOR_SIGNUP_CODE || undefined } : {}),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { client, user: response.body.data.user, email };
}

describe('course authorisation', () => {
  it('requires authentication', async () => {
    const response = await api().get('/api/courses');
    assert.equal(response.status, 401);
  });

  it('forbids a student from creating a course', async () => {
    const student = await signedIn('student');
    const response = await student.client.post('/api/courses').send({ name: 'Hijacked Course' });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  });

  it('creates a course with a readable 8-character join code', async () => {
    const instructor = await signedIn('instructor');
    const response = await instructor.client.post('/api/courses').send({ name: 'CS 201 - Data Structures' });

    assert.equal(response.status, 201);
    const { course } = response.body.data;
    assert.equal(course.joinCode.length, 8);
    assert.match(course.joinCode, /^[A-Z2-9]+$/, 'ambiguous characters are excluded');
    assert.equal(course.instructorId, instructor.user.id);
  });

  it('returns 404 when an instructor reads another instructor roster', async () => {
    const owner = await signedIn('instructor');
    const intruder = await signedIn('instructor');

    const created = await owner.client.post('/api/courses').send({ name: 'Private Course' });
    const courseId = created.body.data.course.id;

    const response = await intruder.client.get(`/api/courses/${courseId}/roster`);
    assert.equal(response.status, 404, 'not 403: ids must not be enumerable');
  });

  it('returns 404 for a malformed course id', async () => {
    const instructor = await signedIn('instructor');
    const response = await instructor.client.get('/api/courses/not-a-uuid/roster');
    assert.equal(response.status, 404);
  });
});

describe('joining a course', () => {
  it('rejects an unknown join code with 404', async () => {
    const student = await signedIn('student');
    const response = await student.client.post('/api/courses/join').send({ code: 'NOPE2345' });
    assert.equal(response.status, 404);
  });

  it('lets a student join, and shows the course in their list', async () => {
    const instructor = await signedIn('instructor');
    const student = await signedIn('student');

    const created = await instructor.client.post('/api/courses').send({ name: 'Intro to C' });
    const { joinCode, id } = created.body.data.course;

    const joined = await student.client.post('/api/courses/join').send({ code: joinCode.toLowerCase() });
    assert.equal(joined.status, 200, 'join codes are case-insensitive');
    assert.equal(joined.body.data.course.id, id);

    // Joining twice is idempotent, not an error.
    const again = await student.client.post('/api/courses/join').send({ code: joinCode });
    assert.equal(again.status, 200);

    const list = await student.client.get('/api/courses');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.courses.length, 1);
    assert.equal(list.body.data.courses[0].joinCode, undefined, 'students never receive the join code back');

    const roster = await instructor.client.get(`/api/courses/${id}/roster`);
    assert.equal(roster.status, 200);
    assert.equal(roster.body.data.students.length, 1);
  });

  it('does not let an instructor join a course as a student', async () => {
    const instructor = await signedIn('instructor');
    const created = await instructor.client.post('/api/courses').send({ name: 'Own Course' });

    const response = await instructor.client.post('/api/courses/join').send({ code: created.body.data.course.joinCode });
    assert.equal(response.status, 403);
  });
});

describe('assignments', () => {
  it('scopes assignments to enrolled students and the owning instructor', async () => {
    const instructor = await signedIn('instructor');
    const enrolled = await signedIn('student');
    const outsider = await signedIn('student');

    const created = await instructor.client.post('/api/courses').send({ name: 'Algorithms' });
    const courseId = created.body.data.course.id;
    await enrolled.client.post('/api/courses/join').send({ code: created.body.data.course.joinCode });

    const assignment = await instructor.client.post(`/api/courses/${courseId}/assignments`).send({
      title: 'Add two integers',
      statement: 'Read two integers and print their sum.',
    });
    assert.equal(assignment.status, 201);
    const assignmentId = assignment.body.data.assignment.id;

    const asEnrolled = await enrolled.client.get(`/api/assignments/${assignmentId}`);
    assert.equal(asEnrolled.status, 200);

    const asOutsider = await outsider.client.get(`/api/assignments/${assignmentId}`);
    assert.equal(asOutsider.status, 404, 'outsiders get 404, never 403');

    const studentCreating = await enrolled.client.post(`/api/courses/${courseId}/assignments`).send({
      title: 'Fake',
      statement: 'Should not exist',
    });
    assert.equal(studentCreating.status, 403);
  });
});

describe('origin check', () => {
  it('blocks a mutating request from a foreign origin', async () => {
    const response = await api()
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'someone@example.edu', password: 'whatever' });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'CSRF_ORIGIN');
  });

  it('allows the configured app origin', async () => {
    const response = await api()
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email: 'nobody@example.edu', password: 'whatever' });

    assert.equal(response.status, 401, 'the origin passes and the credentials fail, as expected');
  });

  it('allows the deployment\'s own origin, as a Vercel proxy presents it', async () => {
    // The public host is not known at build time (every preview deploy gets a
    // new one), so APP_ORIGIN cannot list it. Same-origin must still pass.
    const response = await api()
      .post('/api/auth/login')
      .set('Origin', 'https://autograder-demo.vercel.app')
      .set('X-Forwarded-Host', 'autograder-demo.vercel.app')
      .set('X-Forwarded-Proto', 'https')
      .send({ email: 'nobody@example.edu', password: 'whatever' });

    assert.equal(response.status, 401, 'the origin passes and the credentials fail, as expected');
  });

  it('still blocks a foreign origin when proxy headers are present', async () => {
    const response = await api()
      .post('/api/auth/register')
      .set('Origin', 'https://evil.example')
      .set('X-Forwarded-Host', 'autograder-demo.vercel.app')
      .set('X-Forwarded-Proto', 'https')
      .send({ fullName: 'Eve', email: 'eve@example.edu', password: 'Correct-Horse-42', role: 'student' });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'CSRF_ORIGIN');
  });

  it('allows non-browser clients that send no Origin', async () => {
    const response = await api().post('/api/auth/login').send({ email: 'nobody@example.edu', password: 'whatever' });
    assert.equal(response.status, 401);
  });
});

describe('health', () => {
  it('reports the database as reachable', async () => {
    const response = await api().get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.db, 'ok');
  });

  it('returns the standard envelope for an unknown route', async () => {
    const response = await api().get('/api/nope');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROUTE_NOT_FOUND');
  });
});
