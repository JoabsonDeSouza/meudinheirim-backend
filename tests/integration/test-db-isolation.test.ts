import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedTestDb, getBaseTestDatabaseUrl } from '../helpers/test-db.js';

describe('getBaseTestDatabaseUrl', () => {
  const original = process.env.TEST_DATABASE_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TEST_DATABASE_URL;
    } else {
      process.env.TEST_DATABASE_URL = original;
    }
  });

  it('fails fast when TEST_DATABASE_URL is missing', () => {
    delete process.env.TEST_DATABASE_URL;
    expect(() => getBaseTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it('fails fast when TEST_DATABASE_URL is not disposable', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://u:p@prod-db.internal:5432/meudinheirim_prod';
    expect(() => getBaseTestDatabaseUrl()).toThrow(/not a disposable test database/i);
  });
});

describe('createIsolatedTestDb', () => {
  it('creates an isolated database with migrations and disposes it', async () => {
    const db = await createIsolatedTestDb();
    try {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: db.url });
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      expect(tables.rows.length).toBeGreaterThanOrEqual(15);
      await pool.query(`INSERT INTO households (id, name, created_at, updated_at)
        VALUES (gen_random_uuid(), 'harness', now(), now())`);
      const thrown = await pool.query('SELECT count(*)::int AS n FROM households');
      expect(thrown.rows[0].n).toBe(1);
      await pool.end();
    } finally {
      await db.dispose();
    }

    const admin = new (await import('pg')).Pool({ connectionString: db.adminUrl });
    try {
      const missing = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [new URL(db.url).pathname.slice(1)],
      );
      expect(missing.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('creates unique databases per call', async () => {
    const first = await createIsolatedTestDb();
    const second = await createIsolatedTestDb();
    expect(new URL(first.url).pathname).not.toBe(new URL(second.url).pathname);
    await first.dispose();
    await second.dispose();
  });
});
