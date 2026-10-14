import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, getUserByFirebaseUid, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { closeInvoiceSchema, invoiceIdParamsSchema, payInvoiceV1Schema, refundInvoiceV1Schema } from './invoice-lifecycle.schema.js';
import { closeInvoiceV1, payInvoiceV1, refundInvoiceV1 } from './application/invoice-lifecycle.service.js';
import { listCreditCardInvoicesV1 } from './invoices.v1.service.js';

const invoiceListQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  cardAccountId: z.string().uuid().optional(),
}).strict();

export async function creditCardInvoiceV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());
  const lifecycleHouseholdQuerySchema = z.object({ householdId: z.string().uuid().optional() }).strict();
  app.post<{ Params: { invoiceId: string } }>('/invoices/:invoiceId/close', {
    schema: {
      description: 'Close an open persisted credit-card invoice with optimistic versioning',
      tags: ['Credit Cards'], security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['invoiceId'], properties: { invoiceId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      querystring: { type: 'object', properties: { householdId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      body: { type: 'object', required: ['clientMutationId', 'expectedVersion'], properties: { clientMutationId: { type: 'string', format: 'uuid' }, expectedVersion: { type: 'integer', minimum: 1 } }, additionalProperties: false },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const { invoiceId } = invoiceIdParamsSchema.parse(request.params);
    const { householdId: requestedHouseholdId } = lifecycleHouseholdQuerySchema.parse(request.query);
    const input = closeInvoiceSchema.parse(request.body);
    const householdId = requestedHouseholdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    return reply.send(await closeInvoiceV1(invoiceId, householdId, user.id, input));
  });

  app.post<{ Params: { invoiceId: string } }>('/invoices/:invoiceId/pay', {
    schema: {
      description: 'Pay all or part of a closed invoice atomically from a same-currency bank account',
      tags: ['Credit Cards'], security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['invoiceId'], properties: { invoiceId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      querystring: { type: 'object', properties: { householdId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      body: {
        type: 'object', required: ['clientMutationId', 'expectedVersion', 'sourceAccountId', 'expectedSourceVersion', 'expectedCardVersion', 'timeZone'],
        properties: {
          clientMutationId: { type: 'string', format: 'uuid' }, expectedVersion: { type: 'integer', minimum: 1 }, sourceAccountId: { type: 'string', format: 'uuid' },
          expectedSourceVersion: { type: 'integer', minimum: 1 }, expectedCardVersion: { type: 'integer', minimum: 1 },
          amount: {
            type: 'object', required: ['minorUnits', 'currency'],
            properties: {
              minorUnits: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
              currency: { type: 'string', enum: ['BRL', 'USD'] },
            }, additionalProperties: false,
          },
          timeZone: { type: 'string', minLength: 1, maxLength: 64 },
        }, additionalProperties: false,
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const { invoiceId } = invoiceIdParamsSchema.parse(request.params);
    const { householdId: requestedHouseholdId } = lifecycleHouseholdQuerySchema.parse(request.query);
    const input = payInvoiceV1Schema.parse(request.body);
    const householdId = requestedHouseholdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    return reply.send(await payInvoiceV1(invoiceId, householdId, user.id, input));
  });

  app.post<{ Params: { invoiceId: string } }>('/invoices/:invoiceId/refund', {
    schema: {
      description: 'Refund a persisted invoice payment atomically with account reconciliation',
      tags: ['Credit Cards'], security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['invoiceId'], properties: { invoiceId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      querystring: { type: 'object', properties: { householdId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      body: {
        type: 'object', required: ['clientMutationId', 'expectedVersion', 'paymentId', 'expectedSourceVersion', 'expectedCardVersion', 'timeZone'],
        properties: {
          clientMutationId: { type: 'string', format: 'uuid' }, expectedVersion: { type: 'integer', minimum: 1 }, paymentId: { type: 'string', format: 'uuid' },
          expectedSourceVersion: { type: 'integer', minimum: 1 }, expectedCardVersion: { type: 'integer', minimum: 1 }, timeZone: { type: 'string', minLength: 1, maxLength: 64 },
        }, additionalProperties: false,
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const { invoiceId } = invoiceIdParamsSchema.parse(request.params);
    const { householdId: requestedHouseholdId } = lifecycleHouseholdQuerySchema.parse(request.query);
    const input = refundInvoiceV1Schema.parse(request.body);
    const householdId = requestedHouseholdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    return reply.send(await refundInvoiceV1(invoiceId, householdId, user.id, input));
  });

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
