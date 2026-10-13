import { describe, expect, it } from 'vitest';

import { createTestApp } from '../helpers/app.js';
import type { FastifyInstance } from 'fastify';

describe('GET /v1/auth/config', () => {
  it('responds 200 with only public auth fields (mode and projectId)', async () => {
    const app: FastifyInstance = await createTestApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/auth/config',
      });
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      expect(body).toMatchObject({ mode: 'firebase' });
      expect((body as { projectId?: unknown }).projectId === null ||
        typeof (body as { projectId?: unknown }).projectId === 'string').toBe(true);
      const serialized = JSON.stringify(body);
      expect(serialized.includes('PRIVATE_KEY')).toBe(false);
      expect(serialized.includes('privateKey')).toBe(false);
      expect(serialized.includes('clientEmail')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
