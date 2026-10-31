/**
 * One-off: create the dedicated integration-test database on the Neon project.
 * Tests TRUNCATE every table, so they must never run against the dev database.
 * Idempotent: running it twice reports "already exists" without failing.
 */
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const direct = process.env.DIRECT_URL;
if (!direct) {
  console.error('DIRECT_URL missing');
  process.exit(1);
}

const url = new URL(direct);
const dbName = 'nyaywala_test';

const client = new Client({
  connectionString: direct,
  application_name: 'nyaywala-test-db-setup',
});
await client.connect();
try {
  const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (found.rowCount > 0) {
    console.log(`database "${dbName}" already exists on ${url.host}`);
  } else {
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`created database "${dbName}" on ${url.host}`);
  }
} finally {
  await client.end();
}
