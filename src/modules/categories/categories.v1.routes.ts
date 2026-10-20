import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import {
  ensurePersonalHousehold,
  requireEditor,
  requireHouseholdMember,
} from '../../shared/middleware/authorization.middleware.js';
import { toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { listCategoriesQuerySchema, createCategorySchema, getSystemCategoryCodes } from './categories.schema.js';
import * as categoriesService from './categories.service.js';

export async function categoryV1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware());

  app.get('/system', {
    schema: {
      description: 'List stable system category codes. Display labels are localized by the client.',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['code', 'type'],
                properties: {
                  code: { type: 'string' },
                  type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
                },
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
  }, async (_request, reply) => {
    return reply.send({ items: getSystemCategoryCodes() });
  });

  app.get('/', {
    schema: {
      description: 'List stable system category codes and household custom categories.',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
        },
      },
    },
  }, async (request, reply) => {
    const query = listCategoriesQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);

    const system = getSystemCategoryCodes()
      .filter((category) => query.type === undefined || category.type === query.type)
      .map((category) => ({
        code: category.code,
        type: category.type,
        isCustom: false,
      }));

    const custom = await categoriesService.listCategories({ householdId, type: query.type });
    const customDtos = custom.map((category) => ({
      code: toCustomCategoryName(category.id),
      id: category.id,
      name: category.name,
      type: category.type,
      icon: category.icon,
      color: category.color,
      isCustom: true,
    }));

    return reply.send({ items: [...system, ...customDtos] });
  });

  app.post('/custom', {
    schema: {
      description: 'Create a household custom category with UUID identity.',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const input = createCategorySchema.parse(request.body);
    const householdId = input.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    const category = await categoriesService.createCategory({ ...input, householdId });
    return reply.status(201).send({
      code: toCustomCategoryName(category.id),
      id: category.id,
      name: category.name,
      type: category.type,
      icon: category.icon,
      color: category.color,
      isCustom: true,
    });
  });
}
