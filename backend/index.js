import app from './app.js';
import { config } from './src/config.js';

/**
 * Two entry points, one app:
 *  - locally, Node listens on PORT;
 *  - on Vercel, the platform imports this module's default export and runs it
 *    as a serverless function. Listening there would be a leak, not a server.
 */
if (!process.env.VERCEL) {
  app.listen(config.PORT, () => {
    console.log(`Nyaywala API on http://localhost:${config.PORT} (${config.NODE_ENV}, provider: ${config.EXECUTION_PROVIDER})`);
  });
}

export default app;
