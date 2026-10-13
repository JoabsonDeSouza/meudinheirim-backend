import type { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '../errors/index.js';
import { authenticateRequest, getAuthUser } from '../auth/authenticate.js';

import type { AuthUser as AuthUserType } from '../auth/authenticate.js';

type AuthUser = AuthUserType;
export { getAuthUser };

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

export interface AuthMiddlewareOptions {
  requireEmailVerified?: boolean;
}

export function authMiddleware(options: AuthMiddlewareOptions = {}): (request: FastifyRequest, _reply: FastifyReply) => Promise<void> {
  const { requireEmailVerified = true } = options;

  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authUser = await authenticateRequest(request, { requireEmailVerified });
    request.authUser = {
      uid: authUser.uid,
      email: authUser.email,
      emailVerified: authUser.emailVerified,
    };
  };
}

export { UnauthorizedError };
