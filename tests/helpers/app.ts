import type { FastifyInstance } from 'fastify';

import { getBaseTestDatabaseUrl } from './test-db.js';

let envConfigured = false;

function ensureTestEnv(): void {
  if (envConfigured) return;
  const testDbUrl = getBaseTestDatabaseUrl();
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testDbUrl;
  process.env.RATE_LIMIT_MAX = '1000';
  envConfigured = true;
}

/**
 * Builds the application under test with an environment suitable for tests.
 * The base URL must remain untouched by tests; app boot failures surface as-is.
 */
export async function createTestApp(): Promise<FastifyInstance> {
  ensureTestEnv();
  const { buildApp } = await import('../../src/app.js');
  return buildApp();
}
