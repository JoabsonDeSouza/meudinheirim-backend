import type { FastifyRequest } from 'fastify';
import { UnauthorizedError, InvalidTokenError, EmailNotVerifiedError } from '../errors/index.js';
import { getTokenVerifier } from './token-verifier.js';

export interface AuthUser {
  readonly uid: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface AuthenticateOptions {
  readonly requireEmailVerified?: boolean;
}

function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return null;
  }
  const [scheme, token] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }
  return token;
}

/**
 * Verifies the request's bearer token and returns the authenticated user.
 * Pure and transport-agnostic; Fastify middleware is a thin wrapper around it.
 */
export async function authenticateRequest(
  request: FastifyRequest,
  options: AuthenticateOptions = {},
): Promise<AuthUser> {
  const requireEmailVerified = options.requireEmailVerified ?? true;

  const token = extractBearerToken(request);
  if (!token) {
    throw new UnauthorizedError('Bearer token required');
  }

  let verified: { uid: string; email: string; emailVerified: boolean };
  try {
    verified = await (getTokenVerifier().verify(token));
  } catch (error) {
    request.log.warn(
      {
        requestId: request.id,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Token verification failed',
    );
    throw new InvalidTokenError();
  }

  if (requireEmailVerified && !verified.emailVerified) {
    throw new EmailNotVerifiedError();
  }

  if (!verified.email || verified.email.trim() === '') {
    throw new UnauthorizedError('Email is required for authentication');
  }

  return verified;
}

export function getAuthUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) {
    throw new UnauthorizedError('Authentication required');
  }
  return request.authUser;
}
