import { createIsolatedTestDb, type IsolatedTestDb } from './test-db.js';

let currentDb: IsolatedTestDb | null = null;

/**
 * Creates (once per test file) an isolated disposable database and configures
 * `process.env.DATABASE_URL` so the application singletons bind to it.
 * The global Prisma cache is cleared so a fresh client connects to the test DB.
 */
export async function getBootstrapTestDb(): Promise<IsolatedTestDb> {
  if (currentDb === null) {
    currentDb = await createIsolatedTestDb();
    process.env.DATABASE_URL = currentDb.url;
    process.env.NODE_ENV = 'test';
    const globalWithCache = globalThis as { __prisma?: unknown };
    delete globalWithCache.__prisma;
  }
  return currentDb;
}

export async function disposeBootstrapTestDb(): Promise<void> {
  if (currentDb !== null) {
    const nextDb = currentDb;
    currentDb = null;
    await nextDb.dispose();
  }
}
