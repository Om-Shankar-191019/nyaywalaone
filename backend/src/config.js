import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment validation. A missing or malformed secret must fail here, at
 * boot, with a readable message - never at 2 a.m. inside a request handler.
 */
/**
 * `PORT=0` or `PORT=` in the ambient environment must not crash the server:
 * dotenv never overrides an existing variable, and some shells export PORT.
 * Anything that is not a usable port number falls back to the default.
 */
const port = z.preprocess((value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}, z.number().int().positive().max(65535).default(3001));

/** Empty strings are treated as "not set" for numeric fields. */
const optionalNumber = (schema) => z.preprocess((value) => (value === '' ? undefined : value), schema);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port,

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (pooled Postgres connection string)'),
  DIRECT_URL: z.string().min(1, 'DIRECT_URL is required (direct Postgres connection string, used by migrations)'),
  TEST_DATABASE_URL: z.string().optional().default(''),
  TEST_DIRECT_URL: z.string().optional().default(''),

  ACCESS_TOKEN_SECRET: z
    .string()
    .min(32, 'ACCESS_TOKEN_SECRET must be at least 32 characters; generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: optionalNumber(z.coerce.number().int().min(1).max(30).default(7)),

  APP_ORIGIN: z.string().url('APP_ORIGIN must be a full URL, e.g. http://localhost:5173'),
  EXTRA_ALLOWED_ORIGINS: z.string().optional().default(''),
  INSTRUCTOR_SIGNUP_CODE: z.string().optional().default(''),

  EXECUTION_PROVIDER: z.enum(['judge0', 'wandbox']).default('judge0'),
  JUDGE0_BASE_URL: z.string().url().default('https://ce.judge0.com'),
  JUDGE0_API_KEY: z.string().optional().default(''),
  JUDGE0_API_HOST: z.string().optional().default(''),
  JUDGE0_LANGUAGE_ID: optionalNumber(z.coerce.number().int().positive().default(103)),
  JUDGE0_DAILY_BUDGET: optionalNumber(z.coerce.number().int().min(0).default(200)),

  WANDBOX_BASE_URL: z.string().url().default('https://wandbox.org'),
  // Wandbox names C compilers with a "-c" suffix; "gcc-head" is the C++ one.
  WANDBOX_COMPILER: z.string().default('gcc-head-c'),

  EXEC_SMOKE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  // Week 2: grading engine. The LLM is optional; without a key the metric is
  // reported as unavailable and the rule set's policy decides what that costs.
  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_MODEL: z.string().optional().default('llama-3.3-70b-versatile'),
  GRADING_CONCURRENCY: optionalNumber(z.coerce.number().int().min(1).max(8).default(3)),
  // Shared secret for the queue drain endpoint; empty disables the endpoint.
  CRON_SECRET: z.string().optional().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}\n\nSee backend/.env.example and CREDENTIALS-NEEDED.md.`);
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

const extraOrigins = env.EXTRA_ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// In development the Vite dev server may be reached as localhost or 127.0.0.1.
const devOrigins = isProd ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173'];

export const config = Object.freeze({
  ...env,
  isProd,
  isTest: env.NODE_ENV === 'test',
  allowedOrigins: [...new Set([env.APP_ORIGIN, ...extraOrigins, ...devOrigins])],
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlMs: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  maxSourceBytes: 64 * 1024,
});
