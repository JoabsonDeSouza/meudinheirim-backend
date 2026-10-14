import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Prisma } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let pool: Pool;
let transactionId: string;
let householdId: string;

beforeAll(async () => {
  const db = await getBootstrapTestDb();
  pool = new Pool({ connectionString: db.url, max: 1 });
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  const user = await bootstrapAuthenticatedUser('sync-backfill-user', 'sync-backfill@example.com');
  householdId = user.householdId;
  const account = await prisma.account.create({
    data: {
      householdId,
      name: 'Legacy account',
      type: 'CHECKING',
      currency: 'BRL',
    },
  });
  const transaction = await prisma.transaction.create({
    data: {
      householdId,
      type: 'EXPENSE',
      accountId: account.id,
      categoryName: 'FOOD',
      amount: new Prisma.Decimal('12.34'),
      date: new Date('2026-02-03T00:00:00.000Z'),
      occurredAt: new Date('2026-02-03T14:15:16.000Z'),
      timeZone: 'America/Sao_Paulo',
      notes: 'legacy note',
    },
  });
  transactionId = transaction.id;
});

afterAll(async () => {
  await pool.end();
  await disposeBootstrapTestDb();
});

describe('sync/idempotency migration backfill', () => {
  it('preserves an existing transaction and creates a valid initial change event', async () => {
    await pool.query('DROP TABLE sync_changes');
    await pool.query('DROP TABLE sync_mutations');
    await pool.query('ALTER TABLE transactions DROP COLUMN client_mutation_id, DROP COLUMN version');

    const migration = readFileSync(
      resolve(process.cwd(), 'prisma/migrations/20261013235500_add_sync_idempotency_change_feed/migration.sql'),
      'utf8',
    );
    await pool.query(migration);

    const event = await pool.query<{
      sequence: string;
      entityId: string;
      version: number;
      payload: Record<string, unknown>;
    }>(
      `SELECT sequence::text, entity_id::text AS "entityId", version, payload
       FROM sync_changes WHERE household_id = $1 AND entity_id = $2`,
      [householdId, transactionId],
    );
    expect(event.rowCount).toBe(1);
    expect(BigInt(event.rows[0].sequence)).toBeGreaterThan(0n);
    expect(event.rows[0].version).toBe(1);
    expect(event.rows[0].payload).toMatchObject({
      id: transactionId,
      kind: 'expense',
      amount: { minorUnits: 1234, currency: 'BRL' },
      categoryCode: 'FOOD',
      note: 'legacy note',
      timeZone: 'America/Sao_Paulo',
      version: 1,
    });

    const stored = await pool.query<{ amount: string; notes: string }>(
      `SELECT amount::text, notes FROM transactions WHERE id = $1`,
      [transactionId],
    );
    expect(stored.rows[0]).toEqual({ amount: '12.34', notes: 'legacy note' });
  });
});
