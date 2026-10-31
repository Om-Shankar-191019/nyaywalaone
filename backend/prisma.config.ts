import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the connection string out of `schema.prisma` and into this
 * file. Two URLs exist on purpose:
 *
 *   DIRECT_URL   - used here for `prisma migrate` (no pooler, no advisory-lock
 *                  problems). Neon's direct host.
 *   DATABASE_URL - used by the running API through the pg driver adapter,
 *                  pointing at the pooled host.
 *
 * Keeping the migration URL here rather than in the schema is what the v7
 * upgrade requires; the schema is now pure data model.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
