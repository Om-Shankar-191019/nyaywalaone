import app from './app.js';
import { config } from './src/config.js';
import { warmDatabase } from './src/db.js';
import { describePrismaError } from './src/lib/prisma-errors.js';

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
