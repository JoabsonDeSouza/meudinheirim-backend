import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { toPublicErrorResult } from './public-error.js';

/** Public errors are stable and never contain stack traces or raw payload data. */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const errorCode = 'code' in error && typeof error.code === 'string' ? error.code : 'UNCLASSIFIED';
  request.log.error(
    { requestId: request.id, errorName: error.name, errorCode },
    'Request failed',
  );

  if (error.name === 'SyntaxError' && error.message.includes('JSON')) {
    reply.status(400).send({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Invalid JSON in request body', requestId: request.id },
    });
    return;
  }

  const result = toPublicErrorResult(error, request.id);
  reply.status(result.statusCode).send(result.body);
}
