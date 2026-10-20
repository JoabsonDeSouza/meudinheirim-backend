import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';
import type { CreateTransferV1Input } from '../../src/modules/transactions/transfers.v1.schema.js';

let app: FastifyInstance;
let householdId: string;
let prisma: PrismaClient;
let databaseUrl: string;

beforeAll(async () => {
  const db = await getBootstrapTestDb();
  databaseUrl = db.url;
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  const prismaModule = await import('../../src/shared/db/prisma.js');
  const user = await bootstrapAuthenticatedUser('transfer-owner', 'transfer@example.com');
  householdId = user.householdId;
  prisma = prismaModule.prisma;
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: 'transfer@example.com', emailVerified: true }),
  });
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

async function createAccount(name: string, currency: 'BRL' | 'USD', balance: string): Promise<string> {
  const account = await prisma.account.create({
    data: {
      householdId,
      name,
      type: 'CHECKING',
      currency,
      balance: new Prisma.Decimal(balance),
      totalBalance: new Prisma.Decimal(balance),
      availableBalance: new Prisma.Decimal(balance),
      allocatedBalance: new Prisma.Decimal(0),
    },
  });
  return account.id;
}

function transferPayload(fromAccountId: string, toAccountId: string, clientMutationId: string, expectedFromVersion = 1, expectedToVersion = 1): CreateTransferV1Input {
  return {
    householdId,
    clientMutationId,
    fromAccountId,
    toAccountId,
    amount: { minorUnits: 2500, currency: 'BRL' },
    expectedFromVersion,
    expectedToVersion,
    occurredAt: '2026-10-13T12:34:56.000Z',
    timeZone: 'America/Sao_Paulo',
  };
}

describe('atomic V1 transfers', () => {
  it('commits one transfer record and both exact balance changes atomically', async () => {
    const fromAccountId = await createAccount('Transfer from', 'BRL', '100.00');
    const toAccountId = await createAccount('Transfer to', 'BRL', '10.00');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfers',
      headers: { authorization: 'Bearer transfer-owner' },
      payload: transferPayload(fromAccountId, toAccountId, '8119922a-33bb-44cc-d5ee-89abcdef0123'),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { transaction: { id: string; kind: string }; fromVersion: number; toVersion: number };
    expect(body.transaction.kind).toBe('transfer');
    expect(body.fromVersion).toBe(2);
    expect(body.toVersion).toBe(2);
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfers',
      headers: { authorization: 'Bearer transfer-owner' },
      payload: transferPayload(fromAccountId, toAccountId, '8119922a-33bb-44cc-d5ee-89abcdef0123'),
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { transaction: { id: string } }).transaction.id).toBe(body.transaction.id);
    const conflictingReplay = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfers',
      headers: { authorization: 'Bearer transfer-owner' },
      payload: { ...transferPayload(fromAccountId, toAccountId, '8119922a-33bb-44cc-d5ee-89abcdef0123'), amount: { minorUnits: 3000, currency: 'BRL' } },
    });
    expect(conflictingReplay.statusCode).toBe(409);
    const [from, to, records] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id: fromAccountId } }),
      prisma.account.findUniqueOrThrow({ where: { id: toAccountId } }),
      prisma.transaction.count({ where: { householdId, type: 'TRANSFER', fromAccountId, toAccountId } }),
    ]);
    expect(from.availableBalance.toFixed(2)).toBe('75.00');
    expect(to.availableBalance.toFixed(2)).toBe('35.00');
    expect(records).toBe(1);
  });

  it('serializes concurrent transfers and rejects stale versions without partial balances', async () => {
    const fromAccountId = await createAccount('Concurrent from', 'BRL', '100.00');
    const toAccountId = await createAccount('Concurrent to', 'BRL', '0.00');
    const payloadA = transferPayload(fromAccountId, toAccountId, '922aa33b-44cc-45dd-e6ff-9abcdef01234');
    const payloadB = transferPayload(fromAccountId, toAccountId, 'a33bb44c-55dd-46ee-f700-abcdef012345');
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/transactions/transfers', headers: { authorization: 'Bearer transfer-owner' }, payload: payloadA }),
      app.inject({ method: 'POST', url: '/v1/transactions/transfers', headers: { authorization: 'Bearer transfer-owner' }, payload: payloadB }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    const [from, to] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id: fromAccountId } }),
      prisma.account.findUniqueOrThrow({ where: { id: toAccountId } }),
    ]);
    expect(from.availableBalance.toFixed(2)).toBe('75.00');
    expect(to.availableBalance.toFixed(2)).toBe('25.00');
  });

  it('rejects insufficient funds, mixed currency and cross-household accounts without partial changes', async () => {
    const fromAccountId = await createAccount('Insufficient from', 'BRL', '5.00');
    const toAccountId = await createAccount('Insufficient to', 'BRL', '0.00');
    const insufficient = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfers',
      headers: { authorization: 'Bearer transfer-owner' },
      payload: transferPayload(fromAccountId, toAccountId, 'b44cc55d-66ee-4700-8111-bcdef0123456'),
    });
    expect(insufficient.statusCode).toBe(400);

    const usdAccountId = await createAccount('USD account', 'USD', '0.00');
    const mixedCurrency = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfers',
      headers: { authorization: 'Bearer transfer-owner' },
      payload: transferPayload(fromAccountId, usdAccountId, 'c55dd66e-7700-4811-9222-cdef01234567'),
    });
    expect(mixedCurrency.statusCode).toBe(400);

    const [from, to] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id: fromAccountId } }),
      prisma.account.findUniqueOrThrow({ where: { id: toAccountId } }),
    ]);
    expect(from.availableBalance.toFixed(2)).toBe('5.00');
    expect(to.availableBalance.toFixed(2)).toBe('0.00');
  });

  it('rolls back both account updates when persisting the transfer audit record fails', async () => {
    const fromAccountId = await createAccount('Rollback from', 'BRL', '100.00');
    const toAccountId = await createAccount('Rollback to', 'BRL', '0.00');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION reject_transfer_audit_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.type = 'TRANSFER' THEN
            RAISE EXCEPTION 'injected transfer audit failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await pool.query(`
        CREATE TRIGGER reject_transfer_audit_insert
        BEFORE INSERT ON transactions
        FOR EACH ROW EXECUTE FUNCTION reject_transfer_audit_insert()
      `);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/transactions/transfers',
        headers: { authorization: 'Bearer transfer-owner' },
        payload: transferPayload(fromAccountId, toAccountId, 'd66ee770-0811-4922-a333-def012345678'),
      });
      expect(response.statusCode).toBe(500);
      const [from, to] = await Promise.all([
        prisma.account.findUniqueOrThrow({ where: { id: fromAccountId } }),
        prisma.account.findUniqueOrThrow({ where: { id: toAccountId } }),
      ]);
      expect(from.availableBalance.toFixed(2)).toBe('100.00');
      expect(to.availableBalance.toFixed(2)).toBe('0.00');
      expect(await prisma.transaction.count({ where: { fromAccountId, toAccountId, type: 'TRANSFER' } })).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS reject_transfer_audit_insert ON transactions');
      await pool.query('DROP FUNCTION IF EXISTS reject_transfer_audit_insert()');
      await pool.end();
    }
  });

  it('returns not-found for a cross-household destination without debiting source', async () => {
    const fromAccountId = await createAccount('Cross-household from', 'BRL', '100.00');
    const foreignHousehold = await prisma.household.create({
      data: {
        name: 'Foreign transfer household',
        members: {
          create: {
            userId: (await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'transfer-owner' } })).id,
            role: 'OWNER',
          },
        },
      },
    });
    const foreignAccount = await prisma.account.create({
      data: {
        householdId: foreignHousehold.id,
        name: 'Foreign destination',
        type: 'CHECKING',
        currency: 'BRL',
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfers',
      headers: { authorization: 'Bearer transfer-owner' },
      payload: transferPayload(fromAccountId, foreignAccount.id, 'e7700811-1922-4a33-b444-ef0123456789'),
    });
    expect(response.statusCode).toBe(404);
    const from = await prisma.account.findUniqueOrThrow({ where: { id: fromAccountId } });
    expect(from.availableBalance.toFixed(2)).toBe('100.00');
  });
});
