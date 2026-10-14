import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { listCreditCardInvoicesV1 } from './invoices.v1.service.js';

const invoiceListQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  cardAccountId: z.string().uuid().optional(),
}).strict();

export async function creditCardInvoiceV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());
  app.get('/invoices', {
    schema: {
      description: 'List persisted credit-card billing cycles and invoices',
      tags: ['Credit Cards'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          cardAccountId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        },
      },
    },
  }, async (request, reply) => {
    const query = invoiceListQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send({ items: await listCreditCardInvoicesV1(householdId, query.cardAccountId) });
  });
}
