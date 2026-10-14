import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  paginationSchema,
  createPaginatedResponse,
} from '../../src/shared/utils/pagination.js';

describe('opaque cursor pagination', () => {
  it('round-trips a UUID through an opaque cursor', () => {
    const id = '5a7cde52-ae08-4ce0-92a4-c6a87127e130';
    const cursor = encodeCursor(id);
    expect(cursor).not.toBe(id);
    expect(decodeCursor(cursor)).toEqual({ id });
    expect(paginationSchema.parse({ cursor, limit: 10 }).cursor).toBe(id);
  });

  it('rejects malformed/tampered cursors with a stable error code', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrowError();
    try {
      decodeCursor('not-a-cursor');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
    }
    const valid = encodeCursor('5a7cde52-ae08-4ce0-92a4-c6a87127e130');
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decodeCursor(tampered)).toThrowError();
  });

  it('bounds page size and returns opaque nextCursor in stable order', () => {
    expect(paginationSchema.safeParse({ limit: 101 }).success).toBe(false);
    const response = createPaginatedResponse(
      [
        { id: '5a7cde52-ae08-4ce0-92a4-c6a87127e130' },
        { id: 'f531b2aa-0083-4f63-b0d1-5f9f1c3bce43' },
      ],
      1,
    );
    expect(response.data).toHaveLength(1);
    expect(response.pagination.hasMore).toBe(true);
    expect(decodeCursor(response.pagination.nextCursor ?? '').id).toBe(response.data[0].id);
  });
});
