#!/usr/bin/env node
/**
 * "The database is not reachable" turned into one named step.
 *
 *   npm run db:check
 *
 * Walks the same path a login request walks - environment, URL shape, DNS, TCP,
 * authentication, then the schema - and prints the fix for the first thing that
 * fails. Passwords are never printed, so the output is safe to paste anywhere.
 *
 * The network step probes port 5432 and port 443 separately. That distinction
 * is the whole point: `ETIMEDOUT` on 5432 while 443 answers means the network
 * drops outbound Postgres, which no amount of retrying fixes - the app has to
 * move to DATABASE_TRANSPORT=https (Neon's driver over TLS on 443).
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { config } from '../src/config.js';
import { databaseTransport, prisma } from '../src/db.js';
import { describeDbError } from '../src/lib/pg-pool.js';

const ok = (label, detail) => console.log(`  OK    ${label.padEnd(17)} ${detail}`);
const note = (label, detail) => console.log(`  NOTE  ${label.padEnd(17)} ${detail}`);
const bad = (label, detail, fix) => {
  console.log(`  FAIL  ${label.padEnd(17)} ${detail}`);
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

function tcpProbe(host, port, timeoutMs = 6_000) {
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

/**
 * Try every address the name resolves to, not just the first. Neon endpoints
 * answer on one address today and another after a failover, and a laptop that
 * cached the dead one would otherwise look permanently broken.
 */
async function reach(host, port, timeoutMs = 6_000) {
  let addresses;
  try {
    const list = await lookup(host, { all: true });
    addresses = [...new Set(list.map((entry) => entry.address))];
  } catch (error) {
    return { connected: false, reason: `DNS ${error.code ?? error.message}`, tried: [] };
  }

  const tried = [];
  for (const address of addresses.slice(0, 3)) {
    const probe = await tcpProbe(address, port, timeoutMs);
    tried.push(`${address}:${port} ${probe.connected ? 'ok' : probe.reason}`);
    if (probe.connected) return { connected: true, address, tried };
  }
  return { connected: false, reason: tried.join(', ') || 'no address resolved', tried };
}

/**
 * The HTTPS transport is not "Postgres on 443": Neon's driver opens a WebSocket
 * to wss://<host>/v2 and speaks Postgres inside it. A network that permits TLS
 * on 443 but strips or resets the `Upgrade` handshake passes every TCP check and
 * fails only at login - which is exactly the campus-Wi-Fi case this script
 * exists for, and it is why "TCP 443 accepts connections" was not enough.
 *
 * Informational only: Neon may close an unauthenticated upgrade, so the LOGIN
 * step stays the verdict and this line only explains it.
 */
function websocketProbe(host, timeoutMs = 8_000) {
  if (typeof WebSocket !== 'function') {
    return Promise.resolve({ supported: false, ok: false, reason: 'this Node build has no global WebSocket' });
  }

  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(`wss://${host}/v2`);
    } catch (error) {
      resolve({ supported: true, ok: false, reason: error?.message ?? 'the upgrade could not be started' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve({ supported: true, ...result });
    };

    const timer = setTimeout(() => finish({ ok: false, reason: `no upgrade after ${timeoutMs} ms` }), timeoutMs);
    socket.addEventListener('open', () => finish({ ok: true }));
    socket.addEventListener('error', () => finish({ ok: false, reason: 'refused or dropped during the handshake' }));
    socket.addEventListener('close', (event) => finish({ ok: false, reason: `closed during the handshake (code ${event.code})` }));
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

ok(
  'TRANSPORT',
  databaseTransport === 'https'
    ? 'DATABASE_TRANSPORT=https - Neon serverless driver over TLS on port 443'
    : 'DATABASE_TRANSPORT=tcp (default) - Postgres directly on port 5432',
);

if (failed) {
  console.log('\nStopped before touching the network: fix the lines above first.\n');
  process.exit(1);
}

/* -------------------------------------------------------------------- 2. DNS */
try {
  const list = await lookup(runtime.host, { all: true });
  const unique = [...new Set(list.map((entry) => entry.address))];
  ok('DNS', `${runtime.host} -> ${unique.join(', ')}`);
} catch (error) {
  fail('DNS', `${runtime.host} does not resolve (${error.code ?? error.message})`, 'Check the host in DATABASE_URL; on WSL also check `cat /etc/resolv.conf` and that the network is up.');
}

/* ---------------------------------------------------------- 3. port reachability */
/** Filled in only for the HTTPS transport; read again by the LOGIN hint below. */
let wsUpgrade = null;

if (!failed) {
  const secure = await reach(runtime.host, 443);
  const direct = await reach(runtime.host, 5432);

  if (databaseTransport === 'https') {
    if (secure.connected) ok('TCP 443', `${runtime.host}:443 accepts connections (HTTPS transport)`);
    else
      fail(
        'TCP 443',
        `${runtime.host}:443 unreachable (${secure.reason})`,
        'HTTPS is blocked too, so this is not a port-5432 problem: wake the project, check Neon -> Settings -> IP Allow, or try another network.',
      );

    if (secure.connected) {
      wsUpgrade = await websocketProbe(runtime.host);
      if (wsUpgrade.supported === false) note('WS 443', `not tested - ${wsUpgrade.reason}`);
      else if (wsUpgrade.ok) ok('WS 443', `WebSocket upgrade to wss://${runtime.host}/v2 accepted (the path this transport needs)`);
      else note('WS 443', `WebSocket upgrade ${wsUpgrade.reason} - informational, LOGIN below is the verdict`);
    }

    if (direct.connected) note('TCP 5432', `${runtime.host}:5432 also works here - DATABASE_TRANSPORT=tcp would be faster`);
    if (secure.connected && !direct.connected) note('TCP 5432', 'blocked by this network, which is why DATABASE_TRANSPORT=https is set');
  } else {
    if (direct.connected) {
      ok('TCP 5432', `${runtime.host}:5432 accepts connections${direct.address ? ` (${direct.address})` : ''}`);
    } else if (secure.connected) {
      // The decisive case: the host is up and serving HTTPS, so the project is
      // running and the name resolves; only outbound 5432 is being dropped.
      fail(
        'TCP 5432',
        `${runtime.host}:5432 unreachable (${direct.reason})`,
        `Port 443 to the same host works, so your network blocks outbound 5432 (campus/hostel/office firewall or ISP). Set DATABASE_TRANSPORT=https in backend/.env and run this again - no other change is needed.`,
      );
    } else {
      fail(
        'TCP',
        `${runtime.host} is unreachable on both 443 and 5432 (${direct.reason})`,
        'Not a port problem: wake the Neon project in the console, check Settings -> IP Allow, or connect from another network.',
      );
    }
  }
}

/* ------------------------------------------------------------- 4. login + schema */
if (!failed) {
  try {
    // `name` is cast to text on purpose: the HTTPS transport (Neon's serverless
    // driver) cannot deserialize Postgres' internal `name` type, and
    // current_database/current_user/version are all `name` or `text` variants.
    const [row] = await prisma.$queryRaw`SELECT current_database()::text AS database, current_user::text AS "user", version()::text AS version`;
    ok('LOGIN', `authenticated as ${row.user} on ${row.database}`);
    console.log(`        ${String(row.version).split(' ').slice(0, 2).join(' ')}`);
  } catch (error) {
    // `describeDbError` walks `cause` and the driver's aggregate errors. Reading
    // only `error.message` is what produced "an error with no message": the
    // HTTPS driver rejects with a wrapper whose own message is empty while the
    // socket failure sits one level down.
    const detail = describeDbError(error);
    const hint = /password authentication failed/i.test(detail)
      ? 'The password changed; copy both connection strings from Neon again.'
      : databaseTransport === 'https'
        ? wsUpgrade && wsUpgrade.supported !== false && !wsUpgrade.ok
          ? 'This network accepts TLS on 443 but drops the WebSocket upgrade, so the HTTPS transport cannot work here. Port 5432 answers above, so set DATABASE_TRANSPORT=tcp (or remove the line) in backend/.env and run this again.'
          : 'The HTTPS transport reached 443 but could not finish a query. If 5432 answers above, set DATABASE_TRANSPORT=tcp; otherwise try another network. See docs/linux-wsl.md section 10.4.'
        : 'See docs/linux-wsl.md section 10; the lines above name the failing layer.';
    fail('LOGIN', detail, hint);
  }
}

if (!failed) {
  try {
    const tables = await prisma.$queryRaw`
      SELECT table_name::text AS table_name FROM information_schema.tables
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
console.log(`\nEverything the API needs is reachable over ${databaseTransport}. Start it with: npm run dev\n`);
