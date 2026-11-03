import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';
import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let prisma: PrismaClient;
let householdId: string;
let accountId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  prisma = (await import('../../src/shared/db/prisma.js')).prisma;
  const user = await bootstrapAuthenticatedUser('cron-exclusion-user', 'cron-exclusion@example.com');
  householdId = user.householdId;
  const account = await prisma.account.create({ data: {
    householdId, name: 'Cron exclusion bank', type: 'CHECKING', currency: 'BRL',
    balance: new Prisma.Decimal('100.00'), totalBalance: new Prisma.Decimal('100.00'), availableBalance: new Prisma.Decimal('100.00'),
  } });
  accountId = account.id;
});

afterAll(async () => { await disposeBootstrapTestDb(); });

describe('recurring cron with excluded and late due dates', () => {
  it('skips the scheduled excluded date, advances, and later materializes the due date rather than run date', async () => {
    const { processDueRecurringTransactions } = await import('../../src/jobs/processRecurrences.js');
    const jan10 = new Date('2026-01-10T00:00:00.000Z');
    const schedule = await prisma.recurringTransaction.create({ data: {
      householdId, accountId, categoryName: 'FOOD', amount: new Prisma.Decimal('10.00'),
      frequency: 'MONTHLY', recurrenceMode: 'ALWAYS', anchorDay: 10,
      effectiveFromDate: jan10, startDate: jan10, nextRunAt: jan10, timeZone: 'America/Sao_Paulo',
    } });
    await prisma.recurringOccurrenceExclusion.create({ data: { recurringTransactionId: schedule.id, occurrenceDate: jan10 } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await processDueRecurringTransactions(new Date('2026-01-11T12:00:00.000Z'));
      expect(errorSpy).not.toHaveBeenCalledWith('[CronJob] Recurring transaction failed', expect.anything());
    } finally {
      errorSpy.mockRestore();
    }
    expect((await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: schedule.id } })).nextRunAt.toISOString().slice(0, 10)).toBe('2026-02-10');
    expect(await prisma.transaction.count({ where: { recurringTransactionId: schedule.id } })).toBe(0);

    await processDueRecurringTransactions(new Date('2026-02-11T12:00:00.000Z'));
    const created = await prisma.recurringOccurrence.findMany({ where: { recurringTransactionId: schedule.id } });
    expect(created.map((item) => item.occurrenceDate.toISOString().slice(0, 10))).toEqual(['2026-02-10']);
    expect((await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: schedule.id } })).nextRunAt.toISOString().slice(0, 10)).toBe('2026-03-10');
  });
});
