import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';
import { createTestApp } from '../helpers/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  setTokenVerifier({
    verify: async token => ({ uid: token, email: 'preferences-user@example.com', emailVerified: true }),
  });
  await bootstrapAuthenticatedUser('preferences-user', 'preferences-user@example.com');
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('user preferences API', () => {
  it('accepts and returns typed locale and base currency preferences', async () => {
    const update = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/preferences',
      headers: { authorization: 'Bearer preferences-user' },
      payload: {
        baseCurrency: 'USD',
        locale: 'en-US',
        theme: 'dark',
        displayName: 'Taylor',
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data).toMatchObject({
      baseCurrency: 'USD',
      locale: 'en-US',
      theme: 'dark',
      displayName: 'Taylor',
    });

    const current = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer preferences-user' },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().data).toMatchObject({ baseCurrency: 'USD', locale: 'en-US' });
  });

  it('rejects unsupported currency and does not change stored preferences', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/preferences',
      headers: { authorization: 'Bearer preferences-user' },
      payload: { baseCurrency: 'EUR' },
    });
    expect(response.statusCode).toBe(400);
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const user = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'preferences-user' } });
    expect(user.baseCurrency).toBe('USD');
    expect(user.locale).toBe('en-US');
  });
});
