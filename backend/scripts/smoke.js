#!/usr/bin/env node
/**
 * Day 6 acceptance check: the API compiles and runs a real C file through the
 * provider, with limits applied.
 *
 *   npm run dev            # in one terminal
 *   npm run exec:smoke     # in another
 *
 * Requires the seeded instructor account (npm run db:seed).
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const email = process.env.SMOKE_EMAIL ?? 'prof@example.edu';
const password = process.env.SMOKE_PASSWORD ?? 'Passw0rd-Demo-2026';

const payload = JSON.parse(await readFile(resolve(here, 'smoke.json'), 'utf8'));

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

if (!login.ok) {
  const body = await login.text();
  console.error(`Login failed (${login.status}). Has the seed run? ${body.slice(0, 300)}`);
  process.exit(1);
}

const accessCookie = login.headers
  .getSetCookie()
  .map((line) => line.split(';')[0])
  .find((pair) => pair.startsWith('ag_at='));

if (!accessCookie) {
  console.error('Login succeeded but no access cookie was returned.');
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/exec/smoke`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: accessCookie },
  body: JSON.stringify(payload),
});

const body = await response.json();

if (!response.ok) {
  console.error(`Smoke failed (${response.status}):`, JSON.stringify(body, null, 2));
  process.exit(1);
}

const { execution, timings, ast, budget } = body.data;

console.log('Smoke OK');
console.log(`  status      ${execution.status.code} (${execution.status.description})`);
console.log(`  stdout      ${JSON.stringify(execution.stdout)}`);
console.log(`  cpu/memory  ${execution.timeMs} ms / ${execution.memoryKb} KB`);
console.log(`  round trip  ${timings.totalMs} ms`);
console.log(`  ast         ${ast.available ? `functions=${ast.metrics.functions} ifs=${ast.metrics.ifs} cyclomaticMax=${ast.metrics.cyclomaticMax}` : `unavailable (${ast.reason})`}`);
console.log(`  budget      ${budget.calls}/${budget.budget} calls on ${budget.day} UTC`);
