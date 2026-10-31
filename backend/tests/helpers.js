import request from 'supertest';
import app from '../app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';

export const api = () => request(app);
export const agent = () => request.agent(app);

const TABLES = [
  'refresh_tokens',
  'enrollments',
  'assignments',
  'courses',
  'provider_usage',
  'toolchain_fingerprints',
  'users',
];

/** Truncate between tests so order never matters. */
export async function resetDatabase() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export async function assertDatabaseReachable() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    throw new Error(
      `Integration tests need a reachable Postgres database.\n` +
        `DATABASE_URL points at: ${String(config.DATABASE_URL).replace(/:\/\/[^@]*@/, '://***@')}\n` +
        `Fix: create the database, then run "npm run db:deploy" in backend/.\n` +
        `Underlying error: ${error.message.split('\n')[0]}`,
    );
  }
}

let counter = 0;

export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now()}.${(counter += 1)}@example.edu`;

export const TEST_PASSWORD = 'Correct-Horse-42';

export async function registerStudent(overrides = {}) {
  const email = overrides.email ?? uniqueEmail('student');
  const response = await api().post('/api/auth/register').send({
    fullName: 'Test Student',
    email,
    password: TEST_PASSWORD,
    role: 'student',
    ...overrides,
  });
  return { response, email };
}

export async function registerInstructor(overrides = {}) {
  const email = overrides.email ?? uniqueEmail('prof');
  const response = await api().post('/api/auth/register').send({
    fullName: 'Test Instructor',
    email,
    password: TEST_PASSWORD,
    role: 'instructor',
    instructorCode: config.INSTRUCTOR_SIGNUP_CODE || undefined,
    ...overrides,
  });
  return { response, email };
}

/** Extract a cookie value from a supertest response's Set-Cookie header. */
export function cookieValue(response, name) {
  const raw = response.headers['set-cookie'] ?? [];
  const match = raw.find((line) => line.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split(';')[0].split('=').slice(1).join('=')) : null;
}

export { app, config, prisma };
