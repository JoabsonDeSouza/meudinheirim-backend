import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { createBudgetV1Schema, listBudgetsV1QuerySchema } from './budgets.v1.schema.js';
import { createBudgetV1, listBudgetsV1 } from './budgets.v1.service.js';

export async function budgetV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/', {
    schema: {
      description: 'List budgets grouped by currency; no cross-currency totals are returned',
      tags: ['Budgets'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['month'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
          type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
          currency: { type: 'string', enum: ['BRL', 'USD'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const query = listBudgetsV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send({ items: await listBudgetsV1(query, householdId) });
  });

  app.post('/', {
    schema: {
      description: 'Create a currency-specific budget using a MoneyDto limit',
      tags: ['Budgets'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['categoryCode', 'type', 'month', 'monthlyLimit'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          categoryCode: { type: 'string' },
          type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
          month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
          monthlyLimit: {
            type: 'object',
            required: ['minorUnits', 'currency'],
            properties: {
              minorUnits: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
              currency: { type: 'string', enum: ['BRL', 'USD'] },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      response: { 201: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const input = createBudgetV1Schema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const budget = await createBudgetV1(input, householdId);
    return reply.code(201).send(budget);
  });
}
