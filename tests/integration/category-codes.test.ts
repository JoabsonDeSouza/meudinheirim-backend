import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let householdId: string;
let accountId: string;

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
  const user = await bootstrapAuthenticatedUser('category-user', 'category@example.com');
  householdId = user.householdId;
  const { prisma } = await import('../../src/shared/db/prisma.js');
  const account = await prisma.account.create({
    data: { householdId, name: 'Category test account', type: 'CHECKING', currency: 'BRL', balance: '100.00', totalBalance: '100.00', availableBalance: '100.00', allocatedBalance: '0.00' },
  });
  accountId = account.id;
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

  it('archives a custom category idempotently and removes it from the default catalogue', async () => {
    const created = await app.inject({
      method: 'POST', url: '/v1/categories/custom',
      headers: { authorization: 'Bearer category-user' },
      payload: { name: 'Archive me', type: 'EXPENSE' },
    });
    const category = created.json() as { id: string };
    const url = `/v1/categories/${category.id}/archive`;
    const first = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer category-user' } });
    const second = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer category-user' } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const catalogue = await app.inject({ method: 'GET', url: '/v1/categories/?type=EXPENSE', headers: { authorization: 'Bearer category-user' } });
    expect(catalogue.statusCode).toBe(200);
    expect((catalogue.json() as { items: Array<{ id?: string }> }).items.some((item) => item.id === category.id)).toBe(false);
  });

  it('archives categories in use without changing historical transaction references', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/categories/custom', headers: { authorization: 'Bearer category-user' }, payload: { name: 'Used category', type: 'EXPENSE' } });
    const category = created.json() as { id: string; code: string };
    const transaction = await app.inject({
      method: 'POST', url: '/v1/transactions', headers: { authorization: 'Bearer category-user' },
      payload: { householdId, clientMutationId: '7aa22bb3-cc44-4d55-8e66-123456789abc', kind: 'expense', amount: { minorUnits: 100, currency: 'BRL' }, categoryCode: category.code, accountId, occurredAt: '2026-10-13T12:34:56.000Z', timeZone: 'America/Sao_Paulo' },
    });
    expect(transaction.statusCode).toBe(201);
    const archived = await app.inject({ method: 'POST', url: `/v1/categories/${category.id}/archive`, headers: { authorization: 'Bearer category-user' } });
    expect(archived.statusCode).toBe(200);
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const row = await prisma.transaction.findFirstOrThrow({ where: { clientMutationId: '7aa22bb3-cc44-4d55-8e66-123456789abc' } });
    expect(row.categoryName).toBe(category.code);
  });
});
