import type { FastifyInstance } from 'fastify';

import { env } from '../../shared/config/env.js';

interface AuthConfigResponse {
  readonly mode: 'firebase';
  readonly projectId: string | null;
}

export function getPublicAuthConfig(): AuthConfigResponse {
  return {
    mode: 'firebase',
    projectId: env.FIREBASE_PROJECT_ID ?? null,
  };
}

export async function authConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/config',
    {
      schema: {
        description: 'Public authentication configuration for clients',
        tags: ['Auth'],
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['firebase'] },
              projectId: { type: ['string', 'null'] },
            },
            required: ['mode', 'projectId'],
            additionalProperties: false,
          },
        },
      },
    },
    async (request, reply): Promise<void> => {
      void request;
      await reply.send(getPublicAuthConfig());
    },
  );
}
