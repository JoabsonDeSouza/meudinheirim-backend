import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, getUserByFirebaseUid, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import {
  createRecurringV1Schema,
  createRecurringManagedV1Schema,
  payRecurringOccurrenceSchema,
  recurringOccurrenceQuerySchema,
  recurringV1IdParamSchema,
  updateRecurringV1Schema,
} from './recurring.v1.schema.js';
import {
  cancelRecurringV1,
  createRecurringV1,
  createRecurringManagedV1,
  listRecurringOccurrencesV1,
  listRecurringV1,
  listRecurringManagedV1,
  payRecurringOccurrenceV1,
  updateRecurringV1,
} from './recurring.v1.service.js';

const householdQuerySchema = z.object({ householdId: z.string().uuid().optional() }).strict();
const moneyOpenApiSchema = {
  type: 'object', required: ['minorUnits', 'currency'], additionalProperties: false,
  properties: { minorUnits: { type: 'integer' }, currency: { type: 'string', enum: ['BRL', 'USD'] } },
};
const recurringManagedDtoOpenApiSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'accountId', 'categoryCode', 'amount', 'description', 'frequency', 'kind', 'recurrenceMode', 'occurrencesLimit', 'anchorDay', 'startDate', 'endDate', 'nextRunAt', 'lastRunDate', 'timeZone', 'isActive'],
  properties: {
    id: { type: 'string', format: 'uuid' }, accountId: { type: 'string', format: 'uuid' }, categoryCode: { type: 'string' }, amount: moneyOpenApiSchema,
    description: { type: ['string', 'null'], maxLength: 255 }, frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY'] },
    kind: { type: 'string', enum: ['FIXED', 'VARIABLE'] }, recurrenceMode: { type: 'string', enum: ['ONCE', 'LIMITED', 'ALWAYS'] },
    occurrencesLimit: { type: ['integer', 'null'], minimum: 1, maximum: 1200 }, anchorDay: { type: 'integer', minimum: 1, maximum: 31 },
    startDate: { type: 'string', format: 'date' }, endDate: { type: ['string', 'null'], format: 'date' }, nextRunAt: { type: 'string', format: 'date' },
    lastRunDate: { type: ['string', 'null'], format: 'date' }, timeZone: { type: 'string', maxLength: 64 }, isActive: { type: 'boolean' },
  },
};

export async function recurringV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/occurrences', {
    schema: {
      description: 'Expand recurring schedules into occurrence statuses and currency-separated totals for a date range',
      tags: ['Recurring Transactions'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', required: ['from', 'to'], additionalProperties: false,
        properties: { householdId: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } },
      },
      response: { 200: { type: 'object', required: ['items', 'totalsByCurrency'], additionalProperties: false, properties: {
        items: { type: 'array', items: { type: 'object', required: ['recurringTransactionId', 'date', 'kind', 'amount', 'isEstimate', 'status', 'transactionId', 'transactionVersion', 'description', 'categoryCode', 'accountId'], additionalProperties: false, properties: {
          recurringTransactionId: { type: 'string', format: 'uuid' }, date: { type: 'string', format: 'date' }, kind: { type: 'string', enum: ['FIXED', 'VARIABLE'] }, amount: moneyOpenApiSchema,
          isEstimate: { type: 'boolean' }, status: { type: 'string', enum: ['PAID', 'PENDING', 'OVERDUE', 'SCHEDULED'] }, transactionId: { type: ['string', 'null'], format: 'uuid' },
          transactionVersion: { type: ['integer', 'null'] }, description: { type: ['string', 'null'] }, categoryCode: { type: 'string' }, accountId: { type: 'string', format: 'uuid' },
        } } },
        totalsByCurrency: { type: 'array', items: { type: 'object', required: ['currency', 'totalMinorUnits', 'paidMinorUnits', 'remainingMinorUnits', 'estimatedMinorUnits', 'paidPercent'], additionalProperties: false, properties: {
          currency: { type: 'string', enum: ['BRL', 'USD'] }, totalMinorUnits: { type: 'integer' }, paidMinorUnits: { type: 'integer' }, remainingMinorUnits: { type: 'integer' }, estimatedMinorUnits: { type: 'integer' }, paidPercent: { type: 'integer', minimum: 0, maximum: 100 },
        } } },
      } } },
    },
  }, async (request, reply) => {
    const query = recurringOccurrenceQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await listRecurringOccurrencesV1(householdId, query.from, query.to));
  });

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

  app.get('/managed', {
    schema: {
      description: 'List managed recurring schedules including fixed/variable and once/limited/always metadata',
      tags: ['Recurring Transactions'], security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { householdId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      response: { 200: { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: recurringManagedDtoOpenApiSchema } } } },
    },
  }, async (request, reply) => {
    const query = householdQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send({ items: await listRecurringManagedV1(householdId) });
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

  app.post('/managed', {
    schema: {
      description: 'Create managed fixed or variable recurring schedule with once, N-times, or unlimited repetition',
      tags: ['Recurring Transactions'], security: [{ bearerAuth: [] }],
      body: { type: 'object', required: ['accountId', 'categoryCode', 'amount', 'frequency', 'startDate', 'timeZone'], additionalProperties: false, properties: {
        householdId: { type: 'string', format: 'uuid' }, accountId: { type: 'string', format: 'uuid' }, categoryCode: { type: 'string' },
        amount: { type: 'object', required: ['minorUnits', 'currency'], additionalProperties: false, properties: { minorUnits: { type: 'integer', minimum: 1 }, currency: { type: 'string', enum: ['BRL', 'USD'] } } },
        description: { type: 'string', maxLength: 255 }, frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY'] },
        kind: { type: 'string', enum: ['FIXED', 'VARIABLE'], default: 'FIXED' }, recurrenceMode: { type: 'string', enum: ['ONCE', 'LIMITED', 'ALWAYS'] },
        occurrencesLimit: { type: 'integer', minimum: 1, maximum: 1200 }, startDate: { type: 'string', format: 'date' },
        endDate: { type: 'string', format: 'date' }, timeZone: { type: 'string', maxLength: 64 },
      } },
      response: { 201: recurringManagedDtoOpenApiSchema },
    },
  }, async (request, reply) => {
    const input = createRecurringManagedV1Schema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    return reply.code(201).send(await createRecurringManagedV1(input, householdId));
  });

  app.patch('/:recurringId', {
    schema: {
      description: 'Edit a recurring schedule; changes apply to future unpaid occurrences, preserving paid history',
      tags: ['Recurring Transactions'], security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['recurringId'], properties: { recurringId: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', properties: { householdId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
        accountId: { type: 'string', format: 'uuid', description: 'Account for future occurrences; currency must match the current schedule' },
        categoryCode: { type: 'string' },
        amount: { type: 'object', required: ['minorUnits', 'currency'], additionalProperties: false, properties: {
          minorUnits: { type: 'integer', minimum: 1 }, currency: { type: 'string', enum: ['BRL', 'USD'] },
        } },
        description: { type: ['string', 'null'], maxLength: 255 },
        frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY'] },
        kind: { type: 'string', enum: ['FIXED', 'VARIABLE'] },
        recurrenceMode: { type: 'string', enum: ['ONCE', 'LIMITED', 'ALWAYS'] },
        occurrencesLimit: { type: ['integer', 'null'], minimum: 1, maximum: 1200 },
        endDate: { type: ['string', 'null'], format: 'date' },
        timeZone: { type: 'string', maxLength: 64 },
      } },
      response: { 200: recurringManagedDtoOpenApiSchema },
    },
  }, async (request, reply) => {
    const { recurringId } = recurringV1IdParamSchema.parse(request.params);
    const input = updateRecurringV1Schema.parse(request.body);
    const query = householdQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    return reply.send(await updateRecurringV1(recurringId, householdId, input));
  });

  app.delete('/:recurringId', {
    schema: {
      description: 'Cancel future unpaid occurrences; preserve past occurrences and transactions',
      tags: ['Recurring Transactions'], security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['recurringId'], properties: { recurringId: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', properties: { householdId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      response: { 200: recurringManagedDtoOpenApiSchema },
    },
  }, async (request, reply) => {
    const { recurringId } = recurringV1IdParamSchema.parse(request.params);
    const query = householdQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    return reply.send(await cancelRecurringV1(recurringId, householdId));
  });

  app.post('/:recurringId/occurrences/:occurrenceDate/pay', {
    schema: {
      description: 'Record payment for a due occurrence and create/update its expense transaction atomically and idempotently',
      tags: ['Recurring Transactions'], security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['recurringId', 'occurrenceDate'], properties: {
        recurringId: { type: 'string', format: 'uuid' }, occurrenceDate: { type: 'string', format: 'date' },
      } },
      body: { type: 'object', required: ['amount', 'clientMutationId'], properties: {
        householdId: { type: 'string', format: 'uuid' },
        accountId: { type: 'string', format: 'uuid', description: 'Optional account for this unpaid occurrence; does not pay a credit-card invoice' },
        amount: { type: 'object', required: ['minorUnits', 'currency'], properties: {
          minorUnits: { type: 'integer', minimum: 1 }, currency: { type: 'string', enum: ['BRL', 'USD'] },
        }, additionalProperties: false }, clientMutationId: { type: 'string', format: 'uuid' },
      }, additionalProperties: false },
      response: { 200: { type: 'object', required: ['recurringTransactionId', 'date', 'transactionId', 'accountId', 'status', 'amount', 'replayed'], additionalProperties: false, properties: {
        recurringTransactionId: { type: 'string', format: 'uuid' }, date: { type: 'string', format: 'date' }, transactionId: { type: 'string', format: 'uuid' }, accountId: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['PAID'] }, amount: moneyOpenApiSchema, replayed: { type: 'boolean' },
      } } },
    },
  }, async (request, reply) => {
    const { recurringId, occurrenceDate } = z.object({ recurringId: z.string().uuid(), occurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().parse(request.params);
    const input = payRecurringOccurrenceSchema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const result = await payRecurringOccurrenceV1(recurringId, occurrenceDate, householdId, user.id, input);
    return reply.send(result);
  });
}
