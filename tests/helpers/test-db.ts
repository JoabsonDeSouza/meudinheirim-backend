import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';

const NON_DISPOSABLE_MESSAGE =
  'TEST_DATABASE_URL is not a disposable test database: it must point at localhost/127.0.0.1 and use a database name starting with "recta_".';

export interface IsolatedTestDb {
  readonly url: string;
  readonly adminUrl: string;
  dispose(): Promise<void>;
}

export function assertDisposableTestDatabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }

  const host = parsed.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1';
  const databaseName = parsed.pathname.replace(/^\//, '');
  const unsafeName = /prod|production|staging|stg/i.test(databaseName);
  const disposableName = databaseName.startsWith('recta_');

  if (!isLoopback || unsafeName || !disposableName) {
    throw new Error(`Unsafe URL "${sanitize(url)}": ${NON_DISPOSABLE_MESSAGE}`);
  }
}

function sanitize(url: string): string {
  return url.replace(/:\/\/[^@]*@/, '://***@');
}

export function getBaseTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Point it at a disposable PostgreSQL instance (localhost only, database name starting with "recta_").',
    );
  }
  assertDisposableTestDatabaseUrl(url);
  return url;
}

export async function createIsolatedTestDb(): Promise<IsolatedTestDb> {
  const base = getBaseTestDatabaseUrl();
  const adminUrl = new URL(base);
  const newDbName = `recta_test_${randomBytes(9).toString('hex')}`;
  adminUrl.pathname = '/postgres';

  const adminPool = new Pool({ connectionString: adminUrl.toString() });

  try {
    await adminPool.query(`CREATE DATABASE "${newDbName}"`);
  } catch (error) {
    await adminPool.end();
    throw new Error(
      `Failed to create disposable test database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const url = new URL(base);
  url.pathname = `/${newDbName}`;

  const deploy = spawnSync(
    'npx',
    ['prisma', 'migrate', 'deploy'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url.toString() },
      encoding: 'utf8',
    },
  );

  if (deploy.status !== 0) {
    await dropDatabase(adminPool, newDbName);
    await adminPool.end();
    throw new Error(
      `Failed to deploy migrations to disposable test database: ${
        [deploy.stdout, deploy.stderr].filter(Boolean).join('\n').slice(-2000)
      }`,
    );
  }

  return {
    url: url.toString(),
    adminUrl: adminUrl.toString(),
    dispose: async () => {
      try {
        const pool = new Pool({
          connectionString: url.toString(),
          database: newDbName,
          ...(() => {
            const u = new URL(url.toString());
            return { host: u.hostname, port: Number(u.port || 5432) };
          })(),
        });
        await pool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [newDbName],
        );
        await pool.end();
      } catch {
        // Database may already be terminating; drop attempt below decides failure.
      }
      const dropPool = new Pool({ connectionString: adminUrl.toString() });
      try {
        await dropDatabase(dropPool, newDbName);
      } finally {
        await dropPool.end();
      }
    },
  };
}

async function dropDatabase(pool: Pool, dbName: string): Promise<void> {
  await pool.query(
    `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
  );
}
