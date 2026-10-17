# Phase 3 verification — catalog master data

Date: 2026-10-17, America/Buenos_Aires. Baseline: 02de1fd (Phase 2).
Scope: Category, Product and Warehouse. No stock, ledger, movements, transfers,
suppliers, orders or receipts were implemented.

## Database and migration

Existing StockFlow-only PostgreSQL 18.6 cluster was restarted on
127.0.0.1:55434 using this project's ignored .env. No credentials/configuration
from other repositories or external database were used. New migration:
202610170002_catalog. Prior applied migrations were not edited.

The new migration applied to stockflow_dev and stockflow_test. The new
`npm run db:verify-clean` helper then created an exclusively named temporary
stockflow_verify database, applied all three migrations from empty state,
compared it to the current Prisma schema (no difference), and dropped only that
temporary database. Existing development/test data was not reset by this check.

Natural-key unique constraints and composite (organizationId,id) keys were
created for each entity. Product references Category using a composite tenant
FK. SQL checks cover canonical SKU/code syntax, quantityScale 0–6 and nonempty
trimmed names. Enum values constrain units. A Prisma schema diff does not check
arbitrary CHECK expressions; direct PostgreSQL rejection tests cover those.

## Executed checks

| Command                                    | Observed result                    | Scope                                                                               |
| ------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------- |
| db:migrate                                 | APROBADO                           | New migration applied to development and test                                       |
| db:verify-clean                            | APROBADO                           | Three migrations from a fresh temporary database; no schema drift                   |
| test:integration                           | APROBADO: 72 real PostgreSQL cases | 27 Phase 2 regressions plus 45 catalog cases, serial files                          |
| npm test                                   | APROBADO: 3 API smoke + 9 frontend | 72 DB cases explicitly skip here without TEST_DATABASE_URL and run separately above |
| typecheck                                  | APROBADO                           | API, web, shared and E2E tooling                                                    |
| lint                                       | APROBADO                           | Source/configuration                                                                |
| build                                      | APROBADO                           | API and frontend                                                                    |
| prisma:validate / prisma:generate          | APROBADO                           | Current schema and generated client                                                 |
| test:e2e:db with PLAYWRIGHT_CHANNEL=chrome | APROBADO: 6 tests, 19.8 seconds    | 4 prior journeys plus 2 real catalog journeys; installed Chrome, API and PostgreSQL |

Integration files run serially to avoid overlapping destructive cleanup. Cleanup
is guarded to the dedicated loopback stockflow_test instance and now removes
catalog children before identity/organization records. It never falls back to
the development database. E2E is run after integration, not concurrently.

## Proven behavior and review

The integration suite exercised category normalization/collisions and tenant
isolation; product SKU uniqueness within a tenant and reuse across tenants;
category assignment across tenant boundaries rejected by both HTTP and direct
SQL FK; inactive category assignment rejection and existing-reference retention;
all supported units/default scales; create/edit/deactivate/reactivate; warehouse
code uniqueness; malformed values, IDs and mass-assignment fields; direct SQL
CHECK rejection; OWNER/ADMIN write permissions, MEMBER read-only permissions;
Origin/CSRF and Phase 2 session/ownership regressions.

Primary and auxiliary read-only review inspected tenant resolution, shared
organization writer locks, in-transaction actor recheck, scoped reads/updates,
field allowlists, safe errors, enum/identifier validation and React text rendering.
No blocking security finding remained in that scope. This was not a full external
security scan or proof of absolute security. React checklist covered stable
effects, parallel independent GETs, accessible labels/tables and no new dependencies.

An initial browser run passed five cases but exposed a register→logout→login
navigation bug: registration mode remained selected after successful signup.
The next Sign in click switched form mode rather than logging in. Successful
authentication now resets the anonymous form to login; component regression
coverage and the E2E flow were extended. The inactive category selector also
retains the original option while a product edit is still unsaved.

Final formatting check passed. A local Markdown check resolved 32 link targets;
prior verification reports and applied migrations were unchanged. AGENTS.md
retained its original SHA-256. Local PostgreSQL was stopped after verification.

## Limits

Inventory numeric(20,6) quantities and history restrictions remain design-only.
Product unit/scale may change until a later phase introduces history; that phase
must enforce immutability. No minimumStock or hard-delete endpoint exists.
Archived catalog rows remain readable. Unicode category-key derivation belongs
to the backend; privileged direct SQL can bypass it by supplying another key.

No pagination/search, bulk operations, business audit, production role hardening,
TLS/proxy deployment, distributed limiter, sustained contention/load or catalog
performance at large scale was verified. Existing Phase 2 operational limitations
remain in [authentication](AUTHENTICATION.md). No remote/push/deployment occurred.

Three agents owned backend, frontend and QA. Primary integrated database changes,
review, checks, documentation, Git and permitted project-memory maintenance.
No dependency was added. Historical verification reports were retained.
