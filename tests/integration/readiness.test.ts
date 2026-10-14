import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createTestApp } from '../helpers/app.js';
import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;

beforeAll(async () => {
  await getBootstrapTestDb();
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('health and readiness endpoints', () => {
  it('keeps /health as liveness without dependency checks', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('returns 503 and stable code when DB/auth/migrations are not ready', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ready: false,
      code: 'NOT_READY',
    });
    expect(JSON.stringify(response.json()).includes('stack')).toBe(false);
  });

  it('rejects a payload that exceeds the configured body limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/users/me/preferences',
      headers: { 'content-type': 'application/json' },
      payload: `{"padding":"${'x'.repeat(270_000)}"}`,
    });
    expect(response.statusCode).toBe(413);
  });

  it('enforces the configured request rate limit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 24 }, () => app.inject({ method: 'GET', url: '/v1/auth/config' })),
    );
    expect(responses.some((response) => response.statusCode === 429)).toBe(true);
  });
});
