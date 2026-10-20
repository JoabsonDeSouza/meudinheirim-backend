import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let householdId: string;
let nextId = 0;
let databaseUrl: string;

beforeAll(async () => {
  const database = await getBootstrapTestDb();
  databaseUrl = database.url;
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: `${token}@example.com`, emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('invoice-user', 'invoice-user@example.com');
  householdId = user.householdId;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

interface InvoiceFixture {
  readonly invoiceId: string;
  readonly bankAccountId: string;
  readonly cardAccountId: string;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function createInvoiceFixture(): Promise<InvoiceFixture> {
  nextId += 1;
  const cardResponse = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: { authorization: 'Bearer invoice-user' },
    payload: {
      householdId,
      name: `Invoice card ${nextId}`,
      type: 'CREDIT',
      currency: 'BRL',
      creditLimit: 5000,
      closingDay: 8,
      dueDay: 15,
    },
  });
  const cardAccountId = (cardResponse.json() as { data: { id: string } }).data.id;
  const bankResponse = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: { authorization: 'Bearer invoice-user' },
    payload: {
      householdId,
      name: `Invoice bank ${nextId}`,
      type: 'CHECKING',
      currency: 'BRL',
      balance: 100,
    },
  });
  const bankAccountId = (bankResponse.json() as { data: { id: string } }).data.id;
  const purchase = await app.inject({
    method: 'POST',
    url: '/v1/transactions',
    headers: { authorization: 'Bearer invoice-user' },
    payload: {
      householdId,
      clientMutationId: `12345678-90ab-4cde-8f01-${(nextId + 100).toString().padStart(12, '0')}`,
      kind: 'expense',
      amount: { minorUnits: 2500, currency: 'BRL' },
      categoryCode: 'FOOD',
      accountId: cardAccountId,
      occurredAt: '2026-11-09T12:00:00.000Z',
      timeZone: 'America/Sao_Paulo',
      paid: true,
    },
  });
  const invoiceId = (purchase.json() as { invoiceId: string }).invoiceId;
  return { invoiceId, bankAccountId, cardAccountId };
}

function closePayload(clientMutationId: string, expectedVersion = 1): { clientMutationId: string; expectedVersion: number } {
  return { clientMutationId, expectedVersion };
}

describe('persisted invoice lifecycle', () => {
  it('closes, pays and refunds an invoice once with atomic account and transaction effects', async () => {
    const fixture = await createInvoiceFixture();
    const closed = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/close`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: closePayload('22345678-90ab-4cde-8f01-1234567890ab'),
    });
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { status: string }).status).toBe('CLOSED');

    const payPayload = {
      clientMutationId: '33456789-0abc-4def-8012-234567890abc',
      expectedVersion: 2,
      sourceAccountId: fixture.bankAccountId,
      expectedSourceVersion: 1,
      expectedCardVersion: 2,
      amount: { minorUnits: 2500, currency: 'BRL' },
      timeZone: 'America/Sao_Paulo',
    };
    const paid = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/pay`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: payPayload,
    });
    expect(paid.statusCode).toBe(200);
    const paidDto = paid.json() as { status: string; paymentId: string; transactionId: string; version: number };
    expect(paidDto.status).toBe('PAID');
    expect(paidDto.version).toBe(3);

    const payReplay = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/pay`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: payPayload,
    });
    expect(payReplay.statusCode).toBe(200);
    expect((payReplay.json() as { paymentId: string }).paymentId).toBe(paidDto.paymentId);

    const refundPayload = {
      clientMutationId: '44567890-1bcd-4efa-9123-34567890abcd',
      expectedVersion: 3,
      paymentId: paidDto.paymentId,
      expectedSourceVersion: 2,
      expectedCardVersion: 3,
      timeZone: 'America/Sao_Paulo',
    };
    const refunded = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/refund`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: refundPayload,
    });
    expect(refunded.statusCode).toBe(200);
    expect((refunded.json() as { status: string }).status).toBe('CLOSED');

    const { prisma } = await import('../../src/shared/db/prisma.js');
    const [bank, card, invoice, payment] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id: fixture.bankAccountId } }),
      prisma.account.findUniqueOrThrow({ where: { id: fixture.cardAccountId } }),
      prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } }),
      prisma.invoicePayment.findUniqueOrThrow({ where: { transactionId: paidDto.transactionId } }),
    ]);
    expect(bank.availableBalance.toFixed(2)).toBe('100.00');
    expect(card.balance.toFixed(2)).toBe('25.00');
    expect(invoice.status).toBe('CLOSED');
    expect(payment.refundedAt).not.toBeNull();
    expect(payment.refundTransactionId).toBeTruthy();
  });

  it('rejects invalid close/pay transitions and currency mismatch', async () => {
    const fixture = await createInvoiceFixture();
    const beforeClosePay = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/pay`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: {
        clientMutationId: '55678901-2cde-4fab-a234-4567890abcde',
        expectedVersion: 1,
        sourceAccountId: fixture.bankAccountId,
        expectedSourceVersion: 1,
        expectedCardVersion: 2,
        amount: { minorUnits: 2500, currency: 'BRL' },
        timeZone: 'America/Sao_Paulo',
      },
    });
    expect(beforeClosePay.statusCode).toBe(409);

    const closed = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/close`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: closePayload('66789012-3def-40bc-a345-567890abcdef'),
    });
    expect(closed.statusCode).toBe(200);

    const currencyMismatch = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/pay`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: {
        clientMutationId: '77890123-4efa-41cd-b456-67890abcdef1',
        expectedVersion: 2,
        sourceAccountId: fixture.bankAccountId,
        expectedSourceVersion: 1,
        expectedCardVersion: 2,
        amount: { minorUnits: 2500, currency: 'USD' },
        timeZone: 'America/Sao_Paulo',
      },
    });
    expect(currencyMismatch.statusCode).toBe(400);
  });

  it('serializes concurrent invoice closes and returns a version conflict for the loser', async () => {
    const fixture = await createInvoiceFixture();
    const close = (clientMutationId: string): Promise<InjectResponse> => app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/close`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: closePayload(clientMutationId),
    });
    const responses = await Promise.all([
      close('88901234-5fab-42de-c567-7890abcdef12'),
      close('99012345-6abc-43ef-d678-890abcdef123'),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('serializes concurrent payments and applies account and payment effects only once', async () => {
    const fixture = await createInvoiceFixture();
    const closed = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/close`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: closePayload('dd123456-7bcd-44ef-8012-34567890abcd'),
    });
    expect(closed.statusCode).toBe(200);

    const pay = (clientMutationId: string): Promise<InjectResponse> => app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/pay`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: {
        clientMutationId,
        expectedVersion: 2,
        sourceAccountId: fixture.bankAccountId,
        expectedSourceVersion: 1,
        expectedCardVersion: 2,
        amount: { minorUnits: 2500, currency: 'BRL' },
        timeZone: 'America/Sao_Paulo',
      },
    });
    const responses = await Promise.all([
      pay('ee123456-7bcd-44ef-8012-34567890abcd'),
      pay('ff123456-7bcd-44ef-8012-34567890abcd'),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const { prisma } = await import('../../src/shared/db/prisma.js');
    const [bank, card, invoice, payments] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id: fixture.bankAccountId } }),
      prisma.account.findUniqueOrThrow({ where: { id: fixture.cardAccountId } }),
      prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } }),
      prisma.invoicePayment.count({ where: { invoiceId: fixture.invoiceId } }),
    ]);
    expect(bank.availableBalance.toFixed(2)).toBe('75.00');
    expect(card.balance.toFixed(2)).toBe('0.00');
    expect(invoice.status).toBe('PAID');
    expect(invoice.version).toBe(3);
    expect(payments).toBe(1);
  });

  it('does not expose another household invoice to a non-member', async () => {
    const fixture = await createInvoiceFixture();
    const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
    await bootstrapAuthenticatedUser('invoice-outsider', 'invoice-outsider@example.com');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/close?householdId=${householdId}`,
      headers: { authorization: 'Bearer invoice-outsider' },
      payload: closePayload('aa123456-7bcd-44ef-8012-34567890abcd'),
    });
    expect([403, 404]).toContain(response.statusCode);
  });

  it('rolls back account, invoice, payment, and transaction changes if payment transaction insertion fails', async () => {
    const fixture = await createInvoiceFixture();
    const closed = await app.inject({
      method: 'POST',
      url: `/v1/credit-cards/invoices/${fixture.invoiceId}/close`,
      headers: { authorization: 'Bearer invoice-user' },
      payload: closePayload('bb123456-7bcd-44ef-8012-34567890abcd'),
    });
    expect(closed.statusCode).toBe(200);

    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION reject_invoice_payment_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.type = 'TRANSFER' THEN RAISE EXCEPTION 'injected invoice transaction failure'; END IF;
          RETURN NEW;
        END;
        $$
      `);
      await pool.query(`CREATE TRIGGER reject_invoice_payment_insert BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION reject_invoice_payment_insert()`);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/credit-cards/invoices/${fixture.invoiceId}/pay`,
        headers: { authorization: 'Bearer invoice-user' },
        payload: {
          clientMutationId: 'cc123456-7bcd-44ef-8012-34567890abcd',
          expectedVersion: 2,
          sourceAccountId: fixture.bankAccountId,
          expectedSourceVersion: 1,
          expectedCardVersion: 2,
          amount: { minorUnits: 2500, currency: 'BRL' },
          timeZone: 'America/Sao_Paulo',
        },
      });
      expect(response.statusCode).toBe(500);
      const { prisma } = await import('../../src/shared/db/prisma.js');
      const [bank, card, invoice, payments, transferCount] = await Promise.all([
        prisma.account.findUniqueOrThrow({ where: { id: fixture.bankAccountId } }),
        prisma.account.findUniqueOrThrow({ where: { id: fixture.cardAccountId } }),
        prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } }),
        prisma.invoicePayment.count({ where: { invoiceId: fixture.invoiceId } }),
        prisma.transaction.count({ where: { invoiceId: fixture.invoiceId, type: 'TRANSFER' } }),
      ]);
      expect(bank.availableBalance.toFixed(2)).toBe('100.00');
      expect(card.balance.toFixed(2)).toBe('25.00');
      expect(invoice.status).toBe('CLOSED');
      expect(invoice.version).toBe(2);
      expect(payments).toBe(0);
      expect(transferCount).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS reject_invoice_payment_insert ON transactions');
      await pool.query('DROP FUNCTION IF EXISTS reject_invoice_payment_insert()');
      await pool.end();
    }
  });
});
