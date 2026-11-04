import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let householdId: string;
let cardAccountId: string;

process.env.TZ = 'America/Sao_Paulo';

async function createTestCard(name: string): Promise<string> {
  const { prisma } = await import('../../src/shared/db/prisma.js');
  const account = await prisma.account.create({
    data: {
      householdId,
      name,
      type: 'CREDIT',
      currency: 'BRL',
      creditLimit: '5000.00',
      totalLimit: '5000.00',
      availableLimit: '5000.00',
      closingDay: 10,
      dueDay: 20,
      balance: '0.00',
      totalBalance: '0.00',
      availableBalance: '0.00',
    },
  });
  return account.id;
}

interface PlanItem {
  id: string;
  version: number;
  installmentId: string;
  invoiceId: string | null;
  amount: { minorUnits: number; currency: string };
}

function planPayload(clientMutationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    householdId,
    clientMutationId,
    kind: 'expense',
    totalAmount: { minorUnits: 3000, currency: 'BRL' },
    categoryCode: 'FOOD',
    accountId: cardAccountId,
    occurredAt: '2026-12-15T12:00:00.000Z',
    timeZone: 'America/Sao_Paulo',
    paid: true,
    plan: { type: 'INSTALLMENTS', count: 3 },
    ...overrides,
  };
}

async function createPlan(clientMutationId: string, overrides: Record<string, unknown> = {}): Promise<{ installmentId: string; items: PlanItem[] }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/transactions/plans',
    headers: { authorization: 'Bearer installments-user' },
    payload: planPayload(clientMutationId, overrides),
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
  const body = response.json() as { installmentId: string; items: PlanItem[] };
  return { installmentId: body.installmentId, items: body.items };
}

async function groupDelete(
  transactionId: string,
  options: {
    clientMutationId: string;
    expectedGroupCount?: number;
    expectedGroupToken?: string;
    householdId?: string;
  },
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  const search = new URLSearchParams({
    clientMutationId: options.clientMutationId,
    deleteScope: 'group',
  });
  if (options.expectedGroupCount !== undefined) search.set('expectedGroupCount', String(options.expectedGroupCount));
  if (options.expectedGroupToken !== undefined) search.set('expectedGroupToken', String(options.expectedGroupToken));
  if (options.householdId !== undefined) search.set('householdId', options.householdId);
  return app.inject({
    method: 'DELETE',
    url: `/v1/transactions/${transactionId}?${search.toString()}`,
    headers: { authorization: 'Bearer installments-user' },
  });
}

async function summaryOf(transactionId: string): Promise<{
  installmentId: string | null;
  isInstallmentGroup: boolean;
  activeCount: number;
  paidCount: number;
  openInvoiceCount: number;
  groupToken: string;
  amounts: Array<{ currency: string; minorUnits: number }>;
}> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/transactions/${transactionId}/installment-summary?householdId=${householdId}`,
    headers: { authorization: 'Bearer installments-user' },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function waitForBlockedAccountLocks(prisma: PrismaClient, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query ILIKE '%SELECT id FROM accounts%'
        AND query ILIKE '%FOR UPDATE%'
    `;
    if (rows[0]?.count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected} account-lock waiters`);
}

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');

  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: `${token}@example.com`, emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('installments-user', 'installments@example.com');
  householdId = user.householdId;
  app = await createTestApp();

  // Personal household of the second user (isolation checks).
  await bootstrapAuthenticatedUser('installments-outsider', 'installments-outsider@example.com');
});

/** Fresh credit card per test: invoices must never leak between tests. */
let cardCounter = 0;
async function useFreshCard(name: string): Promise<void> {
  cardCounter += 1;
  cardAccountId = await createTestCard(`${name} card ${cardCounter}`);
}

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('V1 installment group summary and group delete', () => {
  it('deletes ALL active installments of the same purchase with balance, invoice, sync and idempotency effects', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await useFreshCard('happy group delete');
    const { installmentId, items } = await createPlan('11111111-1111-4111-8111-111111111111');
    expect(items).toHaveLength(3);

    const summary = await summaryOf(items[0].id);
    expect(summary).toMatchObject({
      transactionId: items[0].id,
      installmentId,
      isInstallmentGroup: true,
      activeCount: 3,
      paidCount: 3,
      openInvoiceCount: 3,
      amounts: [{ currency: 'BRL', minorUnits: 3000 }],
    });

    const deleted = await groupDelete(items[0].id, {
      clientMutationId: '22222222-2222-4222-8222-222222222222',
      expectedGroupCount: 3,
      expectedGroupToken: summary.groupToken,
    });
    expect(deleted.statusCode).toBe(200);
    const body = deleted.json() as {
      type: string;
      scope: string;
      installmentId: string;
      deletedCount: number;
      deletedPaidCount: number;
      matchedGroupToken: string;
      items: Array<{ id: string; deletedAt: string | null; version: number }>;
    };
    expect(body.type).toBe('INSTALLMENT_GROUP_DELETE');
    expect(body.scope).toBe('group');
    expect(body.installmentId).toBe(installmentId);
    expect(body.deletedCount).toBe(3);
    expect(body.deletedPaidCount).toBe(3);
    expect(body.matchedGroupToken).toBe(summary.groupToken);
    expect([...body.items].map((item) => item.id).sort()).toEqual([...items].map((item) => item.id).sort());
    expect(body.items.every((item) => item.deletedAt !== null && item.version === 2)).toBe(true);

    // DB: group gone, card balance fully reverted (card started at 0.00), invoice totals rolled back.
    expect(await prisma.transaction.count({ where: { installmentId, deletedAt: null } })).toBe(0);
    const cardAfter = await prisma.account.findUniqueOrThrow({ where: { id: cardAccountId } });
    expect(cardAfter.balance.toFixed(2)).toBe('0.00');
    for (const item of items) {
      const invoice = await prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: item.invoiceId ?? '' } });
      expect(invoice.totalAmount.toFixed(2)).toBe('0.00');
    }

    // Sync changes: one per item, marked deleted.
    const deletedSyncRows = await prisma.syncChange.count({
      where: { householdId, entityType: 'transaction', entityId: { in: items.map((item) => item.id) }, deletedAt: { not: null } },
    });
    expect(deletedSyncRows).toBe(3);

    // Idempotent replay: same clientMutationId returns the stored response.
    const replay = await groupDelete(items[0].id, {
      clientMutationId: '22222222-2222-4222-8222-222222222222',
      expectedGroupCount: 3,
      expectedGroupToken: summary.groupToken,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { deletedCount: number }).deletedCount).toBe(3);

    // Same clientMutationId with a different payload is an idempotency conflict.
    const conflict = await groupDelete(items[0].id, {
      clientMutationId: '22222222-2222-4222-8222-222222222222',
      expectedGroupCount: 4,
      expectedGroupToken: summary.groupToken,
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('preview card for a non-installment transaction reports a single-item non-group snapshot', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await prisma.transaction.create({
      data: {
        householdId,
        type: 'EXPENSE',
        amount: '12.34',
        categoryName: 'FOOD',
        accountId: cardAccountId,
        date: new Date('2026-12-20T00:00:00.000Z'),
        occurredAt: new Date('2026-12-20T12:00:00.000Z'),
        timeZone: 'America/Sao_Paulo',
        clientMutationId: '33333333-3333-4333-8333-333333333333',
      },
    });
    const plain = await prisma.transaction.findFirstOrThrow({ where: { householdId, clientMutationId: '33333333-3333-4333-8333-333333333333' } });
    const summary = await summaryOf(plain.id);
    expect(summary.isInstallmentGroup).toBe(false);
    expect(summary.installmentId).toBeNull();
    expect(summary.activeCount).toBe(1);
    expect(summary.amounts).toEqual([{ currency: 'BRL', minorUnits: 1234 }]);
  });

  it('counts active transaction items on OPEN invoices, not distinct invoice ids', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await useFreshCard('open invoice item count');
    const { items } = await createPlan('77777777-1111-4111-8111-111111111111');
    const invoiceId = items[0].invoiceId;
    if (!invoiceId) throw new Error('missing invoice');
    await prisma.transaction.updateMany({
      where: { id: { in: items.slice(1).map((item) => item.id) } },
      data: { invoiceId },
    });

    const summary = await summaryOf(items[0].id);
    expect(summary.activeCount).toBe(3);
    expect(summary.openInvoiceCount).toBe(3);
  });

  it('rejects the whole group when a concurrent edit makes the confirmation stale, deleting nothing', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const { items } = await createPlan('44444444-4444-4444-8444-444444444444');
    const summary = await summaryOf(items[0].id);

    // Concurrency: one item is edited (amount and version) after confirmation.
    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${items[1].id}?householdId=${householdId}`,
      headers: { authorization: 'Bearer installments-user' },
      payload: {
        clientMutationId: '44444444-4444-4444-8444-444444444445',
        expectedVersion: items[1].version,
        amount: { minorUnits: 999, currency: 'BRL' },
      },
    });
    expect(edited.statusCode).toBe(200);
    const balanceAtAttempt = (await prisma.account.findUniqueOrThrow({ where: { id: cardAccountId } })).balance.toFixed(2);

    const stale = await groupDelete(items[0].id, {
      clientMutationId: '44444444-4444-4444-8444-444444444446',
      expectedGroupCount: 3,
      expectedGroupToken: summary.groupToken,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe('INSTALLMENT_GROUP_CONFLICT');

    // Rejected delete makes NO effect at all: removed exactly nothing.
    expect(await prisma.transaction.count({ where: { installmentId: items[0].installmentId, deletedAt: null } })).toBe(3);
    const cardAfter = await prisma.account.findUniqueOrThrow({ where: { id: cardAccountId } });
    expect(cardAfter.balance.toFixed(2)).toBe(balanceAtAttempt);

    // Re-confirming with a fresh summary completes the group delete.
    const refreshed = await summaryOf(items[0].id);
    expect(refreshed.activeCount).toBe(3);
    expect(refreshed.amounts).toEqual([{ currency: 'BRL', minorUnits: 2999 }]);
    expect(refreshed.groupToken).not.toBe(summary.groupToken);
    const retried = await groupDelete(items[0].id, {
      clientMutationId: '44444444-4444-4444-8444-444444444447',
      expectedGroupCount: 3,
      expectedGroupToken: refreshed.groupToken,
    });
    expect(retried.statusCode).toBe(200);
    expect((retried.json() as { deletedCount: number }).deletedCount).toBe(3);
  });

  it('serializes a paid-item edit against group delete without deadlock or partial effects', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await useFreshCard('edit versus group delete lock order');
    const { items } = await createPlan('78787878-1111-4111-8111-111111111111');
    const summary = await summaryOf(items[0].id);

    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const accountLockHolder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM accounts WHERE id = ${cardAccountId}::uuid FOR UPDATE`;
      signalLocked();
      await release;
    }, { timeout: 15_000 });

    await locked;
    const editPromise = app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${items[1].id}?householdId=${householdId}`,
      headers: { authorization: 'Bearer installments-user' },
      payload: {
        clientMutationId: '78787878-2222-4222-8222-222222222222',
        expectedVersion: items[1].version,
        amount: { minorUnits: 999, currency: 'BRL' },
      },
    });
    await waitForBlockedAccountLocks(prisma, 1);
    const deletePromise = groupDelete(items[0].id, {
      clientMutationId: '78787878-3333-4333-8333-333333333333',
      expectedGroupCount: summary.activeCount,
      expectedGroupToken: summary.groupToken,
    });
    try {
      await waitForBlockedAccountLocks(prisma, 2);
    } finally {
      releaseLock();
    }

    await accountLockHolder;
    const [edit, deletion] = await Promise.all([editPromise, deletePromise]);
    const { prisma: db } = await import('../../src/shared/db/prisma.js');
    const activeCount = await db.transaction.count({ where: { installmentId: items[0].installmentId, deletedAt: null } });
    const balance = (await db.account.findUniqueOrThrow({ where: { id: cardAccountId } })).balance.toFixed(2);

    if (edit.statusCode === 200) {
      expect(deletion.statusCode).toBe(409);
      expect((deletion.json() as { error: { code: string } }).error.code).toBe('INSTALLMENT_GROUP_CONFLICT');
      expect(activeCount).toBe(3);
      expect(balance).toBe('29.99');
    } else {
      expect(edit.statusCode).toBe(409);
      expect(deletion.statusCode).toBe(200);
      expect((deletion.json() as { deletedCount: number }).deletedCount).toBe(3);
      expect(activeCount).toBe(0);
      expect(balance).toBe('0.00');
    }
  });

  it('rejects the whole group when a previously deleted installment makes the count stale, deleting nothing', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await useFreshCard('stale count');
    const { items } = await createPlan('55555555-5555-4555-8555-555555555555');
    const summary = await summaryOf(items[0].id);

    // Individual delete of the last installment shrinks the group behind the user's back.
    const single = await app.inject({
      method: 'DELETE',
      url: `/v1/transactions/${items[2].id}?householdId=${householdId}&clientMutationId=55555555-5555-4555-8555-555555555556&expectedVersion=${items[2].version}`,
      headers: { authorization: 'Bearer installments-user' },
    });
    expect(single.statusCode).toBe(200);
    // Survivors keep the ORIGINAL purchase metadata after an individual delete:
    // installmentTotalAmount and totalInstallments do not mutate, no renumbering.
    const survivor = await prisma.transaction.findFirstOrThrow({ where: { id: items[0].id } });
    expect(survivor.totalInstallments).toBe(3);
    expect(survivor.installmentTotalAmount?.toFixed(2)).toBe('30.00');
    expect(survivor.installmentNumber).toBe(1);
    const balanceAtAttempt = (await prisma.account.findUniqueOrThrow({ where: { id: cardAccountId } })).balance.toFixed(2);

    // Group confirmed with 3 items, but only 2 remain: full rejection, no partial subset.
    const stale = await groupDelete(items[0].id, {
      clientMutationId: '55555555-5555-4555-8555-555555555557',
      expectedGroupCount: 3,
      expectedGroupToken: summary.groupToken,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe('INSTALLMENT_GROUP_CONFLICT');
    expect(await prisma.transaction.count({ where: { installmentId: items[0].installmentId, deletedAt: null } })).toBe(2);
    const cardAfter = await prisma.account.findUniqueOrThrow({ where: { id: cardAccountId } });
    expect(cardAfter.balance.toFixed(2)).toBe(balanceAtAttempt);

    // Confirming the CURRENT 2 active items deletes exactly those two, including past AND future installments.
    const refreshed = await summaryOf(items[0].id);
    const group = await groupDelete(items[0].id, {
      clientMutationId: '55555555-5555-4555-8555-555555555558',
      expectedGroupCount: 2,
      expectedGroupToken: refreshed.groupToken,
    });
    expect(group.statusCode).toBe(200);
    const body = group.json() as { deletedCount: number; items: Array<{ id: string }> };
    expect(body.deletedCount).toBe(2);
    expect(await prisma.transaction.count({ where: { installmentId: items[0].installmentId, deletedAt: null } })).toBe(0);
    expect(await prisma.transaction.count({ where: { installmentId: items[0].installmentId, deletedAt: { not: null } } })).toBe(3);
  });

  it('rejects the whole group with a clear error when any invoice is closed, leaving all items and totals intact', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await useFreshCard('closed invoice');
    const { items } = await createPlan('66666666-6666-4666-8666-666666666666');
    expect(items.map((item) => item.invoiceId).join(',')).not.toContain(',,');
    const balanceBefore = (await prisma.account.findUniqueOrThrow({ where: { id: cardAccountId } })).balance.toFixed(2);

    const closed = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${items[1].invoiceId}/close`,
      headers: { authorization: 'Bearer installments-user' },
      payload: { clientMutationId: '66666666-6666-4666-8666-666666666667', expectedVersion: 1 },
    });
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { status: string }).status).toBe('CLOSED');

    // Summary reflects the closed invoice as not deletable: 1 of 3 items cannot be deleted.
    const refreshed = await summaryOf(items[0].id);
    expect(refreshed.openInvoiceCount).toBe(2);
    expect(refreshed.activeCount).toBe(3);

    const rejected = await groupDelete(items[0].id, {
      clientMutationId: '66666666-6666-4666-8666-666666666668',
      expectedGroupCount: refreshed.activeCount,
      expectedGroupToken: refreshed.groupToken,
    });
    expect(rejected.statusCode).toBe(400);
    expect((rejected.json() as { error: { message: string } }).error.message).toContain('Cannot delete the installment group');
    expect((rejected.json() as { error: { message: string } }).error.message).toContain('closed invoice');

    // No item was deleted, and balances/totals are untouched.
    expect(await prisma.transaction.count({ where: { installmentId: items[0].installmentId, deletedAt: null } })).toBe(3);
    const cardAfter = await prisma.account.findUniqueOrThrow({ where: { id: cardAccountId } });
    expect(cardAfter.balance.toFixed(2)).toBe(balanceBefore);
    const invoiceAfter = await prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: items[0].invoiceId ?? '' } });
    expect(invoiceAfter.status).toBe('OPEN');
  });

  it('requires expectedGroupCount and expectedGroupToken for scope=group and rejects non-installment transactions', async () => {
    await useFreshCard('contract guards');
    const { installmentId, items } = await createPlan('77777777-7777-4777-8777-777777777777');
    void installmentId;
    const missing = await groupDelete(items[0].id, { clientMutationId: '77777777-7777-4777-8777-777777777778' });
    expect(missing.statusCode).toBe(400);

    const wrongOnly = await groupDelete(items[0].id, {
      clientMutationId: '77777777-7777-4777-8777-777777777779',
      expectedGroupCount: 3,
    });
    expect(wrongOnly.statusCode).toBe(400);
    // Non-installment transaction has no group to delete.
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const plain = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { authorization: 'Bearer installments-user' },
      payload: {
        householdId,
        clientMutationId: '88888888-8888-4888-8888-888888888888',
        kind: 'expense',
        amount: { minorUnits: 500, currency: 'BRL' },
        categoryCode: 'FOOD',
        accountId: cardAccountId,
        occurredAt: '2026-12-20T12:00:00.000Z',
        timeZone: 'America/Sao_Paulo',
        paid: true,
      },
    });
    expect(plain.statusCode).toBe(201);
    const plainId = (plain.json() as { id: string }).id;
    const noGroup = await groupDelete(plainId, {
      clientMutationId: '88888888-8888-4888-8888-888888888889',
      expectedGroupCount: 1,
      expectedGroupToken: 'b'.repeat(64),
    });
    expect(noGroup.statusCode).toBe(400);
    expect((noGroup.json() as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    expect(await prisma.transaction.count({ where: { id: plainId, deletedAt: null } })).toBe(1);
  });

  it('isolates groups by household and preserves the legacy individual delete contract', async () => {
    await useFreshCard('isolation legacy');
    const { installmentId, items } = await createPlan('99999999-9999-4999-8999-999999999999');
    void installmentId;

    // Another household cannot see or delete the group (server-side household selection).
    const outsider = await app.inject({
      method: 'DELETE',
      url: `/v1/transactions/${items[0].id}?clientMutationId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&deleteScope=group&expectedGroupCount=3&expectedGroupToken=${'b'.repeat(64)}`,
      headers: { authorization: 'Bearer installments-outsider' },
    });
    expect(outsider.statusCode).toBe(404);

    // Out-of-household householdId is rejected by membership check.
    const foreign = await groupDelete(items[0].id, {
      clientMutationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      expectedGroupCount: 3,
      expectedGroupToken: 'b'.repeat(64),
      householdId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect([403, 404]).toContain(foreign.statusCode);

    // Legacy individual delete (no deleteScope) still works on an installment item.
    const individual = await app.inject({
      method: 'DELETE',
      url: `/v1/transactions/${items[1].id}?householdId=${householdId}&clientMutationId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac&expectedVersion=${items[1].version}`,
      headers: { authorization: 'Bearer installments-user' },
    });
    expect(individual.statusCode).toBe(200);
    expect((individual.json() as { deletedAt: string | null }).deletedAt).toBeTruthy();

    const { prisma } = await import('../../src/shared/db/prisma.js');
    expect(await prisma.transaction.count({ where: { installmentId: items[0].installmentId, deletedAt: null } })).toBe(2);
  });

  it('token identifies the exact member set: swapping members with identical counts, versions and timestamps conflicts', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await useFreshCard('token swap');
    const a = await createPlan('abababab-1111-4111-8111-111111111111');
    const b = await createPlan('abababab-2222-4222-8222-222222222222');
    const summaryA = await summaryOf(a.items[0].id);
    const summaryB = await summaryOf(b.items[0].id);
    expect(summaryA.activeCount).toBe(3);
    expect(summaryB.activeCount).toBe(3);
    expect(summaryA.groupToken).not.toBe(summaryB.groupToken);

    // Swap a member timestamp between the two groups via raw SQL: neither count
    // nor per-item versions change, and the previous naive aggregate (sums) is
    // preserved — only the exact member set is affected.
    await prisma.$executeRaw`UPDATE transactions SET updated_at = (SELECT updated_at FROM transactions WHERE id = ${b.items[0].id}) WHERE id = ${a.items[0].id}`;
    await prisma.$executeRaw`UPDATE transactions SET updated_at = (SELECT updated_at FROM transactions WHERE id = ${a.items[0].id}) WHERE id = ${b.items[0].id}`;

    // The previously confirmed token no longer matches the (modified) group.
    const stale = await groupDelete(a.items[0].id, {
      clientMutationId: 'abababab-3333-4333-8333-333333333331',
      expectedGroupCount: 3,
      expectedGroupToken: summaryA.groupToken,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe('INSTALLMENT_GROUP_CONFLICT');
    expect(await prisma.transaction.count({ where: { installmentId: a.items[0].installmentId, deletedAt: null } })).toBe(3);

    // Fresh summary produces a NEW token; confirming with it succeeds.
    const refreshed = await summaryOf(a.items[0].id);
    expect(refreshed.groupToken).not.toBe(summaryA.groupToken);
    const retried = await groupDelete(a.items[0].id, {
      clientMutationId: 'abababab-3333-4333-8333-333333333332',
      expectedGroupCount: 3,
      expectedGroupToken: refreshed.groupToken,
    });
    expect(retried.statusCode).toBe(200);
    expect((retried.json() as { deletedCount: number }).deletedCount).toBe(3);
    expect(await prisma.transaction.count({ where: { installmentId: b.items[0].installmentId, deletedAt: null } })).toBe(3);
  });

  it('coordinates with the invoice lifecycle: a concurrent close blocks or precedes the delete, never both', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await useFreshCard('invoice lock coordination');
    const { items } = await createPlan('cfcfcfcf-1111-4111-8111-111111111111');
    const summary = await summaryOf(items[0].id);
    const invoiceId = items[1].invoiceId;
    if (!invoiceId) throw new Error('missing invoice');

    // Deterministic race: a separate transaction holds the SAME advisory lock
    // the invoice close flow takes, closes the invoice while the group delete
    // is parked on that lock, and commits to release it. The delete MUST
    // re-read the status after acquiring the lock and reject the whole group.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-lifecycle:${invoiceId}`}))`;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const close = await tx.creditCardInvoice.updateMany({
        where: { id: invoiceId, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: new Date(), version: { increment: 1 } },
      });
      expect(close.count).toBe(1);
      return 'closed-and-committed';
    }, { timeout: 15000 });

    // The delete starts while the lock is held: it acquires its transaction
    // row locks and then parks on the invoice lock until the holder commits.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const outcome = await groupDelete(items[0].id, {
      clientMutationId: 'cfcfcfcf-2222-4222-8222-222222222221',
      expectedGroupCount: 3,
      expectedGroupToken: summary.groupToken,
    });
    expect(await holder).toBe('closed-and-committed');

    expect(outcome.statusCode).toBe(400);
    expect((outcome.json() as { error: { message: string } }).error.message).toContain('closed invoice');
    expect(await prisma.transaction.count({ where: { id: { in: items.map((item) => item.id) }, deletedAt: null } })).toBe(3);
    const cardAfter = await prisma.account.findUniqueOrThrow({ where: { id: cardAccountId } });
    expect(cardAfter.balance.toFixed(2)).toBe('30.00');
  });

  it('does not recreate deleted installments: plans are not persisted and the cron job only processes recurrences', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await useFreshCard('cron non recreation');
    const { installmentId, items } = await createPlan('dededede-1111-4111-8111-111111111111');
    const summary = await summaryOf(items[0].id);

    const group = await groupDelete(items[0].id, {
      clientMutationId: 'dededede-2222-4222-8222-222222222221',
      expectedGroupCount: 3,
      expectedGroupToken: summary.groupToken,
    });
    expect(group.statusCode).toBe(200);

    const activeCountAfterDelete = await prisma.transaction.count({ where: { householdId, deletedAt: null } });
    // Plans for installments materialize EVERY installment at creation and keep
    // only the mutation receipt; no persistent plan row exists to regenerate them.
    expect(await prisma.recurringTransaction.count({ where: { householdId } })).toBe(0);

    const { processDueRecurringTransactions } = await import('../../src/jobs/processRecurrences.js');
    await processDueRecurringTransactions(new Date('2027-06-01T10:00:00.000Z'));

    expect(await prisma.transaction.count({ where: { installmentId, deletedAt: null } })).toBe(0);
    expect(await prisma.transaction.count({ where: { householdId, deletedAt: null } })).toBe(activeCountAfterDelete);
    // The receipt (the only persisted plan artefact) remains, with no side effects.
    const receipt = await prisma.syncMutation.findFirst({ where: { clientMutationId: 'dededede-1111-4111-8111-111111111111' } });
    expect(receipt?.entityType).toBe('transaction_plan');
  });
});
