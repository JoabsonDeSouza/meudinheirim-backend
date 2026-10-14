import { describe, expect, it } from 'vitest';

import { isOriginAllowed } from '../../src/shared/http/origin-policy.js';
import { buildReadinessResult } from '../../src/shared/ops/readiness.js';
import { toPublicError } from '../../src/shared/errors/public-error.js';
import { shouldEnableSwaggerUi } from '../../src/shared/http/swagger-policy.js';

describe('exact CORS origin policy', () => {
  it('allows only exact configured origins', () => {
    expect(isOriginAllowed('https://app.example.com', ['https://app.example.com'])).toBe(true);
    expect(isOriginAllowed('https://evilapp.example.com', ['https://app.example.com'])).toBe(false);
    expect(isOriginAllowed('https://app.example.com.attacker.test', ['https://app.example.com'])).toBe(false);
  });

  it('allows requests without an Origin header for native clients and command-line tools', () => {
    expect(isOriginAllowed(undefined, [])).toBe(true);
  });
});

describe('readiness result', () => {
  it('returns ready only when database, auth and migrations are all ready', () => {
    expect(buildReadinessResult({ database: true, auth: true, migrations: true })).toEqual({
      ready: true,
      code: 'READY',
    });
  });

  it('returns a stable not-ready result when any dependency is unavailable', () => {
    expect(buildReadinessResult({ database: true, auth: false, migrations: true })).toEqual({
      ready: false,
      code: 'NOT_READY',
    });
  });
});

describe('public errors', () => {
  it('returns stable error code and message without stack traces or internal details', () => {
    const response = toPublicError({
      name: 'Error',
      message: 'sensitive payload contains customer account data',
      stack: 'Error: sensitive payload\n at internal file',
    });
    expect(response).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId: 'unknown' },
    });
    expect(JSON.stringify(response).includes('stack')).toBe(false);
    expect(JSON.stringify(response).includes('customer account data')).toBe(false);
  });
});

describe('Swagger production policy', () => {
  it('disables Swagger UI by default in production', () => {
    expect(shouldEnableSwaggerUi(true, undefined, undefined)).toBe(false);
  });

  it('enables Swagger UI in production only with both credentials', () => {
    expect(shouldEnableSwaggerUi(true, 'operator', undefined)).toBe(false);
    expect(shouldEnableSwaggerUi(true, 'operator', 'secret')).toBe(true);
  });

  it('keeps Swagger UI available in non-production environments', () => {
    expect(shouldEnableSwaggerUi(false, undefined, undefined)).toBe(true);
  });
});
