import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { getAuthUser } from '../../shared/auth/authenticate.js';
import {
  ensurePersonalHousehold,
  getUserByFirebaseUid,
  requireEditor,
} from '../../shared/middleware/authorization.middleware.js';
import {
  createShortcutTokenSchema,
  shortcutTokenIdParamSchema,
} from './shortcut-tokens.schema.js';
import {
  createShortcutToken,
  listShortcutTokens,
  revokeShortcutToken,
} from './shortcut-tokens.service.js';

/**
 * Token management for the signed-in user (Firebase auth). The raw token appears only in the
 * POST response; list and revoke never return it.
 */
export async function shortcutTokenManagementRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.post('/', {
    schema: {
      description: 'Create a device token that can only create expenses via /v1/shortcut/transactions. The token is shown once.',
      tags: ['Shortcuts'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['deviceName', 'scopes'],
        additionalProperties: false,
        properties: {
          deviceName: { type: 'string', minLength: 1, maxLength: 60 },
          scopes: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', enum: ['transactions:create'] } },
          householdId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const input = createShortcutTokenSchema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const created = await createShortcutToken({ userId: user.id, householdId, deviceName: input.deviceName });
    return reply.status(201).send({ success: true, data: created });
  });

  app.get('/', {
    schema: {
      description: 'List the signed-in user device tokens (metadata only, never the token)',
      tags: ['Shortcuts'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const items = await listShortcutTokens(user.id);
    return reply.send({ success: true, data: items });
  });

  app.delete<{ Params: { tokenId: string } }>('/:tokenId', {
    schema: {
      description: 'Revoke a device token immediately',
      tags: ['Shortcuts'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['tokenId'], properties: { tokenId: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { tokenId } = shortcutTokenIdParamSchema.parse(request.params);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    await revokeShortcutToken(user.id, tokenId);
    return reply.status(204).send();
  });
}
