import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../../shared/db/prisma.js';
import { ForbiddenError, UnauthorizedError } from '../../shared/errors/app-error.js';
import { createTransactionV1 } from '../transactions/transactions.v1.service.js';
import {
  SHORTCUT_RATE_LIMIT_PER_MINUTE,
  SHORTCUT_SCOPE_TRANSACTIONS_CREATE,
  shortcutTransactionSchema,
} from './shortcut-tokens.schema.js';
import {
  authenticateShortcutToken,
  recordShortcutEvent,
  ShortcutAmountLimitError,
} from './shortcut-tokens.service.js';

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedError('Bearer token required');
  return token;
}

/**
 * Shortcut/Wallet intent endpoint. Accepts ONLY device tokens (mdsc_...), never Firebase tokens,
 * so this route is registered without the Firebase auth hook.
 */
export async function shortcutTransactionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/transactions', {
    config: {
      rateLimit: {
        max: SHORTCUT_RATE_LIMIT_PER_MINUTE,
        timeWindow: '1 minute',
        // Keyed by the presented credential so one leaked token cannot exhaust another device's budget.
        keyGenerator: (request: FastifyRequest) => `shortcut:${createHash('sha256')
          .update(request.headers.authorization ?? request.ip)
          .digest('hex')}`,
      },
    },
    schema: {
      description: 'Create an expense with a device token (scope transactions:create). Idempotent by clientMutationId: 201 when created, 200 on replay.',
      tags: ['Shortcuts'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const auth = await authenticateShortcutToken(bearerToken(request));
    if (!auth.scopes.includes(SHORTCUT_SCOPE_TRANSACTIONS_CREATE)) {
      await recordShortcutEvent(auth.tokenId, 'REJECTED', 'SCOPE');
      throw new ForbiddenError('Token scope does not allow this action');
    }

    const parsed = shortcutTransactionSchema.safeParse(request.body);
    if (!parsed.success) {
      await recordShortcutEvent(auth.tokenId, 'REJECTED', 'VALIDATION');
      throw parsed.error;
    }
    const input = parsed.data;

    if (input.householdId && input.householdId !== auth.householdId) {
      await recordShortcutEvent(auth.tokenId, 'REJECTED', 'HOUSEHOLD_MISMATCH');
      throw new ForbiddenError('Token is not bound to this household');
    }
    if (input.amount.minorUnits > auth.maxAmountMinor) {
      await recordShortcutEvent(auth.tokenId, 'REJECTED', 'AMOUNT_LIMIT');
      throw new ShortcutAmountLimitError();
    }

    // Replay detection before the write. The write itself is still idempotent by (userId, clientMutationId).
    const existing = await prisma.syncMutation.findUnique({
      where: { userId_clientMutationId: { userId: auth.userId, clientMutationId: input.clientMutationId } },
      select: { id: true },
    });

    const dto = await createTransactionV1({
      clientMutationId: input.clientMutationId,
      kind: input.kind,
      amount: input.amount,
      categoryCode: input.categoryCode,
      accountId: input.accountId,
      occurredAt: input.occurredAt,
      timeZone: input.timeZone,
      note: input.note,
      paid: true,
    }, auth.householdId, auth.userId);

    const status = existing ? 200 : 201;
    await recordShortcutEvent(auth.tokenId, 'USED', String(status));
    return reply.status(status).send({ success: true, data: dto });
  });
}
