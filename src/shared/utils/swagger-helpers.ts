/**
 * Helper functions for Swagger/OpenAPI documentation
 */

import type { FastifySchema } from 'fastify';

type RouteSchemaOptions = {
  description: string;
  tag: string;
  requiresAuth?: boolean;
  params?: FastifySchema['params'];
  querystring?: FastifySchema['querystring'];
  body?: FastifySchema['body'];
  response?: FastifySchema['response'];
};

export function createSwaggerSchema(options: RouteSchemaOptions): FastifySchema {
  const { description, tag, requiresAuth = true, params, querystring, body, response } = options;

  const schema: FastifySchema = {
    description,
    tags: [tag],
  };

  if (requiresAuth) {
    schema.security = [{ bearerAuth: [] }];
  }

  if (params) {
    schema.params = params;
  }

  if (querystring) {
    schema.querystring = querystring;
  }

  if (body) {
    schema.body = body;
  }

  if (response) {
    schema.response = response;
  } else {
    // Default response
    schema.response = {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object' },
        },
      },
    };
  }

  return schema;
}
