import { describe, expect, it } from 'vitest';

import { assertDisposableTestDatabaseUrl } from '../helpers/test-db.js';

describe('disposable test database guard', () => {
  it('rejects a URL pointing at a production host', () => {
    expect(() =>
      assertDisposableTestDatabaseUrl(
        'postgresql://u:p@db.railway.internal:5432/meudinheirim_test_1',
      ),
    ).toThrow(/not a disposable test database/i);
  });

  it('rejects a URL containing "prod" in the database name', () => {
    expect(() =>
      assertDisposableTestDatabaseUrl(
        'postgresql://u:p@127.0.0.1:55455/meudinheirim_prod',
      ),
    ).toThrow(/not a disposable test database/i);
  });

  it('accepts a loopback disposable URL whose database name starts with meudinheirim_', () => {
    expect(() =>
      assertDisposableTestDatabaseUrl(
        'postgresql://postgres:disposable@127.0.0.1:55455/meudinheirim_test_abc',
      ),
    ).not.toThrow();
  });

  it('rejects a loopback disposable URL using a non-project prefix', () => {
    expect(() =>
      assertDisposableTestDatabaseUrl(
        'postgresql://postgres:disposable@127.0.0.1:55455/legacy_test_abc',
      ),
    ).toThrow(/not a disposable test database/i);
  });
});
