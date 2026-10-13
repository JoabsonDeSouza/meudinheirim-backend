import { describe, expect, it } from 'vitest';

import { parseEnvironment } from '../../src/shared/config/environment.js';

describe('parseEnvironment', () => {
  it('rejects a missing DATABASE_URL', () => {
    const result = parseEnvironment({ NODE_ENV: 'test' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid NODE_ENV', () => {
    const result = parseEnvironment({ DATABASE_URL: 'postgresql://u:p@localhost:5432/recta_x', NODE_ENV: 'staging' });
    expect(result.success).toBe(false);
  });

  it('accepts a minimal test environment with defaults', () => {
    const result = parseEnvironment({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/recta_x',
      NODE_ENV: 'test',
    });
    expect(result.success).toBe(true);
  });

  it('rejects production without Firebase credentials', () => {
    const result = parseEnvironment({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/recta_x',
      NODE_ENV: 'production',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors.firebase).toBeTruthy();
    }
  });

  it('accepts production with all individual Firebase credentials', () => {
    const result = parseEnvironment({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/recta_x',
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'project',
      FIREBASE_CLIENT_EMAIL: 'svc@project.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    });
    expect(result.success).toBe(true);
  });

  it('rejects that the parsed config exposes no private values on the public auth config surface', () => {
    const result = parseEnvironment({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/recta_x',
      NODE_ENV: 'test',
      FIREBASE_PROJECT_ID: 'project',
      FIREBASE_CLIENT_EMAIL: 'svc@project.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'private-key-material',
    });
    expect(result.success).toBe(true);
  });
});
