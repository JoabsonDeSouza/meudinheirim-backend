import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';
import { createTestApp } from '../helpers/app.js';

interface SyncResponse {
  readonly success: boolean;
  readonly data: {
    readonly id: string;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly householdId: string;
  };
}

let app: FastifyInstance;

const validPayload = {
  locale: 'pt-BR',
  baseCurrency: 'BRL',
  timeZone: 'America/Sao_Paulo',
};

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  setTokenVerifier({
    verify: async token => ({
      uid: token,
      email: token === 'conflicting-uid' ? 'auth-sync-conflict@example.com' : `${token}@example.com`,
      emailVerified: true,
    }),
  });
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('POST /v1/auth/sync', () => {
  it('returns household ID and creates the localized default account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/sync',
      headers: { authorization: 'Bearer auth-sync-new' },
      payload: validPayload,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SyncResponse;
    expect(body.success).toBe(true);
    expect(body.data.householdId).toMatch(/^[0-9a-f-]{36}$/i);
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const accounts = await prisma.account.findMany({
      where: { householdId: body.data.householdId },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      name: 'Conta principal',
      type: 'CHECKING',
      currency: 'BRL',
    });
    expect(accounts[0].balance.toFixed(2)).toBe('0.00');
  });

  it('rejects missing or invalid locale, currency, and timezone without creating user', async () => {
    const invalidPayloads: readonly { locale?: string; baseCurrency?: string; timeZone?: string }[] = [
      { baseCurrency: 'BRL', timeZone: 'UTC' },
      { ...validPayload, locale: 'es-ES' },
      { ...validPayload, baseCurrency: 'EUR' },
      { ...validPayload, timeZone: 'Mars/Olympus_Mons' },
    ];
    for (const [index, payload] of invalidPayloads.entries()) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sync',
        headers: { authorization: `Bearer invalid-sync-${index}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const { prisma } = await import('../../src/shared/db/prisma.js');
    expect(
      await prisma.user.count({
        where: { email: { startsWith: 'invalid-sync-' } },
      }),
    ).toBe(0);
  });

  it('requires authentication and creates no user when token is absent', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const usersBefore = await prisma.user.count();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/sync',
      payload: validPayload,
    });
    expect(response.statusCode).toBe(401);
    expect(await prisma.user.count()).toBe(usersBefore);
  });

  it('serializes concurrent HTTP sync requests into one household and account', async () => {
    const requests = await Promise.all(
      [1, 2, 3].map(() =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/sync',
          headers: { authorization: 'Bearer auth-sync-concurrent' },
          payload: validPayload,
        }),
      ),
    );
    expect(requests.map(response => response.statusCode)).toEqual([200, 200, 200]);
    const households = requests.map(response => (response.json() as SyncResponse).data.householdId);
    expect(new Set(households).size).toBe(1);
    const { prisma } = await import('../../src/shared/db/prisma.js');
    expect(
      await prisma.householdMember.count({
        where: { user: { firebaseUid: 'auth-sync-concurrent' } },
      }),
    ).toBe(1);
    expect(await prisma.account.count({ where: { householdId: households[0] } })).toBe(1);
  });

  it('rejects an email already linked to another Firebase UID without rebinding it', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await prisma.user.create({
      data: {
        firebaseUid: 'original-auth-sync-uid',
        email: 'auth-sync-conflict@example.com',
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/sync',
      headers: { authorization: 'Bearer conflicting-uid' },
      payload: validPayload,
    });
    expect(response.statusCode).toBe(409);
    const existing = await prisma.user.findUniqueOrThrow({
      where: { email: 'auth-sync-conflict@example.com' },
    });
    expect(existing.firebaseUid).toBe('original-auth-sync-uid');
    expect(await prisma.user.count({ where: { firebaseUid: 'conflicting-uid' } })).toBe(0);
  });

  it('denies account list access across households', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/sync',
      headers: { authorization: 'Bearer auth-sync-owner-a' },
      payload: validPayload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/sync',
      headers: { authorization: 'Bearer auth-sync-owner-b' },
      payload: validPayload,
    });
    const firstUser = first.json() as SyncResponse;
    const secondUser = second.json() as SyncResponse;
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts?householdId=${secondUser.data.householdId}`,
      headers: { authorization: 'Bearer auth-sync-owner-a' },
    });
    expect(firstUser.data.householdId).not.toBe(secondUser.data.householdId);
    expect(response.statusCode).toBe(403);
  });
});
