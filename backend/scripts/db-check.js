#!/usr/bin/env node
/**
 * "The database is not reachable" turned into one named step.
 *
 *   npm run db:check
 *
 * Walks the same path a login request walks - environment, URL shape, DNS, TCP,
 * authentication, then the schema - and prints the fix for the first thing that
 * fails. Passwords are never printed, so the output is safe to paste anywhere.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';

const ok = (label, detail) => console.log(`  OK    ${label.padEnd(11)} ${detail}`);
const bad = (label, detail, fix) => {
  console.log(`  FAIL  ${label.padEnd(11)} ${detail}`);
  if (fix) console.log(`        fix: ${fix}`);
};

let failed = 0;
const fail = (label, detail, fix) => {
  failed += 1;
  bad(label, detail, fix);
};

/** host:port/db only - never the user, never the password. */
function describeUrl(value) {
  try {
    const url = new URL(value);
    return { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.replace(/^\//, '') || '(none)', sslmode: url.searchParams.get('sslmode') };
  } catch {
    return null;
  }
}

function tcpProbe(host, port, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ connected: true }));
    socket.once('timeout', () => done({ connected: false, reason: `timed out after ${timeoutMs} ms` }));
    socket.once('error', (error) => done({ connected: false, reason: `${error.code ?? error.message}` }));
  });
}

console.log('\nNyaywala - database check\n');

/* ---------------------------------------------------------------- 1. env vars */
const databaseUrl = config.DATABASE_URL;
const directUrl = config.DIRECT_URL;
const runtime = describeUrl(databaseUrl);
const migration = describeUrl(directUrl);

if (!runtime) {
  fail('DATABASE_URL', 'is not a parseable URL', 'Copy the pooled string from Neon again; it starts with postgresql://');
} else {
  ok('DATABASE_URL', `${runtime.host}:${runtime.port}/${runtime.database} (sslmode=${runtime.sslmode ?? 'not set'})`);
  if (/ep-xxx|user:password|your-|example\.com/i.test(databaseUrl)) {
    fail('DATABASE_URL', 'still looks like the .env.example placeholder', 'Replace the whole string with the one from your Neon project.');
  }
  if (!runtime.host.includes('-pooler')) {
    console.log('  NOTE  DATABASE_URL is not a -pooler host. That works locally but exhausts connections');
    console.log('        under the batch queue; DIRECT_URL is the one for migrations.');
  }
}

if (!migration) {
  fail('DIRECT_URL', 'is not a parseable URL', 'Copy the direct (non-pooler) string from Neon.');
} else if (runtime && migration.host === runtime.host) {
  fail('DIRECT_URL', 'is the same host as DATABASE_URL', 'Migrations need the direct host; pgbouncer cannot run them.');
} else {
  ok('DIRECT_URL', `${migration.host}:${migration.port}/${migration.database}`);
}

if (!config.ACCESS_TOKEN_SECRET || config.ACCESS_TOKEN_SECRET.length < 32) {
  fail('ACCESS_TOKEN_SECRET', 'missing or shorter than 32 characters', 'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
} else {
  ok('ACCESS_TOKEN', `secret present (${config.ACCESS_TOKEN_SECRET.length} chars), origin ${config.APP_ORIGIN}`);
}

if (failed) {
  console.log('\nStopped before touching the network: fix the lines above first.\n');
  process.exit(1);
}

/* -------------------------------------------------------------------- 2. DNS */
try {
  const { address } = await lookup(runtime.host);
  ok('DNS', `${runtime.host} -> ${address}`);
} catch (error) {
  fail('DNS', `${runtime.host} does not resolve (${error.code ?? error.message})`, 'Check the host in DATABASE_URL; on WSL also check `cat /etc/resolv.conf` and that the network is up.');
}

/* -------------------------------------------------------------------- 3. TCP */
if (!failed) {
  const probe = await tcpProbe(runtime.host, runtime.port);
  if (probe.connected) ok('TCP', `${runtime.host}:${runtime.port} accepts connections`);
  else
    fail(
      'TCP',
      `${runtime.host}:${runtime.port} refused (${probe.reason})`,
      'Port 5432 blocked by a firewall/VPN, or the Neon project is paused. Wake it in the Neon console.',
    );
}

/* ------------------------------------------------------------- 4. login + schema */
if (!failed) {
  try {
    const [row] = await prisma.$queryRaw`SELECT current_database() AS database, current_user AS "user", version() AS version`;
    ok('LOGIN', `authenticated as ${row.user} on ${row.database}`);
    console.log(`        ${String(row.version).split(' ').slice(0, 2).join(' ')}`);
  } catch (error) {
    const detail = [error?.code, error?.message, error?.meta ? JSON.stringify(error.meta) : ''].filter(Boolean).join(' ');
    fail(
      'LOGIN',
      detail || 'the driver returned an error with no message',
      /password authentication failed/i.test(detail)
        ? 'The password changed; copy both connection strings from Neon again.'
        : 'See docs/linux-wsl.md section 10; `npm run db:check` output above names the failing layer.',
    );
  }
}

if (!failed) {
  try {
    const tables = await prisma.$queryRaw`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    const names = tables.map((row) => row.table_name);
    const required = ['users', 'courses', 'assignments', 'submissions', 'evaluations', 'rule_sets'];
    const missing = required.filter((name) => !names.includes(name));

    if (missing.length) {
      fail(
        'SCHEMA',
        `missing table(s): ${missing.join(', ')} (found ${names.length})`,
        'cd backend && npm run db:deploy && npm run db:seed',
      );
    } else {
      ok('SCHEMA', `${names.length} tables, all required ones present`);
      const [{ count }] = await prisma.$queryRaw`SELECT count(*)::int AS count FROM users`;
      ok('DATA', `${count} user row(s)${count === 0 ? ' - run `npm run db:seed` for the demo accounts' : ''}`);
    }
  } catch (error) {
    fail('SCHEMA', [error?.code, error?.message].filter(Boolean).join(' ') || 'could not read information_schema', 'cd backend && npm run db:deploy');
  }
}

await prisma.$disconnect().catch(() => {});

if (failed) {
  console.log(`\n${failed} check(s) failed.\n`);
  process.exit(1);
}
console.log('\nEverything the API needs is reachable. Start it with: npm run dev\n');
