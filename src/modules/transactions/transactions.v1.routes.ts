import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, getUserByFirebaseUid, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { BadRequestError } from '../../shared/errors/index.js';
import { createTransactionV1Schema, listTransactionsV1QuerySchema, transactionV1HouseholdQuerySchema, transactionV1ParamsSchema, updateTransactionV1Schema } from './transactions.v1.schema.js';
import { createTransactionV1, listTransactionsV1, softDeleteTransactionV1, updateTransactionV1 } from './transactions.v1.service.js';
import { createTransferV1 } from './transfers.v1.service.js';
import { createTransferV1Schema } from './transfers.v1.schema.js';
import { createTransactionPlanV1 } from './transaction-plans.v1.service.js';
import { createTransactionPlanV1Schema } from './transaction-plans.v1.schema.js';

const transactionPlanMoneySchema = {
  type: 'object',
  required: ['minorUnits', 'currency'],
  properties: {
    minorUnits: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    currency: { type: 'string', enum: ['BRL', 'USD'] },
  },
  additionalProperties: false,
};

const transactionPlanTransactionProperties = {
  id: { type: 'string', format: 'uuid' },
  kind: { type: 'string', enum: ['expense', 'income'] },
  amount: transactionPlanMoneySchema,
  categoryCode: { type: 'string' },
  accountId: { type: 'string', format: 'uuid' },
  invoiceId: { type: ['string', 'null'], format: 'uuid' },
  occurredAt: { type: 'string', format: 'date-time' },
  timeZone: { type: 'string', maxLength: 64 },
  note: { type: ['string', 'null'], maxLength: 1000 },
  paid: { type: 'boolean' },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  deletedAt: { type: ['string', 'null'], format: 'date-time' },
  version: { type: 'integer', minimum: 1 },
  clientMutationId: { type: 'string', format: 'uuid' },
};

const transactionPlanTransactionRequired = Object.keys(transactionPlanTransactionProperties);

const recurringPlanDtoSchema = {
  type: 'object',
  required: ['id', 'accountId', 'categoryCode', 'amount', 'description', 'frequency', 'startDate', 'endDate', 'nextRunAt', 'lastRunDate', 'timeZone', 'isActive', 'kind', 'recurrenceMode', 'occurrencesLimit', 'anchorDay'],
  properties: {
    id: { type: 'string', format: 'uuid' }, accountId: { type: 'string', format: 'uuid' }, categoryCode: { type: 'string' },
    amount: transactionPlanMoneySchema, description: { type: ['string', 'null'], maxLength: 255 },
    frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY'] },
    startDate: { type: 'string', format: 'date' }, endDate: { type: ['string', 'null'], format: 'date' },
    nextRunAt: { type: 'string', format: 'date' }, lastRunDate: { type: ['string', 'null'], format: 'date' },
    timeZone: { type: 'string', maxLength: 64 }, isActive: { type: 'boolean' }, kind: { type: 'string', enum: ['FIXED', 'VARIABLE'] },
    recurrenceMode: { type: 'string', enum: ['ONCE', 'LIMITED', 'ALWAYS'] }, occurrencesLimit: { type: ['integer', 'null'], minimum: 1, maximum: 1200 },
    anchorDay: { type: 'integer', minimum: 1, maximum: 31 },
  },
  additionalProperties: false,
};

export async function transactionV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/', {
    schema: {
      description: 'List versioned finance transactions using MoneyDto and opaque cursor pagination',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          accountId: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['expense', 'income'] },
          categoryCode: { type: 'string' },
          occurredAfter: { type: 'string', format: 'date-time' },
          occurredBefore: { type: 'string', format: 'date-time' },
          cursor: { type: 'string', maxLength: 256 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pagination: {
              type: 'object',
              properties: {
                nextCursor: { type: ['string', 'null'] },
                hasMore: { type: 'boolean' },
                total: { type: 'integer' },
              },
              required: ['nextCursor', 'hasMore', 'total'],
            },
          },
          required: ['items', 'pagination'],
        },
      },
    },
  }, async (request, reply) => {
    const query = listTransactionsV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    const page = await listTransactionsV1(query, householdId);
    return reply.send(page);
  });

  app.post('/', {
    schema: {
      description: 'Create an income or expense transaction in the versioned contract',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['clientMutationId', 'kind', 'amount', 'categoryCode', 'accountId', 'occurredAt', 'timeZone'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          clientMutationId: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['expense', 'income'] },
          amount: {
            type: 'object',
            required: ['minorUnits', 'currency'],
            properties: {
              minorUnits: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
              currency: { type: 'string', enum: ['BRL', 'USD'] },
            },
            additionalProperties: false,
          },
          categoryCode: { type: 'string' },
          accountId: { type: 'string', format: 'uuid' },
          occurredAt: { type: 'string', format: 'date-time' },
          timeZone: { type: 'string', maxLength: 64 },
          note: { type: 'string', maxLength: 1000 },
          paid: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      response: {
        201: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const input = createTransactionV1Schema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const transaction = await createTransactionV1(input, householdId, user.id);
    return reply.code(201).send(transaction);
  });

  app.post('/plans', {
    schema: {
      description: 'Create a monthly credit-card installment plan or a monthly continuous recurring expense; the first occurrence is created atomically',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['clientMutationId', 'kind', 'totalAmount', 'categoryCode', 'accountId', 'occurredAt', 'timeZone', 'plan'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          clientMutationId: { type: 'string', format: 'uuid' },
          kind: { type: 'string', const: 'expense' },
          totalAmount: transactionPlanMoneySchema,
          categoryCode: { type: 'string' },
          accountId: { type: 'string', format: 'uuid' },
          occurredAt: { type: 'string', format: 'date-time' },
          timeZone: { type: 'string', minLength: 1, maxLength: 64 },
          note: { type: 'string', maxLength: 255 },
          paid: { type: 'boolean', default: true },
          plan: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string', enum: ['INSTALLMENTS', 'RECURRING_MONTHLY'] },
              count: { type: 'integer', minimum: 2, maximum: 6 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      response: {
        201: {
          oneOf: [
            {
              type: 'object', additionalProperties: false,
              required: ['type', 'installmentId', 'totalAmount', 'installmentCount', 'items'],
              properties: {
                type: { type: 'string', const: 'INSTALLMENTS' }, installmentId: { type: 'string', format: 'uuid' },
                totalAmount: transactionPlanMoneySchema, installmentCount: { type: 'integer', minimum: 2, maximum: 6 },
                items: {
                  type: 'array', minItems: 2, maxItems: 6,
                  items: {
                    type: 'object', additionalProperties: false,
                    required: [...transactionPlanTransactionRequired, 'installmentId', 'installmentNumber', 'totalInstallments'],
                    properties: {
                      ...transactionPlanTransactionProperties,
                      installmentId: { type: 'string', format: 'uuid' },
                      installmentNumber: { type: 'integer', minimum: 1, maximum: 6 },
                      totalInstallments: { type: 'integer', minimum: 2, maximum: 6 },
                    },
                  },
                },
              },
            },
            {
              type: 'object', additionalProperties: false, required: ['type', 'recurringTransaction', 'firstOccurrence'],
              properties: {
                type: { type: 'string', const: 'RECURRING_MONTHLY' },
                recurringTransaction: recurringPlanDtoSchema,
                firstOccurrence: { type: 'object', additionalProperties: false, required: transactionPlanTransactionRequired, properties: transactionPlanTransactionProperties },
              },
            },
          ],
        },
      },
    },
  }, async (request, reply) => {
    const input = createTransactionPlanV1Schema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const result = await createTransactionPlanV1(input, householdId, user.id);
    return reply.code(201).send(result);
  });

  app.post('/transfers', {
    schema: {
      description: 'Create an atomic double-entry transfer with account version checks',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['clientMutationId', 'fromAccountId', 'toAccountId', 'amount', 'expectedFromVersion', 'expectedToVersion', 'occurredAt', 'timeZone'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          clientMutationId: { type: 'string', format: 'uuid' },
          fromAccountId: { type: 'string', format: 'uuid' },
          toAccountId: { type: 'string', format: 'uuid' },
          amount: {
            type: 'object', required: ['minorUnits', 'currency'],
            properties: {
              minorUnits: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
              currency: { type: 'string', enum: ['BRL', 'USD'] },
            },
            additionalProperties: false,
          },
          expectedFromVersion: { type: 'integer', minimum: 1 },
          expectedToVersion: { type: 'integer', minimum: 1 },
          occurredAt: { type: 'string', format: 'date-time' },
          timeZone: { type: 'string', maxLength: 64 },
          note: { type: 'string', maxLength: 1000 },
        },
        additionalProperties: false,
      },
      response: { 201: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const input = createTransferV1Schema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const result = await createTransferV1(input, householdId, user.id);
    return reply.code(201).send(result);
  });

  app.patch<{ Params: { transactionId: string } }>('/:transactionId', {
    schema: {
      description: 'Update a versioned transaction',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['transactionId'],
        properties: { transactionId: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['clientMutationId', 'expectedVersion'],
        properties: {
          clientMutationId: { type: 'string', format: 'uuid' },
          expectedVersion: { type: 'integer', minimum: 1 },
          accountId: { type: 'string', format: 'uuid', description: 'Only recurring occurrence flows may reassign an unpaid occurrence account' },
          amount: {
            type: 'object',
            required: ['minorUnits', 'currency'],
            properties: {
              minorUnits: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
              currency: { type: 'string', enum: ['BRL', 'USD'] },
            },
            additionalProperties: false,
          },
          categoryCode: { type: 'string' },
          occurredAt: { type: 'string', format: 'date-time' },
          timeZone: { type: 'string', maxLength: 64 },
          note: { type: ['string', 'null'], maxLength: 1000 },
          paid: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      response: { 200: { type: 'object', additionalProperties: true } },
      querystring: {
        type: 'object',
        properties: { householdId: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => {
    const { transactionId } = transactionV1ParamsSchema.parse(request.params);
    const query = transactionV1HouseholdQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const input = updateTransactionV1Schema.parse(request.body);
    const transaction = await updateTransactionV1(transactionId, householdId, user.id, input);
    return reply.send(transaction);
  });

  app.delete<{ Params: { transactionId: string } }>('/:transactionId', {
    schema: {
      description: 'Soft-delete a versioned transaction',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['transactionId'],
        properties: { transactionId: { type: 'string', format: 'uuid' } },
      },
      querystring: {
        type: 'object',
        required: ['clientMutationId', 'expectedVersion'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          clientMutationId: { type: 'string', format: 'uuid' },
          expectedVersion: { type: 'integer', minimum: 1 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const { transactionId } = transactionV1ParamsSchema.parse(request.params);
    const query = transactionV1HouseholdQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    if (!query.clientMutationId || !query.expectedVersion) {
      throw new BadRequestError('clientMutationId and expectedVersion are required for delete');
    }
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const transaction = await softDeleteTransactionV1(
      transactionId,
      householdId,
      user.id,
      query.clientMutationId,
      query.expectedVersion,
    );
    return reply.send(transaction);
  });
}
