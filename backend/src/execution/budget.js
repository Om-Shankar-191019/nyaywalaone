import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from '../lib/http.js';

/** UTC calendar day, because the provider quota resets on UTC. */
export function utcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The budget guard. A public sandbox with no SLA and an unknown quota is a
 * demo-day risk, so usage is counted per UTC day and a call over the limit is
 * refused with 429 before it is attempted.
 */
export async function assertWithinBudget(provider, budget = config.EXEC_DAILY_BUDGET) {
  if (budget <= 0) return { used: 0, budget: 0, unlimited: true };

  const row = await prisma.providerUsage.findUnique({
    where: { provider_day: { provider, day: utcDay() } },
    select: { calls: true },
  });

  const used = row?.calls ?? 0;
  if (used >= budget) {
    throw new AppError(
      429,
      'PROVIDER_BUDGET_EXCEEDED',
      `Daily execution budget of ${budget} calls is spent. Grading resumes after 00:00 UTC, or raise EXEC_DAILY_BUDGET.`,
      { used, budget, provider },
    );
  }

  return { used, budget };
}

/** Count the call after it was attempted - failures cost quota too. */
export async function recordUsage(provider) {
  await prisma.providerUsage.upsert({
    where: { provider_day: { provider, day: utcDay() } },
    create: { provider, day: utcDay(), calls: 1 },
    update: { calls: { increment: 1 } },
  });
}

export async function usageToday(provider) {
  const row = await prisma.providerUsage.findUnique({
    where: { provider_day: { provider, day: utcDay() } },
    select: { calls: true },
  });
  return { provider, day: utcDay().toISOString().slice(0, 10), calls: row?.calls ?? 0, budget: config.EXEC_DAILY_BUDGET };
}
