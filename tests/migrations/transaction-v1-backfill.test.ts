import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createIsolatedTestDb, type IsolatedTestDb } from '../helpers/test-db.js';

let db: IsolatedTestDb;
let pool: Pool;

beforeAll(async () => {
  db = await createIsolatedTestDb();
  pool = new Pool({ connectionString: db.url, max: 1 });
});

afterAll(async () => {
  await pool.end();
  await db.dispose();
});

describe('transaction V1 additive migration backfill', () => {
  it('preserves existing civil dates as UTC instants and leaves tombstones unset', async () => {
    await pool.query(`
      CREATE TEMP TABLE transactions (
        id UUID PRIMARY KEY,
        household_id UUID NOT NULL,
        date DATE NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO transactions (id, household_id, date)
       VALUES ($1, $2, DATE '2026-02-03')`,
      ['5a7cde52-ae08-4ce0-92a4-c6a87127e130', 'f531b2aa-0083-4f63-b0d1-5f9f1c3bce43'],
    );

    const migration = readFileSync(
      resolve(process.cwd(), 'prisma/migrations/20261013234500_add_transaction_occurred_tombstone/migration.sql'),
      'utf8',
    );
    await pool.query(migration);

    const row = await pool.query<{ occurred_at: Date; deleted_at: Date | null; time_zone: string }>(
      `SELECT occurred_at, deleted_at, time_zone FROM transactions`,
    );
    expect(row.rows[0].occurred_at.toISOString()).toBe('2026-02-03T00:00:00.000Z');
    expect(row.rows[0].deleted_at).toBeNull();
    expect(row.rows[0].time_zone).toBe('UTC');
  });
});
