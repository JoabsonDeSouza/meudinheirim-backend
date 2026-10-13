# Backend test environment

Copy values locally; never commit real credentials.

```bash
# Disposable PostgreSQL (localhost only; database name must start with "recta_")
# Point at the dedicated test/admin DB used by test helpers (databases are created per test run).
DATABASE_URL="postgresql://postgres:<local-password>@127.0.0.1:55455/recta_test_admin"
TEST_DATABASE_URL="postgresql://postgres:<local-password>@127.0.0.1:55455/recta_test_admin"
```

The helper `tests/helpers/test-db.ts` refuses any URL whose host is not
`localhost`/`127.0.0.1`, whose database name does not start with `recta_`, or
whose name matches production-like patterns (`prod`, `production`, `staging`).

Run gates:

```bash
TEST_DATABASE_URL=... npm run test:unit
TEST_DATABASE_URL=... npm run test:integration
```
