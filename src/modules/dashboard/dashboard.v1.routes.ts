import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { dashboardOverviewV1QuerySchema, dashboardRecentV1QuerySchema } from './dashboard.v1.schema.js';
import { getDashboardOverviewV1, getDashboardRecentTransactionsV1 } from './dashboard.v1.service.js';

const moneySchema = {
  type: 'object',
  required: ['minorUnits', 'currency'],
  properties: {
    minorUnits: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    currency: { type: 'string', enum: ['BRL', 'USD'] },
  },
  additionalProperties: false,
};

export async function dashboardV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/overview', {
    schema: {
      description: 'Get reconciled monthly income, expenses, and net balance grouped by currency',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['month'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object', required: ['month', 'byCurrency'],
          properties: {
            month: { type: 'string' },
            byCurrency: {
              type: 'array',
              items: {
                type: 'object', required: ['currency', 'income', 'expense', 'balance'],
                properties: {
                  currency: { type: 'string', enum: ['BRL', 'USD'] },
                  income: moneySchema,
                  expense: moneySchema,
                  balance: moneySchema,
                }, additionalProperties: false,
              },
            },
          }, additionalProperties: false,
        },
      },
    },
  }, async (request, reply) => {
    const query = dashboardOverviewV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await getDashboardOverviewV1(query, householdId));
  });

  app.get('/recent-transactions', {
    schema: {
      description: 'Get the ten latest non-deleted ledger transactions in deterministic order',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { householdId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object', required: ['items'],
          properties: {
            items: {
              type: 'array', maxItems: 10,
              items: {
                type: 'object',
                required: ['id', 'kind', 'amount', 'categoryCode', 'accountId', 'fromAccountId', 'toAccountId', 'invoiceId', 'installmentId', 'installmentNumber', 'totalInstallments', 'installmentTotalAmount', 'occurredAt', 'timeZone', 'note', 'paid', 'version', 'clientMutationId'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  kind: { type: 'string', enum: ['income', 'expense', 'transfer'] },
                  amount: moneySchema,
                  categoryCode: { type: ['string', 'null'] },
                  accountId: { type: ['string', 'null'], format: 'uuid' },
                  fromAccountId: { type: ['string', 'null'], format: 'uuid' },
                  toAccountId: { type: ['string', 'null'], format: 'uuid' },
                  invoiceId: { type: ['string', 'null'], format: 'uuid' },
                  installmentId: { type: ['string', 'null'], format: 'uuid' },
                  installmentNumber: { type: ['integer', 'null'], minimum: 1, maximum: 24 },
                  totalInstallments: { type: ['integer', 'null'], minimum: 2, maximum: 24 },
                  installmentTotalAmount: { anyOf: [moneySchema, { type: 'null' }] },
                  occurredAt: { type: 'string', format: 'date-time' },
                  timeZone: { type: 'string' },
                  note: { type: ['string', 'null'] },
                  paid: { type: 'boolean' },
                  version: { type: 'integer', minimum: 1 },
                  clientMutationId: { type: 'string', format: 'uuid' },
                }, additionalProperties: false,
              },
            },
          }, additionalProperties: false,
        },
      },
    },
  }, async (request, reply) => {
    const query = dashboardRecentV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await getDashboardRecentTransactionsV1(query, householdId));
  });
}
