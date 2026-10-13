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
  readonly prisma: { readonly $disconnect: () => Promise<void> };
  bootstrapUser(firebaseUid: string, email: string): Promise<AuthenticatedUser>;
  householdsForUser(userId: string): Promise<readonly { householdId: string }[]>;
}

let context: BootstrapContext;

beforeAll(async () => {
  const db = await getBootstrapTestDb();
  void db;
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  context = {
    prisma,
    bootstrapUser: bootstrapAuthenticatedUser,
    householdsForUser: async (userId: string) => {
      const memberships = await prisma.householdMember.findMany({
        where: { userId },
        include: { household: true },
      });
      return memberships.map(m => ({ householdId: m.householdId }));
    },
  };
});

afterAll(async () => {
  await context.prisma.$disconnect();
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
});
