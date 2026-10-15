import { describe, expect, it, vi } from 'vitest';



import type {
  createFakeTokenVerifier as FakeCreateTokenVerifier,
  setTokenVerifier as FakeSetTokenVerifier,
  FakeToken,
} from '../../src/shared/auth/token-verifier.js';
import { buildTestRequest } from '../helpers/request.js';

describe('token verifier registry', () => {
  async function load(): Promise<{ setTokenVerifier: typeof FakeSetTokenVerifier; createFakeTokenVerifier: typeof FakeCreateTokenVerifier }> {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/meudinheirim_test_unit';
    process.env.NODE_ENV = 'test';
    const { setTokenVerifier, createFakeTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
    return { setTokenVerifier, createFakeTokenVerifier };
  }

  it('returns the injected verifier given a token', async () => {
    const fakeToken: FakeToken = {
      uid: 'firebase-uid-1',
      email: 'user@example.com',
      emailVerified: true,
    };
    const { createFakeTokenVerifier, setTokenVerifier } = await load();
    const verifier = createFakeTokenVerifier(vi.fn(async (token: string): Promise<FakeToken> => {
      expect(token).toBe('some-jwt');
      return fakeToken;
    }));
    setTokenVerifier(verifier);

    const request = buildTestRequest('Bearer some-jwt');

    const { authenticateRequest } = await import('../../src/shared/auth/authenticate.js');
    const result = await authenticateRequest(request, { requireEmailVerified: true });
    expect(result.uid).toBe('firebase-uid-1');
  });

  it('throws UnauthorizedError when no bearer token is present', async () => {
    const request = buildTestRequest(undefined);
    const { authenticateRequest } = await import('../../src/shared/auth/authenticate.js');
    await expect(
      authenticateRequest(request, { requireEmailVerified: true }),
    ).rejects.toThrow(/bearer token required/i);
  });

  it("throws InvalidTokenError when the verifier rejects the token", async () => {
    const { setTokenVerifier, createFakeTokenVerifier } = await load();
    setTokenVerifier(createFakeTokenVerifier(
      vi.fn(async (): Promise<FakeToken> => {
        throw new Error('expired token');
      }),
    ));
    const request = buildTestRequest('Bearer stale');
    const { authenticateRequest } = await import('../../src/shared/auth/authenticate.js');
    await expect(
      authenticateRequest(request, { requireEmailVerified: false }),
    ).rejects.toThrow(/invalid/i);
  });

  it('throws EmailNotVerifiedError when email is unverified and required', async () => {
    const { setTokenVerifier, createFakeTokenVerifier } = await load();
    setTokenVerifier(createFakeTokenVerifier(
      vi.fn(async (): Promise<FakeToken> => ({ uid: 'u', email: 'a@b.c', emailVerified: false })),
    ));
    const request = buildTestRequest('Bearer x');
    const { authenticateRequest } = await import('../../src/shared/auth/authenticate.js');
    await expect(
      authenticateRequest(request, { requireEmailVerified: true }),
    ).rejects.toThrow(/email/i);
  });

  it('throws UnauthorizedError when the token misses an email', async () => {
    const { setTokenVerifier, createFakeTokenVerifier } = await load();
    setTokenVerifier(createFakeTokenVerifier(
      vi.fn(async (): Promise<FakeToken> => ({ uid: 'u', email: '', emailVerified: true })),
    ));
    const request = buildTestRequest('Bearer x');
    const { authenticateRequest } = await import('../../src/shared/auth/authenticate.js');
    await expect(
      authenticateRequest(request, { requireEmailVerified: false }),
    ).rejects.toThrow(/email/i);
  });
});
