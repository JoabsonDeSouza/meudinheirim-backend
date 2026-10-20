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
  await bootstrapAuthenticatedUser('account-identity-user', 'identity@example.com');
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('account display identity persistence', () => {
  it('persists optional institution, brand, card network and last4 alongside UUID identity', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer account-identity-user' },
      payload: {
        name: 'Daily Card',
        type: 'CREDIT',
        currency: 'BRL',
        institution: 'Example Bank',
        brand: 'Platinum',
        cardNetwork: 'VISA',
        last4: '0427',
        creditLimit: 3000,
        dueDay: 15,
        closingDay: 8,
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as {
      success: boolean;
      data: {
        id: string;
        currency: string;
        institution: string | null;
        brand: string | null;
        cardNetwork: string | null;
        last4: string | null;
      };
    };
    expect(created.data.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.data.currency).toBe('BRL');
    expect(created.data.institution).toBe('Example Bank');
    expect(created.data.brand).toBe('Platinum');
    expect(created.data.cardNetwork).toBe('VISA');
    expect(created.data.last4).toBe('0427');
  });

  it('rejects unsupported currency and malformed last4 at the API boundary', async () => {
    const unsupportedCurrency = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer account-identity-user' },
      payload: { name: 'Euro', type: 'CHECKING', currency: 'EUR' },
    });
    expect(unsupportedCurrency.statusCode).toBe(400);

    const invalidLast4 = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer account-identity-user' },
      payload: { name: 'Bad Card', type: 'CREDIT', currency: 'BRL', last4: '4A27' },
    });
    expect(invalidLast4.statusCode).toBe(400);
  });
});
