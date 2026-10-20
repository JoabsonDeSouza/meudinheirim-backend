import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  setTokenVerifier({
    verify: async (token: string) => ({
      uid: token,
      email: `${token}@example.com`,
      emailVerified: true,
    }),
  });
  await bootstrapAuthenticatedUser('category-user', 'category@example.com');
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('v1 custom category identity', () => {
  it('returns a stable CUSTOM:<UUID> code and preserves user-authored name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/categories/custom',
      headers: { authorization: 'Bearer category-user' },
      payload: {
        name: 'Café da Joana',
        type: 'EXPENSE',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      code: string;
      id: string;
      name: string;
      type: string;
      isCustom: boolean;
    };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.code).toBe(`CUSTOM:${body.id}`);
    expect(body.name).toBe('Café da Joana');
    expect(body.type).toBe('EXPENSE');
    expect(body.isCustom).toBe(true);
  });
});
