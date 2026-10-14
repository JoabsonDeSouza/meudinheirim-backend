import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let pool: Pool;

beforeAll(async () => {
  const db = await getBootstrapTestDb();
  pool = new Pool({ connectionString: db.url });
});

afterAll(async () => {
  await pool.end();
  await disposeBootstrapTestDb();
});

describe('account display identity migration', () => {
  it('adds nullable presentation fields and format constraints without replacing UUID identity', async () => {
    const result = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'accounts'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [['brand', 'card_network', 'institution', 'last4']],
    );
    expect(result.rows).toEqual([
      { column_name: 'brand', is_nullable: 'YES' },
      { column_name: 'card_network', is_nullable: 'YES' },
      { column_name: 'institution', is_nullable: 'YES' },
      { column_name: 'last4', is_nullable: 'YES' },
    ]);

    const idColumn = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'id'`,
    );
    expect(idColumn.rows[0].data_type).toBe('uuid');

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'accounts'::regclass
         AND conname = ANY($1::text[])
       ORDER BY conname`,
      [['accounts_last4_format_check', 'accounts_currency_supported_check']],
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      'accounts_currency_supported_check',
      'accounts_last4_format_check',
    ]);
  });
});
