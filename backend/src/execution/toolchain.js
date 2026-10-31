import { prisma } from '../db.js';
import { sha256Hex } from '../lib/hash.js';
import { AppError } from '../lib/http.js';
import { DEFAULT_LIMITS } from './limits.js';
import { getProvider } from './provider.js';
import { STATUS } from './status.js';

/**
 * A six-line probe whose output pins the compiler into the report. `/about`
 * gives the Judge0 version but not gcc, and a silent toolchain upgrade is
 * exactly the kind of thing that makes an old grade unexplainable later.
 */
const PROBE_SOURCE = `#include <stdio.h>
#include <limits.h>
int main(void) {
    printf("%s\\n", __VERSION__);
    printf("%ld\\n", (long)__STDC_VERSION__);
    printf("%d\\n", (int)(sizeof(void *) * CHAR_BIT));
    return 0;
}
`;

const sameUtcDay = (a, b) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

export async function captureToolchainFingerprint(providerName) {
  const provider = getProvider(providerName);

  const result = await provider.run({
    source: PROBE_SOURCE,
    compilerOptions: '-std=c11',
    limits: { ...DEFAULT_LIMITS, cpuTimeLimitSeconds: 2, wallTimeLimitSeconds: 10 },
  });

  if (result.status.code !== STATUS.ACCEPTED) {
    throw new AppError(502, 'PROVIDER_ERROR', 'The compiler probe did not run', {
      status: result.status.code,
      compileOutput: result.compileOutput?.slice(0, 500),
      stderr: result.stderr?.slice(0, 500),
    });
  }

  const [compilerVersion = 'unknown', stdcVersion = 'unknown', pointerBits = '0'] = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const raw = result.stdout.trim();
  const record = await prisma.toolchainFingerprint.create({
    data: {
      provider: provider.name,
      compilerVersion,
      stdcVersion,
      pointerBits: Number.parseInt(pointerBits, 10) || 0,
      raw,
      hash: sha256Hex(raw),
    },
  });

  return record;
}

/** Cached per provider per UTC day: one probe, not one per request. */
export async function getToolchainFingerprint(providerName) {
  const latest = await prisma.toolchainFingerprint.findFirst({
    where: { provider: providerName },
    orderBy: { capturedAt: 'desc' },
  });

  if (latest && sameUtcDay(latest.capturedAt, new Date())) return latest;
  return captureToolchainFingerprint(providerName);
}
