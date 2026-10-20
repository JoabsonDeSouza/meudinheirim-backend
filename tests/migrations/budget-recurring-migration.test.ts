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

describe('budget and recurring occurrence migration', () => {
  it('defaults existing budgets to BRL and enforces currency-separated uniqueness', async () => {
    const budgetCurrency = await pool.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'budgets' AND column_name = 'currency'`,
    );
    expect(budgetCurrency.rows[0].is_nullable).toBe('NO');
    expect(budgetCurrency.rows[0].column_default).toContain('BRL');

    const budgetUnique = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'budgets'::regclass AND contype = 'u'`,
    );
    expect(budgetUnique.rows.map((row) => row.conname)).toContain('budgets_household_id_category_name_month_currency_key');
  });

  it('stores recurrence timezone and unique occurrence identity', async () => {
    const timezone = await pool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'recurring_transactions' AND column_name = 'time_zone'`,
    );
    expect(timezone.rows[0].column_default).toContain('UTC');

    const occurrenceConstraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'recurring_occurrences'::regclass AND contype = 'u'`,
    );
    expect(occurrenceConstraints.rows.map((row) => row.conname)).toContain('recurring_occurrences_recurring_date_key');
  });
});
