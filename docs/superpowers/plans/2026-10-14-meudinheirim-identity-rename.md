# Meudinheirim Identity Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every old product identity reference in tracked backend content with Meudinheirim while keeping database safety guards and build/test configuration correct.

**Architecture:** This is a content and identifier rename, not a runtime API or data-model change. Update the disposable-database prefix and its tests in a test-first step, then rename all matching tracked text and synchronize package-lock metadata. Preserve Git internals, local environment files, generated output, and external path/branch names; mechanically renamed URLs are not assumed to work.

**Tech Stack:** Node.js 20+, TypeScript, Fastify, Prisma, Vitest, npm, GitHub Actions, PostgreSQL.

---

### Task 1: Change the disposable database guard contract test first

**Files:**
- Modify: `tests/unit/test-db-guard.test.ts`
- Test: `tests/unit/test-db-guard.test.ts`

- [x] **Step 1: Update the unit test with the target prefix and non-project rejection**

Change the acceptance description and URL to use `meudinheirim_`, and add an explicit rejection case for a loopback database whose name uses a non-project prefix. Keep the production-host and production-like-name rejection cases.

```ts
it('accepts a loopback disposable URL whose database name starts with meudinheirim_', () => {
  expect(() => assertDisposableTestDatabaseUrl(
    'postgresql://postgres:disposable@127.0.0.1:55455/meudinheirim_test_abc',
  )).not.toThrow();
});

it('rejects a loopback disposable URL using a non-project prefix', () => {
  expect(() => assertDisposableTestDatabaseUrl(
    'postgresql://postgres:disposable@127.0.0.1:55455/legacy_test_abc',
  )).toThrow(/not a disposable test database/i);
});
```

- [x] **Step 2: Run the guard test and confirm the intended failure**

Run: `npm run test:unit -- tests/unit/test-db-guard.test.ts`

Expected: the new-prefix acceptance fails because the current helper still requires the previous prefix; production-host, unsafe-name, and non-project-prefix rejection cases pass.

### Task 2: Rename all tracked backend identity references

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `env.example`, `env.template`, `.github/workflows/ci.yml`
- Modify: `tests/helpers/test-db.ts`, `scripts/db/deploy-test.ts`, `tests/unit/test-db-guard.test.ts`, `tests/integration/test-db-isolation.test.ts`, `tests/unit/environment.test.ts`, `tests/unit/token-verifier.test.ts`
- Modify: `README.md`, `src/app.ts`, `prisma/schema.prisma`, `insomnia-collection.json`, `insomnia-collection.yaml`, `src/shared/templates/email-newsletter.html`
- Modify: `docs/audit/baseline.md`, `docs/audit/category-contract.md`, `docs/development/test-environment.md`, `.specs/STATE.md`, migration documentation containing the old database example

- [x] **Step 1: Replace project identifiers and update the database safety guard**

Use `Meudinheirim` in human-facing brand text and `meudinheirim` in package names, database names, and identifiers. In `tests/helpers/test-db.ts` and `scripts/db/deploy-test.ts`, require the `meudinheirim_` prefix and generate isolated databases as `meudinheirim_test_<random hex>`. Keep loopback-only and production-like-name rejection unchanged. Update every test fixture and assertion to use the new prefix except the explicit non-project-prefix rejection test from Task 1.

- [x] **Step 2: Synchronize package metadata and operational examples**

Set `package.json` package name to `meudinheirim-backend` and update `package-lock.json` root/package names to match using `npm install --package-lock-only`. Change the CI Postgres DB and password labels, sample `DATABASE_URL`s, Insomnia collection names, Swagger title, startup log, Prisma comment, README branding, newsletter branding/links, and recorded audit/history text. Apply the approved literal replacement in URLs; do not claim transformed domains or repository URLs are valid.

- [x] **Step 3: Re-run the database guard test**

Run: `npm run test:unit -- tests/unit/test-db-guard.test.ts`

Expected: all guard tests pass, accepting only loopback database names with the new project prefix and still rejecting unsafe hosts/names and non-project prefixes.

### Task 3: Search for stale references and verify all backend gates

**Files:**
- Verify: all tracked backend text files

- [x] **Step 1: Confirm there are no remaining old identity strings in tracked content**

Run: `git grep -ni 'r[e][c][t][a]' -- ':!.git' ':!node_modules' ':!dist'`

Expected: only the documented current worktree/branch and source-plan paths in `.specs/STATE.md` and `docs/audit/baseline.md` remain. These technical path records are excluded from rename by the approved scope. No product, package, database, runtime, template, or external URL references should remain.

- [x] **Step 2: Verify package metadata and CI/test database naming**

Run: `node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(p.name!=='meudinheirim-backend'||l.name!==p.name||l.packages[''].name!==p.name) process.exit(1)"`

Expected: exit code 0. Confirm `.github/workflows/ci.yml` uses a disposable database beginning with `meudinheirim_` and `scripts/db/deploy-test.ts` enforces the same prefix.

- [x] **Step 3: Run backend verification gates**

Run: `npm run lint && npm run typecheck && npm run gate:forbidden-typing && npm run test:unit && npm run test:integration && npm run test:contract && npm run test:security && npm run db:deploy:test && npm run test:migrations && npm run build`

Expected: every command passes using the disposable local PostgreSQL instance and test URL configured in `docs/development/test-environment.md`.

- [x] **Step 4: Review and commit the rename**

Run: `git diff --check`, review `git status --short`, `git diff --stat`, and the full diff. Stage only the rename implementation files and commit as:

```bash
git add package.json package-lock.json env.example env.template .github/workflows/ci.yml tests scripts src README.md prisma insomnia-collection.json insomnia-collection.yaml docs .specs
git diff --cached --check
git commit -m "refactor: rename backend identity to meudinheirim"
```

Expected: commit succeeds, the tracked-content search remains empty, and the worktree is clean.
