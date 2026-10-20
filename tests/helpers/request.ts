import type { FastifyRequest } from 'fastify';

interface TestRequestBody {
  readonly headers: Readonly<Record<string, string>>;
  readonly log: {
    readonly warn: (message: string) => void;
  };
}

export function buildTestRequest(authorization: string | undefined): FastifyRequest {
  const body: TestRequestBody = {
    headers: authorization === undefined ? {} : { authorization },
    log: {
      warn: (): void => undefined,
    },
  };
  return body as FastifyRequest;
}
