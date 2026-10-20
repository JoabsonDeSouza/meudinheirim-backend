import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let pool: Pool;
let prisma: PrismaClient;
let householdId: string;
let cardId: string;
let purchaseId: string;
let paymentId: string;
let unknownAttachmentId: string;

beforeAll(async () => {
  const db = await getBootstrapTestDb();
  pool = new Pool({ connectionString: db.url, max: 1 });
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const prismaModule = await import('../../src/shared/db/prisma.js');
  prisma = prismaModule.prisma;
  const user = await bootstrapAuthenticatedUser('invoice-migration-user', 'invoice-migration@example.com');
  householdId = user.householdId;

  const card = await prisma.account.create({
    data: {
      householdId,
      name: 'Migration card',
      type: 'CREDIT',
      currency: 'BRL',
      closingDay: 8,
      dueDay: 15,
      creditLimit: new Prisma.Decimal('5000.00'),
    },
  });
  cardId = card.id;
  const bank = await prisma.account.create({
    data: {
      householdId,
      name: 'Migration bank',
      type: 'CHECKING',
      currency: 'BRL',
    },
  });
  const purchase = await prisma.transaction.create({
    data: {
      householdId,
      type: 'EXPENSE',
      accountId: card.id,
      categoryName: 'FOOD',
      amount: new Prisma.Decimal('40.00'),
      date: new Date('2026-10-07T00:00:00.000Z'),
      occurredAt: new Date('2026-10-07T15:00:00.000Z'),
      timeZone: 'America/Sao_Paulo',
    },
  });
  purchaseId = purchase.id;
  const payment = await prisma.transaction.create({
    data: {
      householdId,
      type: 'EXPENSE',
      accountId: bank.id,
      categoryName: 'OTHER_EXPENSES',
      amount: new Prisma.Decimal('40.00'),
      date: new Date('2026-10-15T00:00:00.000Z'),
      occurredAt: new Date('2026-10-15T15:00:00.000Z'),
      timeZone: 'America/Sao_Paulo',
      attachmentUrl: `invoice_pay:${card.id}:2026-9`,
    },
  });
  paymentId = payment.id;
  const unknown = await prisma.transaction.create({
    data: {
      householdId,
      type: 'EXPENSE',
      accountId: bank.id,
      categoryName: 'OTHER_EXPENSES',
      amount: new Prisma.Decimal('1.00'),
      date: new Date('2026-10-16T00:00:00.000Z'),
      occurredAt: new Date('2026-10-16T15:00:00.000Z'),
      timeZone: 'America/Sao_Paulo',
      attachmentUrl: 'https://legacy.example/receipt.png',
    },
  });
  unknownAttachmentId = unknown.id;
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
  await disposeBootstrapTestDb();
});

describe('invoice migration of legacy payment references', () => {
  it('links purchases and identifiable payments, quarantines unknown references, and preserves ledger rows', async () => {
    await pool.query('DROP TABLE invoice_payments CASCADE');
    await pool.query('DROP TABLE invoice_migration_issues CASCADE');
    await pool.query('DROP TABLE credit_card_invoices CASCADE');
    await pool.query('ALTER TABLE transactions DROP COLUMN invoice_id');
    await pool.query('DROP TYPE "InvoiceStatus"');

    const migration = readFileSync(
      resolve(process.cwd(), 'prisma/migrations/20261014002000_create_credit_card_invoices/migration.sql'),
      'utf8',
    );
    await pool.query(migration);

    const invoice = await pool.query<{
      id: string;
      period_start: string;
      period_end: string;
      due_date: string;
      status: string;
      total_amount: string;
      payment_transaction_id: string | null;
    }>(
      `SELECT i.id, i.period_start::text, i.period_end::text, i.due_date::text,
              i.status::text, i.total_amount::text, p.transaction_id::text AS payment_transaction_id
       FROM credit_card_invoices i
       LEFT JOIN invoice_payments p ON p.invoice_id = i.id
       WHERE i.card_account_id = $1`,
      [cardId],
    );
    expect(invoice.rowCount).toBe(1);
    expect(invoice.rows[0]).toMatchObject({
      period_start: '2026-09-08',
      period_end: '2026-10-08',
      due_date: '2026-10-15',
      status: 'PAID',
      total_amount: '40.00',
      payment_transaction_id: paymentId,
    });

    const linked = await pool.query<{ id: string; invoice_id: string | null; attachment_url: string | null }>(
      `SELECT id::text, invoice_id::text, attachment_url FROM transactions WHERE id = ANY($1::uuid[])`,
      [[purchaseId, paymentId, unknownAttachmentId]],
    );
    const purchaseRow = linked.rows.find((row) => row.id === purchaseId);
    const paymentRow = linked.rows.find((row) => row.id === paymentId);
    const unknownRow = linked.rows.find((row) => row.id === unknownAttachmentId);
    expect(purchaseRow?.invoice_id).toBe(invoice.rows[0].id);
    expect(paymentRow?.invoice_id).toBe(invoice.rows[0].id);
    expect(paymentRow?.attachment_url).toBeNull();
    expect(unknownRow?.attachment_url).toBeNull();

    const issue = await pool.query<{ reason: string; legacy_value: string }>(
      `SELECT reason, legacy_value FROM invoice_migration_issues WHERE transaction_id = $1`,
      [unknownAttachmentId],
    );
    expect(issue.rows[0]).toEqual({
      reason: 'UNRECOGNIZED_ATTACHMENT_REFERENCE',
      legacy_value: 'https://legacy.example/receipt.png',
    });

    const invoiceConstraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'credit_card_invoices'::regclass AND contype = 'u'`,
    );
    expect(invoiceConstraints.rows.map((row) => row.conname)).toContain('credit_card_invoices_card_period_start_key');
    const paymentConstraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'invoice_payments'::regclass AND contype = 'u'`,
    );
    expect(paymentConstraints.rows.map((row) => row.conname)).toContain('invoice_payments_transaction_id_key');
  });
});
