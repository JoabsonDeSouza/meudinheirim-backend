import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';

const fixtures = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../../src/shared/db/prisma.js', () => ({
  prisma: { recurringTransaction: { findMany: async () => fixtures.rows } },
}));

import { listRecurringOccurrencesV1 } from '../../src/modules/recurring-transactions/recurring.v1.service.js';

afterEach(() => {
  vi.useRealTimers();
  fixtures.rows = [];
});

describe('fixed expense overdue civil date', () => {
  it('uses the due day rather than the creation day and honors the schedule timezone', async () => {
    fixtures.rows = [{
      id: 'synthetic-schedule', accountId: 'synthetic-account', categoryName: 'FOOD',
      account: { currency: 'BRL' }, occurrences: [], scheduleVersions: [], cancelledAt: null,
      startDate: new Date('2026-11-10T00:00:00.000Z'),
      effectiveFromDate: new Date('2026-11-10T00:00:00.000Z'),
      endDate: null, frequency: 'MONTHLY', anchorDay: 10, recurrenceMode: 'ALWAYS',
      occurrencesLimit: null, occurrencesCountOffset: 0,
      amount: new Prisma.Decimal('73.00'), kind: 'FIXED', description: 'Synthetic', timeZone: 'America/Sao_Paulo',
    }];
    const statuses = async (): Promise<string[]> => {
      const result = await listRecurringOccurrencesV1('synthetic-household', '2026-11-01', '2026-11-30');
      return result.items.map((item) => String(item.status));
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T15:00:00.000Z'));
    expect(await statuses()).toEqual(['SCHEDULED']);
    vi.setSystemTime(new Date('2026-11-11T00:30:00.000Z')); // Nov 10, 21:30 in São Paulo
    expect(await statuses()).toEqual(['SCHEDULED']);
    vi.setSystemTime(new Date('2026-11-11T03:30:00.000Z')); // Nov 11, 00:30 in São Paulo
    expect(await statuses()).toEqual(['OVERDUE']);
  });
});
