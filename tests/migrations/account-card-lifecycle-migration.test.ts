import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let pool: Pool;

beforeAll(async () => {
  const db = await getBootstrapTestDb();
  pool = new Pool({ connectionString: db.url, max: 1 });
});

afterAll(async () => {
  await pool.end();
  await disposeBootstrapTestDb();
});

describe('account card lifecycle migration', () => {
  it('defaults existing accounts to not-primary and constrains one active primary per household/currency', async () => {
    const column = await pool.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'is_primary_card'`,
    );
    expect(column.rows[0]).toMatchObject({ is_nullable: 'NO' });
    expect(column.rows[0]?.column_default).toMatch(/false/i);

    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'accounts_primary_card_household_currency_key'`,
    );
    expect(indexes.rows[0]?.indexdef).toContain('(household_id, currency)');
    expect(indexes.rows[0]?.indexdef).toContain('WHERE (is_primary_card = true)');

    const check = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND conname = 'accounts_primary_card_credit_only'`,
    );
    expect(check.rows).toHaveLength(1);
    const definition = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'accounts'::regclass AND conname = 'accounts_primary_card_credit_only'`,
    );
    expect(definition.rows[0]?.definition).toContain("type = 'CREDIT'");
    expect(definition.rows[0]?.definition).toContain('is_active');
  });
});
