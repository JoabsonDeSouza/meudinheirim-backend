# Backend Development Rules

## Scope and contracts

- This repository is the backend. Keep API changes aligned with the documented `/v1` contracts; coordinate frontend changes separately.
- Stack: Node.js 20+, TypeScript/ESM, Fastify, Zod, Prisma/PostgreSQL, Firebase Admin.
- Require Firebase authentication and verify household membership/ownership on every household-scoped operation. Never trust ownership or other server-managed fields from request bodies.
- Validate inputs with strict Zod schemas and keep Fastify/OpenAPI schemas in sync.
- Keep money exact: use integer minor units in API DTOs and keep currencies separate. Do not add implicit currency conversion.
- Make related financial writes atomic and idempotent where the contract requires it.

## Data and security

- Change the Prisma schema through reviewed migrations. Inspect generated SQL for drift and data effects; generate the Prisma client after schema changes. Do not use `db push` to bypass migrations.
- Use only disposable local PostgreSQL databases for tests. Check `DATABASE_URL` before migration commands; production/staging migrations require explicit authorization.
- Never commit `.env`, Firebase service-account files, credentials, tokens, or real user data. Do not log secrets or sensitive request bodies.
- Preserve existing user changes. Do not push, deploy, or modify remote state without explicit authorization.

## Workflow and verification

- Inspect the affected routes, services, schemas, migrations, tests, and project docs before changing behavior.
- Use `tlc-spec-driven` for nontrivial features and `.specs` requirements/tasks; use `systematic-debugging` for failures. Follow `test-driven-development` for behavior changes and bug fixes and `verification-before-completion` before reporting done.
- Keep tasks scoped and atomic; run each task's gate before its Conventional Commit. Independently verify feature acceptance outcomes before declaring completion.
- Run `npm run db:generate` after Prisma schema changes. Integration tests require `TEST_DATABASE_URL` pointing to the disposable local test database.
- Run affected tests plus lint/typecheck. For broad or schema changes, run the CI gates: `gate:forbidden-typing`, lint, typecheck, unit, integration, contract, security, `db:deploy:test`, migrations, and build. Integration tests require `TEST_DATABASE_URL` for disposable local PostgreSQL.
