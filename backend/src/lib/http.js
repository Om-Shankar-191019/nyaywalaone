import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { config } from '../config.js';

/** A failure we chose. Everything else is a bug and becomes a 500. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthenticated = (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have access to this resource') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code, message, details) => new AppError(409, code, message, details);

/** Wrap an async handler so a rejected promise reaches the error middleware. */
export const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

/** Single response envelope: { data } or { error: { code, message, details? } }. */
export const send = (res, data, status = 200) => res.status(status).json({ data });

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route for ${req.method} ${req.originalUrl}`,
    },
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
/**
 * Prisma failure codes that mean "the deployment is not set up", not "the code
 * is wrong". They are the difference between a 500 a user can never act on and
 * a 503 that names the command that fixes it.
 */
const SCHEMA_ERROR_CODES = new Set(['P2021', 'P2022', 'P3005']);
const CONNECTION_ERROR_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1017']);

/**
 * Prisma 7 has no Rust query engine: it reaches Postgres through a driver
 * adapter, and a failing *connector* surfaces as `PrismaClientKnownRequestError`
 * with an **empty message** - the real cause sits in `meta` or `cause`. Logging
 * `err.message` therefore printed a blank line and answered 500 with no clue,
 * which is exactly the report we got from a fresh Linux clone. Flatten it.
 */
export function describePrismaError(error) {
  const parts = [
    error?.code ? `[${error.code}]` : '',
    error?.message ?? '',
    error?.meta ? JSON.stringify(error.meta).slice(0, 400) : '',
    error?.cause?.message ?? '',
  ].filter(Boolean);
  return parts.join(' ').slice(0, 800) || '(no message, no meta, no cause)';
}

/** Text that means "we never got as far as the query", not "the route is wrong". */
const CONNECTOR_FAILURE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout exceeded when trying to connect|Connection terminated|Can't reach database server|password authentication failed|self.signed certificate|unable to verify the first certificate|no pg_hba.conf entry/i;

/**
 * A stable id per request, so the line in the log and the message on screen are
 * the same event. Without it "the failure has been logged" is a claim nobody can
 * follow up on.
 */
export function requestId(req, res, next) {
  const provided = req.get('x-request-id');
  req.id = (provided && /^[\w-]{8,64}$/.test(provided) ? provided : randomUUID()).slice(0, 64);
  res.set('X-Request-Id', req.id);
  next();
}

export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  // express.json() throws a SyntaxError with `body` set on malformed input.
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }

  // A submission failing because the database was never migrated looks exactly
  // like a bug from the browser. Name it, and name the command.
  if (SCHEMA_ERROR_CODES.has(err?.code)) {
    if (!config.isTest) console.error('[error:schema]', req.id, err.code, err.meta ?? '', err.message?.split('\n')[0]);
    return res.status(503).json({
      error: {
        code: 'DB_SCHEMA_OUT_OF_DATE',
        message:
          'The database schema is behind the code. Run `npm run db:deploy` (prisma migrate deploy) against this database, then retry.',
        details: { requestId: req.id, prismaCode: err.code },
      },
    });
  }

  if (CONNECTION_ERROR_CODES.has(err?.code)) {
    if (!config.isTest) console.error('[error:db]', req.id, err.code, err.message?.split('\n')[0]);
    return res.status(503).json({
      error: {
        code: 'DB_UNAVAILABLE',
        message: 'The database is not reachable right now. Retry shortly; if it persists, check DATABASE_URL and the provider status.',
        details: { requestId: req.id, prismaCode: err.code },
      },
    });
  }

  if (!config.isTest) {
    console.error('[error]', req.id, err?.stack ?? err);
    if (String(err?.name ?? '').startsWith('Prisma')) {
      console.error('[error:prisma]', req.id, describePrismaError(err));
    }
  }

  // A Prisma error whose cause is a connector failure is an environment
  // problem (wrong DATABASE_URL, paused database, blocked port), so it must not
  // be reported as "something went wrong on our side".
  if (String(err?.name ?? '').startsWith('Prisma') && CONNECTOR_FAILURE.test(describePrismaError(err))) {
    return res.status(503).json({
      error: {
        code: 'DB_UNAVAILABLE',
        message:
          'The API could not reach the database. Check DATABASE_URL and that the database is awake; `cd backend && npm run db:check` names the failing step.',
        details: { requestId: req.id, prismaCode: err.code ?? null },
      },
    });
  }

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. The failure has been logged.',
      // The browser shows the message; the id is what makes the log findable.
      details: { requestId: req.id },
    },
  });
}
