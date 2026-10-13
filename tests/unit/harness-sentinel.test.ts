import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('runs sentinel assertion', () => {
    expect(1 + 1).toBe(2);
  });
});
