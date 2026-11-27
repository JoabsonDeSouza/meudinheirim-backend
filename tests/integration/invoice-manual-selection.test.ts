import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let householdId: string;
const TZ = 'America/Sao_Paulo';
const auth = { authorization: 'Bearer invoice-selection-user' };

beforeAll(async () => {
  await getBootstrapTestDb();
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const db = await import('../../src/shared/db/prisma.js');
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { createTestApp } = await import('../helpers/app.js');
  prisma = db.prisma;
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: 'invoice-selection@example.com', emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('invoice-selection-user', 'invoice-selection@example.com');
  householdId = user.householdId;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

interface Cycle { periodStart: string; periodEnd: string; dueDate: string }

async function cycles(): Promise<Cycle[]> {
  const { billingCycleWindow } = await import('../../src/modules/credit-cards/domain/billing-cycle.js');
  return billingCycleWindow(new Date().toISOString(), 15, 20, TZ, 3);
}

/** Local noon in São Paulo as the UTC instant the API expects (zod datetime accepts only Z). */
function noonOf(day: string): string {
  return new Date(`${day}T15:00:00.000Z`).toISOString();
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createCard(name: string): Promise<string> {
  const card = await prisma.account.create({
    data: {
      householdId,
      name,
      type: 'CREDIT',
      currency: 'BRL',
      creditLimit: new Prisma.Decimal('5000.00'),
      totalLimit: new Prisma.Decimal('5000.00'),
      availableLimit: new Prisma.Decimal('5000.00'),
      closingDay: 15,
      dueDay: 20,
    },
  });
  return card.id;
}

async function createInvoice(cardAccountId: string, cycle: Cycle, status: 'OPEN' | 'CLOSED' | 'PAID', totalAmount = '0.00'): Promise<string> {
  const invoice = await prisma.creditCardInvoice.create({
    data: {
      householdId,
      cardAccountId,
      periodStart: new Date(`${cycle.periodStart}T00:00:00.000Z`),
      periodEnd: new Date(`${cycle.periodEnd}T00:00:00.000Z`),
      dueDate: new Date(`${cycle.dueDate}T00:00:00.000Z`),
      status,
      currency: 'BRL',
      totalAmount: new Prisma.Decimal(totalAmount),
      closedAt: status === 'OPEN' ? null : new Date(),
      paidAt: status === 'PAID' ? new Date() : null,
    },
  });
  return invoice.id;
}

async function invoiceTotal(invoiceId: string): Promise<string> {
  return (await prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: invoiceId } })).totalAmount.toFixed(2);
}

function chargeBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    householdId,
    clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000001',
    kind: 'expense',
    amount: { minorUnits: 5000, currency: 'BRL' },
    categoryCode: 'FOOD',
    occurredAt: noonOf('2026-11-16'),
    timeZone: TZ,
    paid: false,
    ...overrides,
  };
}

async function postCharge(accountId: string, overrides: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/transactions',
    headers: auth,
    payload: chargeBody({ accountId, ...overrides }),
  });
}

describe('manual invoice selection on card charges', () => {
  it('uses an explicit OPEN invoice over the purchase date and creates no automatic invoice', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection explicit card');
    const target = await createInvoice(cardId, window[1]!, 'OPEN');
    const response = await postCharge(cardId, {
      invoiceId: target,
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000002',
      occurredAt: noonOf(window[0]!.periodStart),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      invoiceId: target,
      occurredAt: expect.any(String),
      invoicePeriod: { periodStart: window[1]!.periodStart, status: 'OPEN' },
    });
    expect(await invoiceTotal(target)).toBe('50.00');
    expect(await prisma.creditCardInvoice.count({ where: { cardAccountId: cardId } })).toBe(1);
  });

  it('accepts a CLOSED unpaid invoice and refuses a PAID one with INVOICE_PAID, changing nothing', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection closed and paid card');
    const closed = await createInvoice(cardId, window[1]!, 'CLOSED');
    const paid = await createInvoice(cardId, window[2]!, 'PAID', '100.00');

    const accepted = await postCharge(cardId, {
      invoiceId: closed,
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000003',
    });
    expect(accepted.statusCode).toBe(201);
    expect(await invoiceTotal(closed)).toBe('50.00');

    const refused = await postCharge(cardId, {
      invoiceId: paid,
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000004',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('INVOICE_PAID');
    expect(await invoiceTotal(paid)).toBe('100.00');
  });

  it('creates a not-yet-created future cycle from billingPeriodStart and refuses a second create for it', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection future card');
    const first = await postCharge(cardId, {
      billingPeriodStart: window[1]!.periodStart,
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000005',
    });
    expect(first.statusCode).toBe(201);
    const created = await prisma.creditCardInvoice.findFirstOrThrow({ where: { cardAccountId: cardId } });
    expect(created.periodStart.toISOString().slice(0, 10)).toBe(window[1]!.periodStart);
    expect(created.status).toBe('OPEN');
    expect(first.json().invoiceId).toBe(created.id);
    expect(created.totalAmount.toFixed(2)).toBe('50.00');

    const second = await postCharge(cardId, {
      billingPeriodStart: window[1]!.periodStart,
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000006',
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('BAD_REQUEST');
    expect(await prisma.creditCardInvoice.count({ where: { cardAccountId: cardId } })).toBe(1);
  });

  it('refuses billingPeriodStart outside the selectable window or that is not a cycle start', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection window card');
    const outsideWindow = await postCharge(cardId, {
      billingPeriodStart: addDays(window[3]!.periodEnd, 2),
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000007',
    });
    expect(outsideWindow.statusCode).toBe(400);
    expect(outsideWindow.json().error.code).toBe('BAD_REQUEST');

    const notStart = await postCharge(cardId, {
      billingPeriodStart: addDays(window[1]!.periodStart, 3),
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000008',
    });
    expect(notStart.statusCode).toBe(400);
    expect(notStart.json().error.code).toBe('BAD_REQUEST');
    expect(await prisma.creditCardInvoice.count({ where: { cardAccountId: cardId } })).toBe(0);
  });

  it('rejects both selectors together, selection on a bank account, and another card invoice', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection validation card');
    const otherCardId = await createCard('Selection other card');
    const foreign = await createInvoice(otherCardId, window[1]!, 'OPEN');
    const own = await createInvoice(cardId, window[1]!, 'OPEN');

    const both = await postCharge(cardId, {
      invoiceId: own,
      billingPeriodStart: window[2]!.periodStart,
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000009',
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe('VALIDATION_ERROR');

    const bank = await prisma.account.create({
      data: { householdId, name: 'Selection bank', type: 'CHECKING', currency: 'BRL', balance: new Prisma.Decimal('0.00'), availableBalance: new Prisma.Decimal('0.00'), totalBalance: new Prisma.Decimal('0.00'), allocatedBalance: new Prisma.Decimal('0.00') },
    });
    const onBank = await postCharge(bank.id, {
      invoiceId: own,
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-00000000000a',
    });
    expect(onBank.statusCode).toBe(400);
    expect(onBank.json().error.code).toBe('BAD_REQUEST');

    const crossCard = await postCharge(cardId, {
      invoiceId: foreign,
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-00000000000b',
    });
    expect(crossCard.statusCode).toBe(404);
    expect(crossCard.json().error.code).toBe('NOT_FOUND');
    expect(await invoiceTotal(foreign)).toBe('0.00');
  });

  it('keeps one charge on replay and conflicts when the same clientMutationId carries another selection', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection idempotency card');
    const first = await createInvoice(cardId, window[1]!, 'OPEN');
    const second = await createInvoice(cardId, window[2]!, 'OPEN');
    const mutation = '6a1b2c3d-4e5f-4061-8273-00000000000c';

    const created = await postCharge(cardId, { invoiceId: first, clientMutationId: mutation });
    expect(created.statusCode).toBe(201);
    const replay = await postCharge(cardId, { invoiceId: first, clientMutationId: mutation });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(created.json().id);
    expect(await invoiceTotal(first)).toBe('50.00');

    const conflict = await postCharge(cardId, { invoiceId: second, clientMutationId: mutation });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await invoiceTotal(second)).toBe('0.00');
  });

  it('creates a single invoice when two concurrent charges select the same not-yet-created cycle', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection concurrency card');
    const [a, b] = await Promise.all([
      postCharge(cardId, { billingPeriodStart: window[1]!.periodStart, clientMutationId: '6a1b2c3d-4e5f-4061-8273-00000000000d' }),
      postCharge(cardId, { billingPeriodStart: window[1]!.periodStart, clientMutationId: '6a1b2c3d-4e5f-4061-8273-00000000000e' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 400]);
    expect(await prisma.creditCardInvoice.count({ where: { cardAccountId: cardId } })).toBe(1);
    const invoice = await prisma.creditCardInvoice.findFirstOrThrow({ where: { cardAccountId: cardId } });
    expect(invoice.totalAmount.toFixed(2)).toBe('50.00');
  });

  it('routes and dates a UTC-midnight instant by its local day, and keeps the real date for a local-noon instant', async () => {
    const cardId = await createCard('Selection timezone card');
    const utcMidnight = await postCharge(cardId, {
      occurredAt: '2026-11-15T00:00:00.000Z',
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-00000000000f',
    });
    expect(utcMidnight.statusCode).toBe(201);
    expect(utcMidnight.json().invoicePeriod).toMatchObject({ periodStart: '2026-10-15', periodEnd: '2026-11-15' });
    const storedUtc = await prisma.transaction.findUniqueOrThrow({ where: { id: utcMidnight.json().id as string } });
    expect(storedUtc.date.toISOString().slice(0, 10)).toBe('2026-11-14');

    const localNoon = await postCharge(cardId, {
      occurredAt: '2026-11-15T15:00:00.000Z',
      clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000010',
    });
    expect(localNoon.statusCode).toBe(201);
    expect(localNoon.json().invoicePeriod).toMatchObject({ periodStart: '2026-11-15', periodEnd: '2026-12-15' });
  });

  it('PATCH moves an explicit choice, keeps it on amount-only edits, refuses leaving a PAID invoice, and returns to automatic on null', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection patch card');
    const first = await createInvoice(cardId, window[1]!, 'OPEN');
    const second = await createInvoice(cardId, window[2]!, 'OPEN');
    const created = await postCharge(cardId, { invoiceId: first, clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000011' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    let version = created.json().version as number;

    const amountOnly = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${id}?householdId=${householdId}`,
      headers: auth,
      payload: { clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000012', expectedVersion: version, amount: { minorUnits: 8000, currency: 'BRL' } },
    });
    expect(amountOnly.statusCode).toBe(200);
    version = amountOnly.json().version as number;
    expect(await invoiceTotal(first)).toBe('80.00');

    const moved = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${id}?householdId=${householdId}`,
      headers: auth,
      payload: { clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000013', expectedVersion: version, invoiceId: second },
    });
    expect(moved.statusCode).toBe(200);
    version = moved.json().version as number;
    expect(moved.json().invoiceId).toBe(second);
    expect(await invoiceTotal(first)).toBe('0.00');
    expect(await invoiceTotal(second)).toBe('80.00');

    const backToAutomatic = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${id}?householdId=${householdId}`,
      headers: auth,
      payload: { clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000014', expectedVersion: version, invoiceId: null, occurredAt: noonOf(window[1]!.periodStart) },
    });
    expect(backToAutomatic.statusCode).toBe(200);
    expect(backToAutomatic.json().invoicePeriod).toMatchObject({ periodStart: window[1]!.periodStart });
    expect(await invoiceTotal(second)).toBe('0.00');
    expect(await invoiceTotal(backToAutomatic.json().invoiceId as string)).toBe('80.00');
    version = backToAutomatic.json().version as number;

    await prisma.creditCardInvoice.update({ where: { id: backToAutomatic.json().invoiceId as string }, data: { status: 'PAID', paidAt: new Date() } });
    const leavingPaid = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${id}?householdId=${householdId}`,
      headers: auth,
      payload: { clientMutationId: '6a1b2c3d-4e5f-4061-8273-000000000015', expectedVersion: version, invoiceId: second },
    });
    expect(leavingPaid.statusCode).toBe(400);
    expect(leavingPaid.json().error.code).toBe('INVOICE_PAID');
  });

  it('lists OPEN and CLOSED unpaid invoices, hides PAID, adds not-created cycles, and reports the automatic invoice', async () => {
    const window = await cycles();
    const cardId = await createCard('Selection eligible card');
    const closedPrevious = await createInvoice(cardId, { periodStart: addDays(window[0]!.periodStart, -30), periodEnd: window[0]!.periodStart, dueDate: addDays(window[0]!.periodStart, 5) }, 'CLOSED');
    const openNext = await createInvoice(cardId, window[2]!, 'OPEN');
    const paidNext = await createInvoice(cardId, window[1]!, 'PAID', '90.00');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/credit-cards/eligible-invoices?householdId=${householdId}&cardAccountId=${cardId}&timeZone=${encodeURIComponent(TZ)}&occurredAt=${encodeURIComponent(noonOf(window[1]!.periodStart))}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ invoiceId: string | null; status: string; billingPeriodStart: string; exists: boolean }>; automatic: { invoiceId: string | null; status: string } };

    const ids = body.items.map((item) => item.invoiceId);
    expect(ids).toContain(closedPrevious);
    expect(ids).toContain(openNext);
    expect(ids).not.toContain(paidNext);
    const notCreated = body.items.filter((item) => !item.exists);
    expect(notCreated.every((item) => item.invoiceId === null && item.status === 'NOT_CREATED')).toBe(true);
    expect(notCreated.map((item) => item.billingPeriodStart)).toContain(window[0]!.periodStart);
    expect(notCreated.map((item) => item.billingPeriodStart)).toContain(window[3]!.periodStart);

    expect(body.automatic).toMatchObject({ invoiceId: paidNext, status: 'PAID' });
    const sorted = body.items.map((item) => item.billingPeriodStart);
    expect(sorted).toEqual([...sorted].sort().reverse());
  });
});
