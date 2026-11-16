import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;

interface Party {
  readonly firebaseToken: string;
  readonly userId: string;
  readonly householdId: string;
  readonly accountId: string;
}

async function createParty(firebaseToken: string): Promise<Party> {
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  setTokenVerifier({
    // Like Firebase: a device token is not a valid ID token, so verification must fail.
    verify: async (incoming: string) => {
      if (incoming.startsWith('mdsc_')) throw new Error('not a Firebase ID token');
      return { uid: incoming, email: `${incoming}@example.com`, emailVerified: true };
    },
  });
  const user = await bootstrapAuthenticatedUser(firebaseToken, `${firebaseToken}@example.com`);
  const account = await prisma.account.create({
    data: { householdId: user.householdId, name: `${firebaseToken} BRL`, type: 'CHECKING', currency: 'BRL', availableBalance: new Prisma.Decimal('500.00') },
  });
  return { firebaseToken, userId: user.userId, householdId: user.householdId, accountId: account.id };
}

function expenseBody(accountId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientMutationId: randomUUID(),
    kind: 'expense',
    amount: { minorUnits: 1250, currency: 'BRL' },
    categoryCode: 'FOOD',
    accountId,
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    timeZone: 'America/Sao_Paulo',
    note: 'Café',
    paid: true,
    ...overrides,
  };
}

async function createToken(owner: Party, deviceName = 'iPhone'): Promise<{ tokenId: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/shortcut-tokens',
    headers: { authorization: `Bearer ${owner.firebaseToken}` },
    payload: { deviceName, scopes: ['transactions:create'], householdId: owner.householdId },
  });
  expect(response.statusCode).toBe(201);
  const data = response.json().data as { tokenId: string; token: string };
  return { tokenId: data.tokenId, token: data.token };
}

function postShortcut(token: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/shortcut/transactions',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

beforeAll(async () => {
  await getBootstrapTestDb();
  // Import the Prisma singleton before building the app: createTestApp() rewrites
  // DATABASE_URL to the base URL, and only a client created earlier keeps the isolated DB.
  await import('../../src/shared/db/prisma.js');
  await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('shortcut tokens: management', () => {
  it('shows the raw token once, lists metadata without it, and never persists the raw value', async () => {
    const owner = await createParty('sc-owner');
    const { token, tokenId } = await createToken(owner);
    expect(token.startsWith('mdsc_')).toBe(true);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/shortcut-tokens',
      headers: { authorization: `Bearer ${owner.firebaseToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain('tokenHash');
    const items = listed.json().data as Array<Record<string, unknown>>;
    expect(items.find((item) => item.id === tokenId)).toMatchObject({
      deviceName: 'iPhone', scopes: ['transactions:create'], maxAmountMinor: 100000, revokedAt: null,
    });

    const { prisma } = await import('../../src/shared/db/prisma.js');
    const row = await prisma.shortcutToken.findUniqueOrThrow({ where: { id: tokenId } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toBe(token);
  });

  it('rejects the device token on management routes (Firebase only)', async () => {
    const owner = await createParty('sc-mgmt-firebase');
    const { token } = await createToken(owner);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/shortcut-tokens',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lets another user neither see nor revoke the token (404, no id probing)', async () => {
    const owner = await createParty('sc-iso-owner');
    const other = await createParty('sc-iso-other');
    const { tokenId } = await createToken(owner);
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/shortcut-tokens/${tokenId}`,
      headers: { authorization: `Bearer ${other.firebaseToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('shortcut transactions: create and idempotency', () => {
  it('creates an expense with 201 and replays the same clientMutationId with 200', async () => {
    const owner = await createParty('sc-create');
    const { token } = await createToken(owner);
    const body = expenseBody(owner.accountId);

    const first = await postShortcut(token, body);
    expect(first.statusCode).toBe(201);
    const created = first.json().data as { id: string; kind: string; amount: { minorUnits: number; currency: string } };
    expect(created).toMatchObject({ kind: 'expense', amount: { minorUnits: 1250, currency: 'BRL' } });

    const replay = await postShortcut(token, body);
    expect(replay.statusCode).toBe(200);
    expect((replay.json().data as { id: string }).id).toBe(created.id);

    const { prisma } = await import('../../src/shared/db/prisma.js');
    const count = await prisma.transaction.count({ where: { householdId: owner.householdId, clientMutationId: body.clientMutationId as string } });
    expect(count).toBe(1);
  });

  it('returns 409 when the same clientMutationId arrives with a different payload', async () => {
    const owner = await createParty('sc-conflict');
    const { token } = await createToken(owner);
    const body = expenseBody(owner.accountId);
    expect((await postShortcut(token, body)).statusCode).toBe(201);
    const changed = await postShortcut(token, { ...body, amount: { minorUnits: 999, currency: 'BRL' } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code ?? changed.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects amounts above the token ceiling with 422 and records the rejection', async () => {
    const owner = await createParty('sc-limit');
    const { tokenId, token } = await createToken(owner);
    const response = await postShortcut(token, expenseBody(owner.accountId, { amount: { minorUnits: 100001, currency: 'BRL' } }));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code ?? response.json().code).toBe('SHORTCUT_AMOUNT_LIMIT');
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const event = await prisma.shortcutTokenEvent.findFirst({ where: { tokenId, outcome: 'AMOUNT_LIMIT' } });
    expect(event?.action).toBe('REJECTED');
  });

  it('refuses income, unknown fields, and unpaid entries with 400', async () => {
    const owner = await createParty('sc-shape');
    const { token } = await createToken(owner);
    expect((await postShortcut(token, expenseBody(owner.accountId, { kind: 'income' }))).statusCode).toBe(400);
    expect((await postShortcut(token, expenseBody(owner.accountId, { paid: false }))).statusCode).toBe(400);
    expect((await postShortcut(token, expenseBody(owner.accountId, { extra: 1 }))).statusCode).toBe(400);
  });

  it('refuses a household that does not match the token binding', async () => {
    const owner = await createParty('sc-household');
    const { token } = await createToken(owner);
    const response = await postShortcut(token, expenseBody(owner.accountId, { householdId: randomUUID() }));
    expect(response.statusCode).toBe(403);
  });
});

describe('shortcut transactions: rate limit', () => {
  it('allows 30 requests per minute per credential and answers the 31st with 429', async () => {
    const owner = await createParty('sc-rate');
    const { token } = await createToken(owner);
    // Invalid body keeps each request cheap and writes nothing; the limiter still counts it.
    const bad = expenseBody(owner.accountId, { kind: 'income' });
    for (let index = 0; index < 30; index += 1) {
      expect((await postShortcut(token, bad)).statusCode).toBe(400);
    }
    expect((await postShortcut(token, bad)).statusCode).toBe(429);
  });
});

describe('shortcut tokens: authentication and revocation', () => {
  it('rejects Firebase tokens and tampered device tokens on the shortcut endpoint', async () => {
    const owner = await createParty('sc-auth');
    await createToken(owner);
    expect((await postShortcut(owner.firebaseToken, expenseBody(owner.accountId))).statusCode).toBe(401);
    expect((await postShortcut('mdsc_not-a-real-token-value-aaaaaaaaaaaaaaaaaaaaaaa', expenseBody(owner.accountId))).statusCode).toBe(401);
    const missing = await app.inject({ method: 'POST', url: '/v1/shortcut/transactions', payload: expenseBody(owner.accountId) });
    expect(missing.statusCode).toBe(401);
  });

  it('stops working the moment the token is revoked', async () => {
    const owner = await createParty('sc-revoke');
    const { tokenId, token } = await createToken(owner);
    expect((await postShortcut(token, expenseBody(owner.accountId))).statusCode).toBe(201);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/shortcut-tokens/${tokenId}`,
      headers: { authorization: `Bearer ${owner.firebaseToken}` },
    });
    expect(revoke.statusCode).toBe(204);

    expect((await postShortcut(token, expenseBody(owner.accountId))).statusCode).toBe(401);
    // Revoking twice is harmless.
    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/shortcut-tokens/${tokenId}`,
      headers: { authorization: `Bearer ${owner.firebaseToken}` },
    });
    expect(again.statusCode).toBe(204);
  });

  it('cuts off a token when its owner loses edit access to the household', async () => {
    const owner = await createParty('sc-owner-role');
    const member = await createParty('sc-member-role');
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await prisma.householdMember.create({
      data: { householdId: owner.householdId, userId: member.userId, role: 'EDITOR' },
    });
    const { token } = await createToken({ ...member, householdId: owner.householdId });
    expect((await postShortcut(token, expenseBody(owner.accountId))).statusCode).toBe(201);

    await prisma.householdMember.deleteMany({ where: { householdId: owner.householdId, userId: member.userId } });
    expect((await postShortcut(token, expenseBody(owner.accountId))).statusCode).toBe(403);
  });

  it('caps active tokens per user at five', async () => {
    const owner = await createParty('sc-cap');
    for (let index = 0; index < 5; index += 1) await createToken(owner, `device-${index}`);
    const sixth = await app.inject({
      method: 'POST',
      url: '/v1/shortcut-tokens',
      headers: { authorization: `Bearer ${owner.firebaseToken}` },
      payload: { deviceName: 'sixth', scopes: ['transactions:create'], householdId: owner.householdId },
    });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.code ?? sixth.json().code).toBe('SHORTCUT_TOKEN_LIMIT');
  });
});
