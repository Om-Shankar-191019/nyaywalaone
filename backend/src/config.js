import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment validation. A missing or malformed secret must fail here, at
 * boot, with a readable message - never at 2 a.m. inside a request handler.
 */

/**
 * Windows and WSL disagree about line endings, and a `.env` edited on Windows
 * easily ends up with `VALUE\r` or a UTF-8 BOM before the first key. Both make
 * Zod reject a perfectly good value (`"https://x\r" is not a URL`) with a
 * message that blames the user's configuration. Normalise once, here.
 */
export function sanitiseEnv(source = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    out[key] = value
      .replace(/^\uFEFF/, '') // BOM
      .replace(/[\r\n]+$/, '') // trailing CRLF from a Windows editor
      .trim();
  }
  return out;
}

const clean = sanitiseEnv();

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

/** `undefined` when the string is empty, so `.optional()` and defaults apply. */
const optionalString = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());

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
  COOKIE_DOMAIN: optionalString,

  APP_ORIGIN: z.string().url('APP_ORIGIN must be a full URL, e.g. http://localhost:5173'),
  EXTRA_ALLOWED_ORIGINS: z.string().optional().default(''),
  INSTRUCTOR_SIGNUP_CODE: z.string().optional().default(''),

  /* --------------------------------------------------------- week 3: sandbox */
  EXECUTION_PROVIDER: z.enum(['onlinecompiler', 'judge0', 'wandbox']).default('onlinecompiler'),

  // onlinecompiler.io replaces Judge0: no credit card, one synchronous
  // endpoint, gcc 15 / C23 behind it.
  ONLINECOMPILER_BASE_URL: z.string().url().default('https://api.onlinecompiler.io'),
  ONLINECOMPILER_API_KEY: z.string().optional().default(''),
  // The compiler id, not a language name. `gcc-15` is the C one.
  ONLINECOMPILER_COMPILER: z.string().default('gcc-15'),
  // Abort before the provider's own 30 s ceiling, so a wedged run surfaces as a
  // timeout we control rather than a socket that never closes.
  ONLINECOMPILER_TIMEOUT_SECONDS: optionalNumber(z.coerce.number().int().min(5).max(35).default(25)),

  // Judge0 stays available as a fallback, not as the default.
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

  /* -------------------------------------------------- week 2: grading engine */
  // The LLM is optional; without a key the metric is reported as unavailable
  // and the rule set's policy decides what that costs.
  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_MODEL: z.string().optional().default('llama-3.3-70b-versatile'),
  GRADING_CONCURRENCY: optionalNumber(z.coerce.number().int().min(1).max(8).default(3)),
  // Shared secret for the queue drain endpoint; empty disables the endpoint.
  CRON_SECRET: z.string().optional().default(''),
});

/**
 * One key, two names. The team first pasted its onlinecompiler.io key into
 * `JUDGE0_API_KEY`, so accept that as the fallback and prefer the explicit name
 * from now on. Same trick for the daily budget: `EXEC_DAILY_BUDGET` wins, and
 * the old name keeps working for anyone with an existing `.env`.
 */
const merged = {
  ...clean,
  ONLINECOMPILER_API_KEY: clean.ONLINECOMPILER_API_KEY || clean.JUDGE0_API_KEY || '',
  EXEC_DAILY_BUDGET: clean.EXEC_DAILY_BUDGET || clean.JUDGE0_DAILY_BUDGET || '200',
};

const parsed = envSchema.safeParse(merged);

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new Error(
    `Invalid environment configuration:\n${lines.join('\n')}\n\nSee backend/.env.example and docs/credentials.md.`,
  );
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

const extraOrigins = env.EXTRA_ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// In development the Vite dev server may be reached as localhost or 127.0.0.1.
const devOrigins = isProd ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173'];

const dailyBudget = (() => {
  const value = Number(merged.EXEC_DAILY_BUDGET);
  return Number.isInteger(value) && value >= 0 ? value : 200;
})();

export const config = Object.freeze({
  ...env,
  isProd,
  isTest: env.NODE_ENV === 'test',
  platform: process.platform,
  allowedOrigins: [...new Set([env.APP_ORIGIN, ...extraOrigins, ...devOrigins])],
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlMs: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  maxSourceBytes: 64 * 1024,
  // Week 3: one budget variable for whichever sandbox is configured.
  EXEC_DAILY_BUDGET: dailyBudget,
  // Kept as an alias so Week 2 call sites and tests keep their meaning.
  JUDGE0_DAILY_BUDGET: dailyBudget,
});

export const usesOnlineCompiler = () => config.EXECUTION_PROVIDER === 'onlinecompiler';
