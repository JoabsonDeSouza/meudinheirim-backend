import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { createTransactionV1Schema, listTransactionsV1QuerySchema, transactionV1HouseholdQuerySchema, transactionV1ParamsSchema, updateTransactionV1Schema } from './transactions.v1.schema.js';
import { createTransactionV1, listTransactionsV1, softDeleteTransactionV1, updateTransactionV1 } from './transactions.v1.service.js';

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
        required: ['kind', 'amount', 'categoryCode', 'accountId', 'occurredAt', 'timeZone'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
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
    const transaction = await createTransactionV1(input, householdId);
    return reply.code(201).send(transaction);
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
        properties: {
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
    const input = updateTransactionV1Schema.parse(request.body);
    const transaction = await updateTransactionV1(transactionId, householdId, input);
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
        properties: { householdId: { type: 'string', format: 'uuid' } },
      },
      response: { 204: { type: 'null' } },
    },
  }, async (request, reply) => {
    const { transactionId } = transactionV1ParamsSchema.parse(request.params);
    const query = transactionV1HouseholdQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    await softDeleteTransactionV1(transactionId, householdId);
    return reply.code(204).send();
  });
}
