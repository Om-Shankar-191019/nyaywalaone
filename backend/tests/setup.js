import 'dotenv/config';

/**
 * This module must be imported first in every test file. ES modules evaluate
 * their imports depth-first in source order, so anything imported after this
 * one sees these values.
 */
process.env.NODE_ENV = 'test';

if (process.env.TEST_DATABASE_URL?.trim()) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.trim();
}
if (process.env.TEST_DIRECT_URL?.trim()) {
  process.env.DIRECT_URL = process.env.TEST_DIRECT_URL.trim();
}

// Tests must never touch a real provider budget or the network.
process.env.EXECUTION_PROVIDER ??= 'judge0';
process.env.EXEC_SMOKE_ENABLED ??= 'true';
