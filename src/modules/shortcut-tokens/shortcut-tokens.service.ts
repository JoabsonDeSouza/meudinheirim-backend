import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../shared/errors/app-error.js';
import { prisma } from '../../shared/db/prisma.js';
import { getHouseholdMembership, hasRoleLevel } from '../../shared/middleware/authorization.middleware.js';
import { generateShortcutToken, hashShortcutToken, isShortcutTokenShape } from './shortcut-token.crypto.js';
import {
  SHORTCUT_DEFAULT_MAX_AMOUNT_MINOR,
  SHORTCUT_MAX_ACTIVE_TOKENS_PER_USER,
  SHORTCUT_SCOPE_TRANSACTIONS_CREATE,
} from './shortcut-tokens.schema.js';

export class ShortcutTokenLimitError extends AppError {
  constructor() {
    super('Too many active shortcut tokens; revoke one before creating another', 409, 'SHORTCUT_TOKEN_LIMIT');
  }
}

export class ShortcutAmountLimitError extends AppError {
  constructor() {
    super('Amount exceeds the limit allowed for this shortcut token', 422, 'SHORTCUT_AMOUNT_LIMIT');
  }
}

export class ShortcutTokenInvalidError extends UnauthorizedError {
  constructor() {
    super('Shortcut token is invalid or revoked');
  }
}

export interface ShortcutTokenCreated {
  readonly tokenId: string;
  readonly token: string;
  readonly householdId: string;
  readonly maxAmountMinor: number;
  readonly scopes: string[];
}

export interface ShortcutTokenSummary {
  readonly id: string;
  readonly deviceName: string;
  readonly householdId: string;
  readonly scopes: string[];
  readonly maxAmountMinor: number;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface AuthenticatedShortcut {
  readonly tokenId: string;
  readonly userId: string;
  readonly householdId: string;
  readonly scopes: string[];
  readonly maxAmountMinor: number;
}

export async function createShortcutToken(input: {
  userId: string;
  householdId: string;
  deviceName: string;
}): Promise<ShortcutTokenCreated> {
  const { token, tokenHash } = generateShortcutToken();
  const row = await prisma.$transaction(async (tx) => {
    // Serialize per user so the active-token cap cannot be raced past.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shortcut-token:${input.userId}`}))`;
    const active = await tx.shortcutToken.count({ where: { userId: input.userId, revokedAt: null } });
    if (active >= SHORTCUT_MAX_ACTIVE_TOKENS_PER_USER) throw new ShortcutTokenLimitError();
    const created = await tx.shortcutToken.create({
      data: {
        userId: input.userId,
        householdId: input.householdId,
        deviceName: input.deviceName,
        tokenHash,
        scopes: [SHORTCUT_SCOPE_TRANSACTIONS_CREATE],
        maxAmountMinor: SHORTCUT_DEFAULT_MAX_AMOUNT_MINOR,
      },
    });
    await tx.shortcutTokenEvent.create({ data: { tokenId: created.id, action: 'CREATED', outcome: 'OK' } });
    return created;
  });
  return {
    tokenId: row.id,
    token,
    householdId: row.householdId,
    maxAmountMinor: row.maxAmountMinor,
    scopes: row.scopes,
  };
}

/** Lists the user's tokens. The hash and the raw token are never selected. */
export async function listShortcutTokens(userId: string): Promise<ShortcutTokenSummary[]> {
  return prisma.shortcutToken.findMany({
    where: { userId },
    select: {
      id: true,
      deviceName: true,
      householdId: true,
      scopes: true,
      maxAmountMinor: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/** Revokes a token owned by the user. Idempotent. Other users get 404, not 403, to avoid id probing. */
export async function revokeShortcutToken(userId: string, tokenId: string): Promise<void> {
  const token = await prisma.shortcutToken.findFirst({ where: { id: tokenId, userId } });
  if (!token) throw new NotFoundError('Shortcut token');
  if (token.revokedAt) return;
  await prisma.$transaction([
    prisma.shortcutToken.update({ where: { id: tokenId }, data: { revokedAt: new Date() } }),
    prisma.shortcutTokenEvent.create({ data: { tokenId, action: 'REVOKED', outcome: 'OK' } }),
  ]);
}

/**
 * Resolves a raw bearer token to its binding. Checks revocation and that the bound user is still
 * an EDITOR+ of the bound household at this moment, so removing a member cuts off their tokens.
 */
export async function authenticateShortcutToken(rawToken: string): Promise<AuthenticatedShortcut> {
  if (!isShortcutTokenShape(rawToken)) throw new ShortcutTokenInvalidError();

  const row = await prisma.shortcutToken.findUnique({ where: { tokenHash: hashShortcutToken(rawToken) } });
  if (!row) throw new ShortcutTokenInvalidError();

  if (row.revokedAt) {
    await recordShortcutEvent(row.id, 'REJECTED', 'REVOKED');
    throw new ShortcutTokenInvalidError();
  }

  const membership = await getHouseholdMembership(row.userId, row.householdId);
  if (!membership || !hasRoleLevel(membership.role, 'EDITOR')) {
    await recordShortcutEvent(row.id, 'REJECTED', 'NO_EDITOR_ROLE');
    throw new ForbiddenError('Token owner no longer has edit access to this household');
  }

  await prisma.shortcutToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  return {
    tokenId: row.id,
    userId: row.userId,
    householdId: row.householdId,
    scopes: row.scopes,
    maxAmountMinor: row.maxAmountMinor,
  };
}

export async function recordShortcutEvent(tokenId: string, action: 'USED' | 'REJECTED', outcome: string): Promise<void> {
  await prisma.shortcutTokenEvent.create({ data: { tokenId, action, outcome } });
}
