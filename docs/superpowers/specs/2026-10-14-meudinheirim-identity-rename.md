# Meudinheirim Identity Rename

## Goal

Use Meudinheirim as the sole product identity in the backend's tracked content, replacing the previous product name in source, runtime metadata, configuration examples, tests, CI, API tooling, and historical documentation.

## Scope

- Replace case-insensitive occurrences of the old identity in tracked backend files, preserving appropriate capitalization (`Meudinheirim` in titles and `meudinheirim` in identifiers).
- Rename package metadata in `package.json` and `package-lock.json`.
- Update database examples and the disposable test-database prefix, including test guards, fixtures, CI service configuration, and test-environment docs.
- Update README, Prisma comments, OpenAPI title, startup logs, Insomnia collections, templates, audit records, and execution ledger.
- Mechanically replace the identity in URLs and historical provenance text as approved. These transformed URLs are not asserted to be reachable or owned by Meudinheirim.
- Exclude Git internals, branch/worktree names, external repository paths that are not tracked content, generated dependencies/build output, and user-local `.env` files.

## Compatibility and safety

- No route paths, request/response contracts, authentication behavior, database schema, or persisted data are changed.
- Test database protections remain strict: test URLs must use loopback, have the new project-specific prefix, and must not target production-like database names.
- Developers with existing local database names may need to update `DATABASE_URL` and `TEST_DATABASE_URL`; the rename does not rename or migrate databases automatically.
- Package lock metadata must remain synchronized with `package.json`.
- URLs changed by literal identity replacement require manual correction if the project has canonical domains or repository URLs.

## Verification

- Search tracked backend content for any remaining old identity, excluding Git internals and generated/dependency output.
- Run test database guard and environment tests, unit/contract/security suites, lint, typecheck, migration tests, build, and `git diff --check`.
- Confirm the project and lockfile package names match and the CI database name satisfies the updated test guard.
