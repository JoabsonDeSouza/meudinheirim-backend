import { ZodError } from 'zod';
import { AppError, ValidationError } from './app-error.js';

export interface PublicErrorResponse {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly fieldErrors?: Record<string, string[]>;
  };
}

export interface PublicErrorResult {
  readonly statusCode: number;
  readonly body: PublicErrorResponse;
}

export function toPublicError(error: unknown, requestId = 'unknown'): PublicErrorResponse {
  const result = toPublicErrorResult(error);
  return {
    ...result.body,
    error: { ...result.body.error, requestId },
  };
}

export function toPublicErrorResult(error: unknown, requestId = 'unknown'): PublicErrorResult {
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', requestId },
      },
    };
  }

  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(error instanceof ValidationError ? { fieldErrors: error.details } : {}),
        },
      },
    };
  }

  if (typeof error === 'object' && error !== null && 'validation' in error) {
    return {
      statusCode: 400,
      body: {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', requestId },
      },
    };
  }

  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = error.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return {
        statusCode,
        body: {
          success: false,
          error: { code: 'REQUEST_REJECTED', message: 'Request could not be processed', requestId },
        },
      };
    }
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    },
  };
}
