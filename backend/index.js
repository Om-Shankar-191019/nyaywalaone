import app from './app.js';
import { config } from './src/config.js';
import { warmDatabase } from './src/db.js';
import { describePrismaError } from './src/lib/prisma-errors.js';

/**
 * Two net guards, for the same symptom.
 *
 * When this process dies, the only thing the developer sees is Vite saying
 * `cannot reach the API at http://localhost:3001 (ECONNRESET)` - a message that
 * names the frontend and not the cause. Node 22 does that on any unhandled
 * rejection: one dropped WebSocket from the HTTPS database transport, or one
 * fire-and-forget grading task that rejects after the response was sent, takes
 * the whole API down and every poll in the browser with it.
 *
 * Nothing here is durable state: requests are independent, results live in
 * Postgres, and a row a dead process left RUNNING is re-claimed by the queue
 * drain after `STALE_CLAIM_MINUTES`. So log loudly and keep serving instead of
 * exiting silently. A request that was in flight still fails; every later one
 * works, and the log now names the real error.
 */
function reportUnexpected(label, error) {
  console.error(`[fatal] ${label}: ${describePrismaError(error)}`);
  if (error?.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'));
  console.error('[fatal] the API is still serving; requests are independent. Report this line with the request id.');
}

process.on('unhandledRejection', (reason) => reportUnexpected('unhandled promise rejection', reason));
process.on('uncaughtException', (error) => reportUnexpected('uncaught exception', error));

/**
 * Two entry points, one app:
 *  - locally, Node listens on PORT;
 *  - on Vercel, the platform imports this module's default export and runs it
 *    as a serverless function. Listening there would be a leak, not a server.
 */
if (!process.env.VERCEL) {
  app.listen(config.PORT, async () => {
    console.log(`Nyaywala API on http://localhost:${config.PORT} (${config.NODE_ENV}, provider: ${config.EXECUTION_PROVIDER})`);

    // Open the first database connection now, with backoff. Doing it here means
    // a cold or unreachable database is a readable line at startup instead of a
    // 503 in the middle of someone's sign-in.
    const { ok, attempts, error } = await warmDatabase();
    if (ok) {
      console.log(`[db] pool warm after ${attempts} attempt(s)`);
    } else {
      console.error(`[db] database unreachable: ${describePrismaError(error)}`);
      console.error('[db] the API is still listening, but authenticated routes will answer 503 until this is fixed.');
      console.error('[db] run: cd backend && npm run db:check');
    }
  });
}

export default app;
