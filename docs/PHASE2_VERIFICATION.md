# Phase 2 verification — authentication and organizations

Date: 2026-10-17, America/Buenos_Aires. Baseline: bb266a3 (Phase 0–1).
Scope: authentication and tenant foundations; work stops before Phase 3.

## Executed database evidence

Existing local PostgreSQL 18.6 binaries were used to initialize a new dedicated
cluster under StockFlow .cache/postgres/data. It binds only 127.0.0.1:55434 with
SCRAM authentication and new project-only credentials in ignored .env. No other
project configuration, secrets, database or service was reused. No Windows service
was installed. Databases: stockflow_dev and stockflow_test.

Both initially empty databases received these migrations through `db:migrate`:

- 202610160001_foundation
- 202610170001_auth

The first SQL-generation attempt returned empty SQL without the configured
datasource environment. That preparation was not accepted as valid evidence:
the Session table was absent and all 27 tests failed in beforeEach. Generation
was corrected with the explicit Prisma config and local environment, and an
assertion rejected empty output. Only migration metadata in the two dedicated
databases was removed after checking that no business table existed. The actual
nonempty SQL files were then applied from clean state and the suite passed.

## Command results

| Command                                         | Observed result                          | Scope                                                                                             |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run db:start` and `db:create`              | APROBADO                                 | Dedicated local cluster and separate development/test databases                                   |
| `npm run db:migrate`                            | APROBADO                                 | Both migrations applied to both clean databases                                                   |
| `npm run test:integration`                      | APROBADO: 27 real PostgreSQL tests       | No mocked persistence                                                                             |
| `npm test`                                      | APROBADO: 3 API smoke + 5 frontend tests | 27 DB cases explicitly skipped here because TEST_DATABASE_URL is not loaded; run separately above |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e:db` | APROBADO: 4 tests, 19.1 seconds          | Installed Chrome, real API, actual test database                                                  |
| `npm run lint`                                  | APROBADO                                 | Source/config lint                                                                                |
| `npm run typecheck`                             | APROBADO                                 | API, web, shared and Playwright tooling                                                           |
| `npm run build`                                 | APROBADO                                 | API output and production Vite bundle                                                             |
| `npm run prisma:validate`                       | APROBADO                                 | Foundational/auth schema                                                                          |
| `npm run prisma:generate`                       | APROBADO                                 | Prisma Client 7.10.1                                                                              |

PowerShell E2E environment syntax: `$env:PLAYWRIGHT_CHANNEL = 'chrome'` before
the command. Component tests simulate fetch only; they are never counted as
PostgreSQL evidence. No integration cleanup ran concurrently with E2E.

Final `npm run format:check` passed. A live Prisma schema diff reported no
difference between migrated development database and schema. The integration
suite passed again after tightening the cleanup guard to the dedicated port/user:
27 tests in 11.10 seconds. Local Markdown checks resolved 22 link targets.
AGENTS.md retained SHA-256
829D997CF41A17BF69A6FDE07B12E4F3473BED63795D4325F8E78A3E716A9B8A.

## Coverage actually exercised

Registration validation and duplicate normalized email, password/session hashes
and safe DTOs, correct/incorrect login, fixation rotation and old-token rejection,
unauthenticated access, expiry/deleted sessions, logout and cookie clearing,
HttpOnly/SameSite and configured Secure cookie, Origin/CSRF failures, limiter
rejection, owner/admin/member permissions, scoped lists and organization editing,
invalid cross-tenant path/target/body IDs, unauthorized login tenant selection,
last-owner protection including concurrent owner demotions, membership/session
revocation, direct PostgreSQL unique and composite session-membership FK failures.

Browser tests prove registration, session restoration after refresh, logout/login,
separate browser tenants unable to read each other's memberships and MEMBER's
read-only organization UI with backend administration rejection. A fourth smoke
checks the login page and API liveness.

## Security review and limits

Primary and an auxiliary agent reviewed changed authentication, organization,
session, crypto and rate-limit code. Centralized scope/permissions, parameterized
SQL organization locks, in-transaction actor recheck and safe response envelopes
were inspected alongside tests. No concrete remaining blocker was found in that
scope. This was a scoped source review, not a full Codex Security scanner run or
a claim of absolute security. See [authentication](AUTHENTICATION.md).

Not verified/implemented: real production HTTPS/reverse-proxy behavior, distributed
rate limiting, email verification/reset, invitation delivery/acceptance, idle
session timeout, scheduled expired-row cleanup, production least-privilege roles,
RLS, business audit, sustained load and inventory/purchasing correctness. The local
database role is privileged and is not a production role configuration.

## Delivery and provenance

New runtime dependencies: @prisma/adapter-pg 7.10.1 and pg 8.23.1. Password hashing,
opaque tokens and environment loading use Node built-ins. Three agents owned
backend, frontend and QA paths; the primary owned database setup/migrations,
integration, documentation, review, Git and authorized memory maintenance.

No remote, push, deployment, external credentials, global configuration edits,
global ADR/learning/problem creation or historical session rewrites occurred.
AGENTS.md remained unchanged. Git hashes and memory destinations are reported
after final checks; no report labels a design-only inventory contract as tested.
