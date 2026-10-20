import { getFirebaseAuth } from '../config/firebase.js';

export interface VerifiedToken {
  readonly uid: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export class FirebaseTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedToken> {
    const auth = getFirebaseAuth();
    const decodedToken = await auth.verifyIdToken(token);
    return {
      uid: decodedToken.uid,
      email: decodedToken.email ?? '',
      emailVerified: decodedToken.email_verified || false,
    };
  }
}

export interface FakeToken extends VerifiedToken {
  readonly invalidReason?: string;
}

/**
 * Creates a TokenVerifier backed by an in-process verification function.
 * Used by tests and by development bootstrapping flows; never registered by default.
 */
export function createFakeTokenVerifier(
  verify: (token: string) => Promise<FakeToken>,
): TokenVerifier & { verify: (token: string) => Promise<FakeToken> } {
  return {
    verify: async (token: string): Promise<FakeToken> => {
      const fake = await verify(token);
      return fake;
    },
  };
}

let activeVerifier: TokenVerifier | null = null;

/** Test/dev only: replaces the verifier used by authentication. */
export function setTokenVerifier(verifier: TokenVerifier | null): void {
  activeVerifier = verifier;
}

export function getTokenVerifier(): TokenVerifier {
  if (activeVerifier === null) {
    activeVerifier = new FirebaseTokenVerifier();
  }
  return activeVerifier;
}
