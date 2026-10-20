import { getOrCreatePersonalHousehold } from '../../modules/households/households.service.js';
import { getUserByFirebaseUid } from '../middleware/authorization.middleware.js';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';
import { ConflictError } from '../errors/index.js';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly householdId: string;
}

export interface AuthSyncPreferences {
  readonly locale: 'pt-BR' | 'en-US';
  readonly baseCurrency: 'BRL' | 'USD';
  readonly timeZone: string;
}

export interface AuthSyncUser {
  readonly id: string;
  readonly email: string;
  readonly createdAt: Date;
  readonly householdId: string;
}

/** Atomically creates the user, personal household, and default account on sync. */
export async function bootstrapAuthSync(firebaseUid: string, email: string, preferences: AuthSyncPreferences): Promise<AuthSyncUser> {
  const normalizedEmail = email.trim();

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`auth-sync-uid:${firebaseUid}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`auth-sync-email:${normalizedEmail}`}))`;

    const userByUid = await tx.user.findUnique({ where: { firebaseUid } });
    const userByEmail = await tx.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (userByEmail && userByEmail.firebaseUid !== firebaseUid && !userByUid) {
      throw new ConflictError('Email is already linked to another authentication identity');
    }

    let user = userByUid;
    if (!user) {
      user = await tx.user.create({
        data: {
          firebaseUid,
          email: normalizedEmail,
          locale: preferences.locale,
          baseCurrency: preferences.baseCurrency,
        },
      });
    }

    const membership = await tx.householdMember.findFirst({
      where: { userId: user.id },
      include: { household: true },
      orderBy: { household: { createdAt: 'asc' } },
    });
    let household = membership?.household;
    if (!household) {
      household = await tx.household.create({
        data: {
          name: `${normalizedEmail.split('@')[0] || 'My Finances'}'s Finances`,
        },
      });
      await tx.householdMember.create({
        data: { householdId: household.id, userId: user.id, role: 'OWNER' },
      });
    }

    const existingAccount = await tx.account.findFirst({
      where: { householdId: household.id },
      select: { id: true },
    });
    if (!existingAccount) {
      const zero = new Prisma.Decimal(0);
      await tx.account.create({
        data: {
          householdId: household.id,
          name: preferences.locale === 'pt-BR' ? 'Conta principal' : 'Main account',
          type: 'CHECKING',
          currency: preferences.baseCurrency,
          balance: zero,
          totalBalance: zero,
          availableBalance: zero,
          allocatedBalance: zero,
        },
      });
    }

    return {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      householdId: household.id,
    };
  });
}

/**
 * Ensures a database user and the user's personal household exist.
 * Called on first authenticated request of a Firebase identity.
 * Must be idempotent: repeated and concurrent calls create at most one of each.
 */
export async function bootstrapAuthenticatedUser(
  firebaseUid: string,
  email: string,
): Promise<AuthenticatedUser> {
  const user = await getUserByFirebaseUid(firebaseUid, email);
  const household = await getOrCreatePersonalHousehold(user.id, email);
  return {
    userId: user.id,
    householdId: household.id,
  };
}
