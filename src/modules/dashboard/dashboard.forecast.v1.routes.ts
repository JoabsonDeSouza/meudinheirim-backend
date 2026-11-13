import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import {
  dashboardMonthForecastV1QuerySchema,
  dashboardSpendingPaceV1QuerySchema,
} from './dashboard.forecast.v1.schema.js';
import { getMonthForecastV1, getSpendingPaceV1 } from './dashboard.forecast.v1.service.js';

const moneySchema = {
  type: 'object',
  required: ['minorUnits', 'currency'],
  properties: {
    minorUnits: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    currency: { type: 'string', enum: ['BRL', 'USD'] },
  },
  additionalProperties: false,
};

export async function dashboardForecastV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/month-forecast', {
    schema: {
      description: 'Estimate what is left at month end per currency: available balance minus pending recurring occurrences, unpaid card invoices due by month end, and the remaining variable spend projected from the last 3 full months. Estimate, not a bank statement.',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['month'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
          asOf: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object', required: ['month', 'asOf', 'byCurrency'],
          properties: {
            month: { type: 'string' },
            asOf: { type: 'string', format: 'date' },
            byCurrency: {
              type: 'array',
              items: {
                type: 'object',
                required: ['currency', 'availableBalance', 'pendingRecurring', 'openInvoices', 'variableRemaining', 'projectedLeftover'],
                properties: {
                  currency: { type: 'string', enum: ['BRL', 'USD'] },
                  availableBalance: moneySchema,
                  pendingRecurring: moneySchema,
                  openInvoices: moneySchema,
                  variableRemaining: moneySchema,
                  projectedLeftover: moneySchema,
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
  }, async (request, reply) => {
    const query = dashboardMonthForecastV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await getMonthForecastV1(query, householdId));
  });

  app.get('/spending-pace', {
    schema: {
      description: 'Expense total from day 1 to day N of the month versus the same window of the previous month, per currency. Excludes transfers and invoice payments. changeRatio is null when the previous total is zero.',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['month'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
          day: { type: 'integer', minimum: 1, maximum: 31 },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object', required: ['month', 'day', 'previousMonth', 'byCurrency'],
          properties: {
            month: { type: 'string' },
            day: { type: 'integer' },
            previousMonth: { type: 'string' },
            byCurrency: {
              type: 'array',
              items: {
                type: 'object',
                required: ['currency', 'currentToDate', 'previousToDate', 'changeRatio'],
                properties: {
                  currency: { type: 'string', enum: ['BRL', 'USD'] },
                  currentToDate: moneySchema,
                  previousToDate: moneySchema,
                  changeRatio: { type: ['number', 'null'] },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
  }, async (request, reply) => {
    const query = dashboardSpendingPaceV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await getSpendingPaceV1(query, householdId));
  });
}
