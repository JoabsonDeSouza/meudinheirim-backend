import { ZodError } from 'zod';
import { AppError, ValidationError } from './app-error.js';

export interface PublicErrorResponse {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, string[]>;
  };
}

export interface PublicErrorResult {
  readonly statusCode: number;
  readonly body: PublicErrorResponse;
}

export function toPublicError(error: unknown): PublicErrorResponse {
  return toPublicErrorResult(error).body;
}

export function toPublicErrorResult(error: unknown): PublicErrorResult {
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
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
          ...(error instanceof ValidationError ? { details: error.details } : {}),
        },
      },
    };
  }

  if (typeof error === 'object' && error !== null && 'validation' in error) {
    return {
      statusCode: 400,
      body: {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
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
          error: { code: 'REQUEST_REJECTED', message: 'Request could not be processed' },
        },
      };
    }
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    },
  };
}
