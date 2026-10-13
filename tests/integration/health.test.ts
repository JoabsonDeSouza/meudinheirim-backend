import { describe, expect, it } from 'vitest';

import { createTestApp } from '../helpers/app.js';

describe('GET /health', () => {
  it('responds 200 with status ok and timestamp/uptime', async () => {
    const app = await createTestApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      expect(body).toMatchObject({ status: 'ok' });
      expect(
        typeof (body as { uptime?: unknown }).uptime,
      ).toBe('number');
      expect(
        typeof (body as { timestamp?: unknown }).timestamp,
      ).toBe('string');
    } finally {
      await app.close();
    }
  });
});
