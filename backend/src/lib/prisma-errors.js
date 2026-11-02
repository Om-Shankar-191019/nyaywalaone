/**
 * Reading Prisma 7 errors.
 *
 * Prisma 7 has no Rust query engine: it reaches Postgres through a driver
 * adapter, and a failing *connector* surfaces as a `PrismaClientKnownRequestError`
 * whose `message` is **empty** - the real cause lives in `meta`/`cause`. Logging
 * `err.message` therefore printed `Seed failed:` followed by nothing, and
 * answered 500s with no clue. Everything that reports a database error goes
 * through these two helpers instead.
 */

/** Flatten code + message + meta + cause chain into one log-safe line. */
export function describePrismaError(error) {
  const parts = [
    error?.code ? `[${error.code}]` : '',
    error?.message ?? '',
    error?.meta ? JSON.stringify(error.meta).slice(0, 400) : '',
    error?.cause?.message ?? '',
  ].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 800) || '(no message, no meta, no cause)';
}

/** Text that means "we never got as far as the query", not "the route is wrong". */
export const CONNECTOR_FAILURE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout exceeded when trying to connect|Connection terminated|Can't reach database server|password authentication failed|self.signed certificate|unable to verify the first certificate|no pg_hba.conf entry/i;

/** A Prisma error caused by the connection, i.e. an environment problem. */
export function isConnectorFailure(error) {
  return String(error?.name ?? '').startsWith('Prisma') && CONNECTOR_FAILURE.test(describePrismaError(error));
}
