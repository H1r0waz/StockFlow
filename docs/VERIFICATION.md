# Phase 0–1 verification

Date: 2026-10-16 (America/Argentina/Buenos_Aires).
Scope: design and technical bootstrap, not the inventory MVP.

## Environment and version selection

- Observed local runtime: Node 24.14.1, npm 11.11.0, Git 2.55.0.windows.5.
- Registry metadata was queried before installation. Selected React/React DOM
  19.3.1, Vite 8.3.4, Tailwind 4.3.3, Express 5.3.0, Prisma/client 7.10.1,
  TypeScript 6.0.3, Vitest 5.0.5, Playwright 1.64.1, ESLint 10.13.0,
  typescript-eslint 8.71.2 and Prettier 3.9.10.
- Prisma latest tag pointed to 8.0.0-rc.23; selected stable 7.10.1 instead.
- TypeScript latest was 7.0.2; selected 6.0.3 for the linter peer range.
- jsdom 30.1.3 required Node >=24.15 on the Node 24 line; selected verified
  compatible jsdom 29.0.1 instead. The local runtime was not modified.
- Initial registry access failed DNS resolution inside the sandbox. Network
  access for registry queries/install required tool approval. No cloud service,
  external database, connector, global package or Codex configuration was changed.
- An incomplete installation failed esbuild executable validation with EFTYPE.
  Only generated dependency directories inside the verified workspace were
  removed before a clean reinstall; no source or other project was removed.

## Verification results

| Command/check                                                                                        | Observed result                                    | Scope                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm install --cache .cache/npm --no-audit --no-fund`                                                | APROBADO: 435 packages added on clean installation | Project-local dependencies; no audit scan performed                      |
| `npm install --package-lock-only --ignore-scripts --offline --cache .cache/npm --no-audit --no-fund` | APROBADO                                           | Lockfile synchronized after pinning installed direct dependency versions |
| `npm run lint`                                                                                       | APROBADO, exit 0                                   | ESLint across source/configuration                                       |
| `npm run typecheck`                                                                                  | APROBADO, exit 0                                   | Playwright tooling, API, web and shared workspace                        |
| `npm test`                                                                                           | APROBADO: 3 API tests + 1 frontend test            | HTTP liveness/404/parser error and component smoke                       |
| `npm run build`                                                                                      | APROBADO, exit 0                                   | API TypeScript output and Vite production bundle                         |
| `npm run prisma:validate`                                                                            | APROBADO                                           | Foundational schema syntax/relations; no database connection             |
| `npm run prisma:generate`                                                                            | APROBADO: client 7.10.1 generated                  | Reproducible ignored generated client; not a database test               |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`                                                         | APROBADO: 1 test, 12.1 seconds                     | Installed Chrome, real web page and HTTP API, managed local servers      |

The Playwright environment-variable notation above is shell-neutral shorthand;
in PowerShell use `$env:PLAYWRIGHT_CHANNEL = 'chrome'; npm run test:e2e`.
Supertest initially failed EACCES on loopback connections inside the sandbox;
rerunning with tool approval passed. The first frontend smoke found missing
whitespace in the accessible heading; explicit whitespace fixed it. The initial
tooling typecheck found a missing Node types declaration, which was corrected.
Both frontend/backend builds were executed again after the source correction.
Final `npm run format:check` passed after formatting the two corrected source
files. A local Markdown-link check resolved 15 links across README, design docs,
verification and ADR. Git status showed only the expected untracked foundation
files, no remote, and no commit. `git diff --check` reported no tracked diff
issues; because all new files are untracked, this is not a whitespace check of
their content (Prettier provides that coverage). AGENTS.md retained its hash.

## Scope limits

PostgreSQL integration, applied migrations, negative-stock enforcement, tenant
authorization, transfer atomicity, partial receipt races, retry/idempotency
behavior and production deployment are **NO VERIFICADO**. No PostgreSQL instance
was connected, created or started. The future acceptance matrix is in
[inventory invariants](INVENTORY_INVARIANTS.md).

Three auxiliary agents owned disjoint documentation, API and web paths. The
primary agent owned root configuration, integration, review and verification.
Review reconciled schema roles with the domain, clarified organization/membership
lock ordering and last-owner serialization, and corrected purchase-line wording
so received counters remain mutable only through receipt transactions.

AGENTS.md was preserved with SHA-256
`829D997CF41A17BF69A6FDE07B12E4F3473BED63795D4325F8E78A3E716A9B8A`.
Git was initialized locally on main, without remote or commit. No vault writes,
push, deployment, global instruction edits or credential reuse occurred.
