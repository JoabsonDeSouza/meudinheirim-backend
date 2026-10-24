import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  disposeBootstrapTestDb,
  getBootstrapTestDb,
} from '../helpers/db-context.js';

type VerifierMap = Record<string, { uid: string; email: string }>;

let app: FastifyInstance;
let tokens: VerifierMap;
let ownerHouseholdId: string;
let ownAccountPath: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { createTestApp } = await import('../helpers/app.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');

  const verifier: VerifierMap = {
    'sec-owner': { uid: 'sec-owner', email: 'sec-owner@example.com' },
    'sec-editor': { uid: 'sec-editor', email: 'sec-editor@example.com' },
    'sec-viewer': { uid: 'sec-viewer', email: 'sec-viewer@example.com' },
    'sec-outsider': { uid: 'sec-outsider', email: 'sec-outsider@example.com' },
  };
  tokens = verifier;
  setTokenVerifier({
    verify: async (token: string) => ({
      uid: verifier[token].uid,
      email: verifier[token].email,
      emailVerified: true,
    }),
  });
  app = await createTestApp();

  // Bootstrap users in the isolated DB before exercising route authorization.
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  for (const who of Object.values(verifier)) {
    await bootstrapAuthenticatedUser(who.uid, who.email);
  }

  // Owner creates a personal household via the households API.
  const created = await app.inject({
    method: 'POST',
    url: '/households',
    headers: { authorization: 'Bearer sec-owner' },
    payload: { name: 'Security Owner Household' },
  });
  expect([200, 201]).toContain(created.statusCode);
  const ownerHousehold = await prisma.household.findFirst({ where: { name: 'Security Owner Household' } });
  expect(ownerHousehold).not.toBeNull();
  ownerHouseholdId = ownerHousehold?.id ?? '';
  expect(ownerHouseholdId.length).toBeGreaterThan(0);

  // Editor and viewer join explicitly (simulating an invited membership).
  const users = await prisma.user.findMany();
  const uidToUser = new Map(users.map((user) => [user.firebaseUid, user.id]));
  const householdId = ownerHouseholdId;
  for (const token of ['sec-editor', 'sec-viewer']) {
    const role = token === 'sec-editor' ? 'EDITOR' : 'VIEWER';
    await prisma.householdMember.create({
      data: { household: { connect: { id: householdId } }, user: { connect: { id: uidToUser.get(verifier[token].uid) ?? '' } }, role },
    });
  }
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

function authHeaders(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('authorization matrix (accounts/financial surfaces)', () => {
  it('returns stable system category codes without localized labels', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/categories/system',
      headers: authHeaders('sec-owner'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.some((category) => category.code === 'FOOD')).toBe(true);
    expect(body.items.every((category) => !('label' in category) && !('name' in category))).toBe(true);
  });

  it('owner can list household accounts and create an account', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/accounts?householdId=${ownerHouseholdId}`,
      headers: authHeaders('sec-owner'),
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeaders('sec-owner'),
      payload: {
        name: 'Nubank Checking',
        type: 'CHECKING',
        currency: 'BRL',
        householdId: ownerHouseholdId,
      },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json() as { data: { id: string } };
    ownAccountPath = `/accounts/${body.data.id}`;
  });

  it('editor can create in the household', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeaders('sec-editor'),
      payload: {
        name: 'Editor Account',
        type: 'CASH',
        currency: 'BRL',
        householdId: ownerHouseholdId,
      },
    });
    expect([200, 201]).toContain(create.statusCode);
  });

  it('viewer can read but not create', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/accounts?householdId=${ownerHouseholdId}`,
      headers: authHeaders('sec-viewer'),
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeaders('sec-viewer'),
      payload: {
        name: 'Viewer Forbidden',
        type: 'CASH',
        currency: 'BRL',
        householdId: ownerHouseholdId,
      },
    });
    expect(create.statusCode).toBe(403);
  });

  it('viewer cannot create a transaction in the household', async () => {
    const accountId = ownAccountPath.split('/').at(-1);
    const create = await app.inject({
      method: 'POST',
      url: '/transactions',
      headers: authHeaders('sec-viewer'),
      payload: {
        householdId: ownerHouseholdId,
        type: 'EXPENSE',
        accountId,
        categoryName: 'FOOD',
        amount: 10,
        date: '2026-01-01',
      },
    });
    expect(create.statusCode).toBe(403);
  });

  it('viewer cannot create a transaction through the V1 MoneyDto endpoint', async () => {
    const accountId = ownAccountPath.split('/').at(-1);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders('sec-viewer'),
      payload: {
        householdId: ownerHouseholdId,
        clientMutationId: '6ff77008-1199-42aa-b3cc-6789abcdef01',
        kind: 'expense',
        amount: { minorUnits: 100, currency: 'BRL' },
        categoryCode: 'FOOD',
        accountId,
        occurredAt: '2026-10-13T12:34:56.000Z',
        timeZone: 'America/Sao_Paulo',
      },
    });
    expect(create.statusCode).toBe(403);
  });

  it('viewer cannot initiate a V1 transfer', async () => {
    const accountList = await app.inject({
      method: 'GET',
      url: `/accounts?householdId=${ownerHouseholdId}`,
      headers: authHeaders('sec-viewer'),
    });
    const accounts = (accountList.json() as { data: { accounts: Array<{ id: string }> } }).data.accounts;
    expect(accounts.length).toBeGreaterThanOrEqual(2);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfers',
      headers: authHeaders('sec-viewer'),
      payload: {
        householdId: ownerHouseholdId,
        clientMutationId: '70088119-22aa-43bb-c4dd-789abcdef012',
        fromAccountId: accounts[0].id,
        toAccountId: accounts[1].id,
        amount: { minorUnits: 100, currency: 'BRL' },
        expectedFromVersion: 1,
        expectedToVersion: 1,
        occurredAt: '2026-10-13T12:34:56.000Z',
        timeZone: 'America/Sao_Paulo',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('viewer cannot create a budget in a shared household', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/budgets',
      headers: authHeaders('sec-viewer'),
      payload: {
        householdId: ownerHouseholdId,
        categoryCode: 'FOOD',
        type: 'EXPENSE',
        month: '2026-10',
        monthlyLimit: { minorUnits: 10000, currency: 'BRL' },
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('preferences endpoint rejects isPremium mass assignment', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const owner = await prisma.user.findUniqueOrThrow({
      where: { firebaseUid: 'sec-owner' },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { isPremium: false } });

    const response = await app.inject({
      method: 'PUT',
      url: '/users/me/preferences',
      headers: authHeaders('sec-owner'),
      payload: { isPremium: true },
    });
    expect(response.statusCode).toBe(400);
    const userAfterRequest = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { isPremium: true },
    });
    expect(userAfterRequest.isPremium).toBe(false);
  });

  it('outsider cannot access a household they are not a member of', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/accounts?householdId=${ownerHouseholdId}`,
      headers: authHeaders('sec-outsider'),
    });
    expect([403, 404]).toContain(list.statusCode);

    const create = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeaders('sec-outsider'),
      payload: {
        name: 'Outsider Forbidden',
        type: 'CASH',
        currency: 'BRL',
        householdId: ownerHouseholdId,
      },
    });
    expect(create.statusCode).toBe(403);
  });

  it('outsider cannot read another household change feed', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/sync/changes?householdId=${ownerHouseholdId}`,
      headers: authHeaders('sec-outsider'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('cross-household resource reads return 404 without leaking data', async () => {
    void tokens;
    const response = await app.inject({
      method: 'GET',
      url: ownAccountPath,
      headers: authHeaders('sec-outsider'),
    });
    expect([403, 404]).toContain(response.statusCode);
  });

  it('INSERT rejects unknown payloads (client body unknown strict)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authHeaders('sec-owner'),
      payload: {
        name: 'X',
        type: 'CHECKING',
        currency: 'BRL',
        isPremium: true,
        householdId: ownerHouseholdId,
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
