import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { createRecurringV1Schema } from './recurring.v1.schema.js';
import { createRecurringV1, listRecurringV1 } from './recurring.v1.service.js';

const householdQuerySchema = z.object({ householdId: z.string().uuid().optional() }).strict();

export async function recurringV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/', {
    schema: {
      description: 'List recurring schedules with currency-safe MoneyDto amounts',
      tags: ['Recurring Transactions'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { householdId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const query = householdQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send({ items: await listRecurringV1(householdId) });
  });

  app.post('/', {
    schema: {
      description: 'Create a recurring schedule with MoneyDto and an explicit IANA time zone',
      tags: ['Recurring Transactions'],
      security: [{ bearerAuth: [] }],
      response: { 201: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const input = createRecurringV1Schema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    return reply.code(201).send(await createRecurringV1(input, householdId));
  });
}
