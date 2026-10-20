import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { syncChangesQuerySchema } from '../../shared/sync/cursor.js';
import { listSyncChanges } from './sync.service.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/changes', {
    schema: {
      description: 'List monotonic upserts and tombstones after an opaque sync cursor',
      tags: ['Sync'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          cursor: { type: 'string', maxLength: 256 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          required: ['items', 'nextCursor', 'hasMore'],
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            nextCursor: { type: 'string' },
            hasMore: { type: 'boolean' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = syncChangesQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await listSyncChanges(query, householdId));
  });
}
