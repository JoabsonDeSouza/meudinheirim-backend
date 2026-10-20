import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../../shared/middleware/authorization.middleware.js';
import { categoryMovementV1QuerySchema, monthlySeriesV1QuerySchema, spendingPatternsV1QuerySchema } from './insights.v1.schema.js';
import { getCategoryMovementV1, getMonthlySeriesV1, getSpendingPatternsV1 } from './insights.v1.service.js';

const moneySchema = {
  type: 'object',
  required: ['minorUnits', 'currency'],
  properties: {
    minorUnits: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    currency: { type: 'string', enum: ['BRL', 'USD'] },
  },
  additionalProperties: false,
};

function querySchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', required: [...required], properties, additionalProperties: false };
}

export async function insightsV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/monthly-series', {
    schema: {
      description: 'Return twelve timezone-bucketed months grouped by currency; these are Health Score inputs, not a calculated score',
      tags: ['Insights'],
      security: [{ bearerAuth: [] }],
      querystring: querySchema(['throughMonth', 'timeZone'], {
        householdId: { type: 'string', format: 'uuid' },
        throughMonth: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
        timeZone: { type: 'string', minLength: 1, maxLength: 64 },
      }),
      response: {
        200: {
          type: 'object', required: ['throughMonth', 'timeZone', 'byCurrency'],
          properties: {
            throughMonth: { type: 'string' }, timeZone: { type: 'string' },
            byCurrency: {
              type: 'array',
              items: {
                type: 'object', required: ['currency', 'months'],
                properties: {
                  currency: { type: 'string', enum: ['BRL', 'USD'] },
                  months: {
                    type: 'array', minItems: 12, maxItems: 12,
                    items: {
                      type: 'object', required: ['month', 'income', 'expense', 'cashFlow'],
                      properties: { month: { type: 'string' }, income: moneySchema, expense: moneySchema, cashFlow: moneySchema },
                      additionalProperties: false,
                    },
                  },
                }, additionalProperties: false,
              },
            },
          }, additionalProperties: false,
        },
      },
    },
  }, async (request, reply) => {
    const query = monthlySeriesV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await getMonthlySeriesV1(query, householdId));
  });

  app.get('/category-movement', {
    schema: {
      description: 'Compare current and previous month category totals by currency; changeRatio is null when the prior amount is zero',
      tags: ['Insights'],
      security: [{ bearerAuth: [] }],
      querystring: querySchema(['month', 'timeZone'], {
        householdId: { type: 'string', format: 'uuid' },
        month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
        timeZone: { type: 'string', minLength: 1, maxLength: 64 },
      }),
      response: {
        200: {
          type: 'object', required: ['month', 'previousMonth', 'timeZone', 'byCurrency'],
          properties: {
            month: { type: 'string' }, previousMonth: { type: 'string' }, timeZone: { type: 'string' },
            byCurrency: {
              type: 'array',
              items: {
                type: 'object', required: ['currency', 'movements'],
                properties: {
                  currency: { type: 'string', enum: ['BRL', 'USD'] },
                  movements: {
                    type: 'array',
                    items: {
                      type: 'object', required: ['categoryCode', 'kind', 'currentAmount', 'previousAmount', 'change', 'changeRatio'],
                      properties: {
                        categoryCode: { type: 'string' }, kind: { type: 'string', enum: ['income', 'expense'] },
                        currentAmount: moneySchema, previousAmount: moneySchema, change: moneySchema,
                        changeRatio: { type: ['number', 'null'] },
                      }, additionalProperties: false,
                    },
                  },
                }, additionalProperties: false,
              },
            },
          }, additionalProperties: false,
        },
      },
    },
  }, async (request, reply) => {
    const query = categoryMovementV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await getCategoryMovementV1(query, householdId));
  });

  app.get('/spending-patterns', {
    schema: {
      description: 'Compare average daily spend for the priciest weekday to the lowest-average weekday; factor is null for a zero baseline. Small spends use a required strict-under threshold.',
      tags: ['Insights'],
      security: [{ bearerAuth: [] }],
      querystring: querySchema(['month', 'timeZone', 'currency', 'smallSpendThresholdMinorUnits'], {
        householdId: { type: 'string', format: 'uuid' },
        month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
        timeZone: { type: 'string', minLength: 1, maxLength: 64 },
        currency: { type: 'string', enum: ['BRL', 'USD'] },
        smallSpendThresholdMinorUnits: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      }),
      response: {
        200: {
          type: 'object', required: ['month', 'currency', 'timeZone', 'priciestWeekday', 'smallSpends'],
          properties: {
            month: { type: 'string' }, currency: { type: 'string', enum: ['BRL', 'USD'] }, timeZone: { type: 'string' },
            priciestWeekday: {
              type: ['object', 'null'],
              required: ['weekday', 'comparedWeekday', 'factor'],
              properties: {
                weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'Local weekday number where Sunday is 0' },
                comparedWeekday: { type: 'integer', minimum: 0, maximum: 6, description: 'Compared local weekday number where Sunday is 0' },
                factor: { type: ['number', 'null'], exclusiveMinimum: 0 },
              }, additionalProperties: false,
            },
            smallSpends: {
              type: 'object', required: ['total', 'count', 'threshold'],
              properties: {
                total: moneySchema,
                count: { type: 'integer', minimum: 0 },
                threshold: moneySchema,
              }, additionalProperties: false,
            },
          }, additionalProperties: false,
        },
      },
    },
  }, async (request, reply) => {
    const query = spendingPatternsV1QuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send(await getSpendingPatternsV1(query, householdId));
  });
}
