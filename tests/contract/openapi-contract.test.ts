import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createTestApp } from '../helpers/app.js';

interface OpenApiPath {
  readonly get?: unknown;
  readonly post?: unknown;
  readonly put?: unknown;
  readonly patch?: unknown;
  readonly delete?: unknown;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly paths: Readonly<Record<string, OpenApiPath>>;
  readonly components?: {
    readonly schemas?: Readonly<Record<string, unknown>>;
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('versioned OpenAPI contract', () => {
  it('documents versioned accounts and transaction paths', () => {
    const document = app.swagger() as OpenApiDocument;
    expect(document.openapi).toBe('3.0.0');
    expect(document.paths['/v1/accounts/']?.get).toBeDefined();
    expect(document.paths['/v1/accounts/']?.post).toBeDefined();
    expect(document.paths['/v1/transactions/']?.get).toBeDefined();
    expect(document.paths['/v1/transactions/']?.post).toBeDefined();
  });

  it('documents public auth configuration and health/readiness routes', () => {
    const document = app.swagger() as OpenApiDocument;
    expect(document.paths['/v1/auth/config']?.get).toBeDefined();
    expect(document.paths['/health']?.get).toBeDefined();
    expect(document.paths['/ready']?.get).toBeDefined();
  });

  it('publishes the shared typed error envelope schema', () => {
    const document = app.swagger() as OpenApiDocument;
    expect(document.components?.schemas?.ApiErrorDto).toBeDefined();
  });
});
