import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  disposeBootstrapTestDb,
  getBootstrapTestDb,
} from '../helpers/db-context.js';

interface AuthenticatedUser {
  readonly userId: string;
  readonly householdId: string;
}

interface BootstrapContext {
  bootstrapUser(firebaseUid: string, email: string): Promise<AuthenticatedUser>;
  syncUser(firebaseUid: string, email: string, preferences: { locale: 'pt-BR' | 'en-US'; baseCurrency: 'BRL' | 'USD'; timeZone: string }): Promise<{ id: string; email: string; createdAt: Date; householdId: string }>;
  householdsForUser(userId: string): Promise<readonly { householdId: string }[]>;
  accountsForHousehold(householdId: string): Promise<readonly { id: string; name: string; type: string; currency: string; balance: string; totalBalance: string; availableBalance: string; allocatedBalance: string }[]>;
  createAccount(householdId: string, input: { name: string; currency: 'BRL' | 'USD'; balance: string }): Promise<void>;
  databaseCounts(email: string): Promise<{ users: number; memberships: number }>;
}

let context: BootstrapContext;

beforeAll(async () => {
  const db = await getBootstrapTestDb();
  void db;
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { bootstrapAuthSync } = await import('../../src/shared/auth/bootstrap.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  context = {
    bootstrapUser: bootstrapAuthenticatedUser,
    syncUser: bootstrapAuthSync,
    householdsForUser: async (userId: string) => {
      const memberships = await prisma.householdMember.findMany({
        where: { userId },
        include: { household: true },
      });
      return memberships.map(m => ({ householdId: m.householdId }));
    },
    accountsForHousehold: async (householdId: string) => {
      const accounts = await prisma.account.findMany({ where: { householdId }, orderBy: { createdAt: 'asc' } });
      return accounts.map(account => ({
        id: account.id,
        name: account.name,
        type: account.type,
        currency: account.currency,
        balance: account.balance.toFixed(2),
        totalBalance: account.totalBalance.toFixed(2),
        availableBalance: account.availableBalance.toFixed(2),
        allocatedBalance: account.allocatedBalance.toFixed(2),
      }));
    },
    createAccount: async (householdId, input) => {
      await prisma.account.create({
        data: {
          householdId,
          name: input.name,
          type: 'CHECKING',
          currency: input.currency,
          balance: input.balance,
          totalBalance: input.balance,
          availableBalance: input.balance,
        },
      });
    },
    databaseCounts: async email => ({
      users: await prisma.user.count({ where: { email } }),
      memberships: await prisma.householdMember.count({ where: { user: { email } } }),
    }),
  };
});

afterAll(async () => {
  await disposeBootstrapTestDb();
});

describe('user/personal-household bootstrap', () => {
  it('creates a single user and a single personal household on first login', async () => {
    const user = await context.bootstrapUser('first-uid-test', 'first@example.com');
    expect(user.householdId).toBeTruthy();
    const households = await context.householdsForUser(user.userId);
    expect(households).toHaveLength(1);
  });

  it('is idempotent: retrying login does not duplicate user or household', async () => {
    const first = await context.bootstrapUser('retry-uid-test', 'retry@example.com');
    const second = await context.bootstrapUser('retry-uid-test', 'retry@example.com');
    expect(second.userId).toBe(first.userId);
    expect(second.householdId).toBe(first.householdId);
    expect(await context.householdsForUser(first.userId)).toHaveLength(1);
  });

  it('is idempotent under concurrency: parallel bootstraps create one household', async () => {
    const results = await Promise.all([
      context.bootstrapUser('concurrent-uid', 'concurrent@example.com'),
      context.bootstrapUser('concurrent-uid', 'concurrent@example.com'),
      context.bootstrapUser('concurrent-uid', 'concurrent@example.com'),
    ]);
    expect(new Set(results.map(r => r.userId)).size).toBe(1);
    expect(new Set(results.map(r => r.householdId)).size).toBe(1);
    expect(await context.householdsForUser(results[0].userId)).toHaveLength(1);
  });

  it('creates pt-BR BRL checking account with all balances zero on auth sync', async () => {
    const user = await context.syncUser('sync-ptbr-uid', 'sync-ptbr@example.com', {
      locale: 'pt-BR', baseCurrency: 'BRL', timeZone: 'America/Sao_Paulo',
    });
    const [account] = await context.accountsForHousehold(user.householdId);
    expect(account).toMatchObject({ name: 'Conta principal', type: 'CHECKING', currency: 'BRL' });
    expect(account.balance).toBe('0.00');
    expect(account.totalBalance).toBe('0.00');
    expect(account.availableBalance).toBe('0.00');
    expect(account.allocatedBalance).toBe('0.00');
  });

  it('creates en-US USD checking account named Main account', async () => {
    const user = await context.syncUser('sync-enus-uid', 'sync-enus@example.com', {
      locale: 'en-US', baseCurrency: 'USD', timeZone: 'America/New_York',
    });
    const accounts = await context.accountsForHousehold(user.householdId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Main account', type: 'CHECKING', currency: 'USD' });
    expect(accounts[0].balance).toBe('0.00');
  });

  it('keeps repeated sync idempotent and does not overwrite user preferences', async () => {
    const first = await context.syncUser('sync-repeat-uid', 'sync-repeat@example.com', {
      locale: 'pt-BR', baseCurrency: 'BRL', timeZone: 'UTC',
    });
    const second = await context.syncUser('sync-repeat-uid', 'sync-repeat@example.com', {
      locale: 'en-US', baseCurrency: 'USD', timeZone: 'UTC',
    });
    expect(second.id).toBe(first.id);
    expect(second.householdId).toBe(first.householdId);
    expect(await context.accountsForHousehold(first.householdId)).toHaveLength(1);
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: first.id } });
    expect(user.locale).toBe('pt-BR');
    expect(user.baseCurrency).toBe('BRL');
  });

  it('creates one account under concurrent auth sync requests', async () => {
    const preferences = { locale: 'pt-BR' as const, baseCurrency: 'BRL' as const, timeZone: 'UTC' };
    const users = await Promise.all([
      context.syncUser('sync-concurrent-uid', 'sync-concurrent@example.com', preferences),
      context.syncUser('sync-concurrent-uid', 'sync-concurrent@example.com', preferences),
      context.syncUser('sync-concurrent-uid', 'sync-concurrent@example.com', preferences),
    ]);
    expect(new Set(users.map(user => user.id)).size).toBe(1);
    expect(new Set(users.map(user => user.householdId)).size).toBe(1);
    expect(await context.householdsForUser(users[0].id)).toHaveLength(1);
    expect(await context.accountsForHousehold(users[0].householdId)).toHaveLength(1);
  });

  it('adds account to existing household with no accounts', async () => {
    const existing = await context.bootstrapUser('legacy-no-account-uid', 'legacy-no-account@example.com');
    expect(await context.accountsForHousehold(existing.householdId)).toHaveLength(0);
    await context.syncUser('legacy-no-account-uid', 'legacy-no-account@example.com', {
      locale: 'en-US', baseCurrency: 'USD', timeZone: 'UTC',
    });
    expect(await context.accountsForHousehold(existing.householdId)).toHaveLength(1);
  });

  it('preserves existing account balances and creates no duplicate', async () => {
    const existing = await context.bootstrapUser('legacy-has-account-uid', 'legacy-has-account@example.com');
    await context.createAccount(existing.householdId, { name: 'Existing', currency: 'USD', balance: '125.50' });
    await context.syncUser('legacy-has-account-uid', 'legacy-has-account@example.com', {
      locale: 'pt-BR', baseCurrency: 'BRL', timeZone: 'UTC',
    });
    const accounts = await context.accountsForHousehold(existing.householdId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Existing', currency: 'USD', balance: '125.50', totalBalance: '125.50', availableBalance: '125.50' });
  });

  it('rolls back user and household when account creation fails', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    await prisma.$executeRawUnsafe(`CREATE FUNCTION auth_sync_test_fail_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced account failure'; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER auth_sync_test_fail_account BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION auth_sync_test_fail_account()`);
    try {
      await expect(context.syncUser('sync-rollback-uid', 'sync-rollback@example.com', {
        locale: 'pt-BR', baseCurrency: 'BRL', timeZone: 'UTC',
      })).rejects.toThrow();
      expect(await context.databaseCounts('sync-rollback@example.com')).toEqual({ users: 0, memberships: 0 });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER auth_sync_test_fail_account ON accounts');
      await prisma.$executeRawUnsafe('DROP FUNCTION auth_sync_test_fail_account()');
    }
  });
});
