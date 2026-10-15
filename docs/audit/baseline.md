# Backend Adaptation Baseline

Feature: `meudinheirim-backend-adaptation` · Recorded: 2026-10-13

## Repository materialization

| Item | Value |
| --- | --- |
| Fork / working repo (origin) | `https://github.com/JoabsonDeSouza/meudinheirim-backend.git` |
| Upstream (read-only, never pushed) | `https://github.com/lucianodiisouza/meudinheirim-selfhosted-backend.git` |
| Main checkout | `/Volumes/Joabson/Files/ProgramaDev/Project/meudinheirim-backend` @ `main` = `32b871373dfae77ea8178e2e03729b343d971b65` |
| Execution worktree | `/Users/joabson/.config/superpowers/worktrees/meudinheirim-backend/codex-recta-backend-adaptation` |
| Execution branch | `codex/recta-backend-adaptation` |
| Base commit of worktree | `32b871373dfae77ea8178e2e03729b343d971b65` (identical to audited SHA — **zero delta since audit**) |
| Pre-existing untracked/modified files on main checkout | none (`git status` clean; untracked plan docs live in the frontend repo) |

## Current scripts from `package.json`

| Script | Command | Purpose |
| --- | --- | --- |
| `dev` | `tsx watch src/index.ts` | local dev server |
| `build` | `npm run db:generate && tsc` | compile |
| `lint` | `eslint src --ext .ts` | lint |
| `typecheck` | `tsc --noEmit` | typecheck |
| `db:generate` / `db:migrate` / `db:deploy` | prisma | database |
| `db:push` | prisma db push | forbidden as release strategy (plan constraint) |

No test scripts exist yet (added in T2). Frontend referenced repo: `meudinherim` @ `9af9d54`, Expo SDK 57 (`expo ~57.0.27`).

## Baseline smoke results (this worktree, 2026-10-13)

| Check | Command | Result |
| --- | --- | --- |
| Prisma generate | `npx prisma generate` (client goes to `src/generated`, gitignored) | OK (7.2.0) |
| Typecheck | `npm run typecheck` | **PASS, 0 errors** (was failing only until client was generated) |
| Build | `npm run build` | **PASS** (exit 0) |
| Lint | `npm run lint` | **FAILS** — ESLint 8.57.1: no config file found (`npm init @eslint/config` never run) |
| Tests | — | none exist at baseline (harness added in T2) |
| Migrations deploy | `npx prisma migrate deploy` | **PASS** — 20 migrations applied from zero on disposable DB |
| `package-lock.json` | diff vs base | 2-line stale version sync (`0.4.0-beta` → matches `package.json` `0.5.0-beta`), produced by bare `npm install`; kept |
| Forbidden typing (`any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `<any>`) | `rg` on `src` | **0 matches at baseline** (strict gate to be re-implemented in T3 so it cannot regress) |

## Disposable PostgreSQL (development/test only)

| Item | Value |
| --- | --- |
| Provider | Docker · image `postgres:16-alpine` |
| Container | disposable PostgreSQL container (created for this baseline) |
| Port | `127.0.0.1:55455` (loopback only) |
| database / user / password | disposable baseline DB / `postgres` / disposable local password (not a secret; never committed) |
| Guard rule adopted in T2 | test DB helper must refuse any URL not pointed at `127.0.0.1`/`localhost` and not named like a disposable test DB |
| Production DBs contacted | none |

## Known failures / limitations recorded at baseline

1. `npm run lint` cannot run: repository ships no `.eslintrc` (fixed in T2/T3).
2. No automated tests, CI, or test DB guard exist (added in T2).
3. `tsconfig.json` excludes `src/modules/categories/categories.service.ts` (deliberate exclusion for typing escape — task for T3).
4. No `/ready` endpoint; Swagger unprotected by default; CORS handling to be hardened in T7.
5. Docker container created only for disposable dev/test baseline; removal is safe and local.

## Rules honored at baseline

- Upstream remote added for lineage only; no fetch/push performed against it after registration.
- No production database, deploy, push, PR, or remote change occurred.
