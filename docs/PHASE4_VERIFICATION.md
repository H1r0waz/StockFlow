# Phase 4 verification — inventory balances and ledger

Date: 2026-10-17 (America/Buenos_Aires). Baseline f8f6cfa.
Scope: receipts, issues, adjustments, exact quantities, immutable ledger and
materialized balances. No transfer/purchasing functionality was added.

## PostgreSQL and migration

The existing dedicated StockFlow PostgreSQL 18.6 cluster was started on
127.0.0.1:55434 with project-only .env credentials. New migration
202610170003_inventory was applied to stockflow_dev and stockflow_test. Existing
migrations were not edited. Prisma's first schema check found that its composite
one-to-one command relation needed a composite unique key; this was corrected
before generating or applying the migration.

All four migrations then applied successfully to a fresh, exclusively named
temporary verification database. The live-schema diff reported no difference.
The helper dropped only that temporary database. CHECK/trigger semantics, which
are not fully represented by a Prisma diff, were additionally exercised with
real direct-SQL rejection tests.

## Executed evidence

| Check                                    | Observed result                     | Scope                                                                    |
| ---------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| db:migrate                               | APROBADO                            | Inventory migration applied to development/test                          |
| db:verify-clean                          | APROBADO                            | Four migrations from empty database; no schema drift                     |
| test:integration, initial complete suite | APROBADO: 101 cases                 | Previous72 regressions and 29 inventory cases, no mocked persistence     |
| npm test                                 | APROBADO: 3 API smoke + 11 frontend | DB cases explicitly skip without TEST_DATABASE_URL; run separately above |
| test:e2e:db with installed Chrome        | APROBADO: 7 tests, 22.4 seconds     | Real web/API/PostgreSQL; all previous6 journeys plus inventory journey   |
| lint/typecheck                           | APROBADO                            | Entire workspace source and E2E tooling                                  |

Expanded integration run: **APROBADO, 103 cases in 44.47 seconds** (72 prior
regressions plus 31 inventory cases). Added real SQL incomplete-command/malformed
movement checks and actor-changed replay / foreign-warehouse boundaries. Lint and
typecheck passed again after these additions. Test configuration alone is never
treated as evidence.

Final frontend/backend builds, Prisma validate/generate, formatting and
format:check passed. All 43 checked local Markdown link targets resolved.
AGENTS.md and previous migration/report files remain unchanged. The dedicated
PostgreSQL cluster was stopped after verification.

## Real concurrent cases

Each mandatory race used two separate Prisma clients/apps and therefore separate
PostgreSQL transactions/connections. An injected internal beforeBalance hook
provided a deterministic barrier: both transactions reached the balance operation
before either was released. It does not mock SQL, quantities or persistence, is
not exposed via HTTP, and is absent from normal application construction.

| Race                                        | Observed assertions                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A: initial5, concurrent ISSUE4 and ISSUE3   | Exactly one201 and one409; final1 or2; correct two-movement chain including opening receipt |
| B: absent balance, concurrent RECEIPT2 and3 | Both201; one balance; quantity5; two sequential ledger versions                             |
| C: initial10, concurrent ISSUE2 and3        | Both201; final5; previous/result transitions agree with version order                       |
| D: initial5, ADJUSTMENT_OUT4 versus ISSUE3  | One201/one409; nonnegative final quantity and consistent ledger                             |
| Concurrent same idempotency key             | Both responses equal; exactly one committed effect                                          |

Chain assertions calculate exact signed sums in bigint millionths and compare
every movement previous/resulting quantity and version to the final balance.
Tests are deterministic race examples, not a sustained-load benchmark or proof
against every possible PostgreSQL contention pattern. Real deadlock exhaustion
and all adapter error mappings have not been force-exercised.

## Additional exercised boundaries

Receipt first-use/increment, absent/insufficient issue, positive/negative
adjustments and required reasons, invalid decimal strings/product scales, huge
exact quantities and overflow, idempotent canonical replay/conflict, rollback
after balance update, tenant/product/warehouse scope, MEMBER restrictions and
ADMIN acceptance, Origin/CSRF and mass assignment, inactive parents, history-based
unit/scale locks and positive-stock archival rejection, filtered history DTOs.

Direct SQL attempts to mutate/delete ledger or alter balance without a matching
movement are rejected. Negative balances are rejected. Runtime quantities remain
strings and versions strings; no critical Number conversion exists. Deferred
consistency and chain checks supplement tenant-safe FKs and uniqueness.

The browser journey registers/logs in, selects real product/warehouse, records
5.250 receipt and2 issue, rejects insufficient4, records adjustment-out0.250,
then reloads and sees final3.000000 plus all three movements and actor. Product
search and type filter work on the displayed results. Component tests separately
prove MEMBER has no write controls and a network-failed retry reuses its key;
these component tests simulate HTTP and are not database evidence.

## Review and remaining limits

Primary reviewed the inventory writer/decimal parser, SQL triggers, tenant
permissions, immutable history, idempotency replay and integration with catalog.
No blocking issue remained in that inspected scope. This was not a full security
scanner run and does not establish absolute security. General business audit,
transfers and purchasing remain out of scope. InventoryMovement is the durable
stock-specific actor/correlation history.

Database owners can disable triggers or TRUNCATE; the local role is privileged.
Production least-privilege/TRUNCATE revocation, distributed auth throttling,
TLS/proxy behavior and load testing remain unverified. numeric casts may round
before CHECKs: strict HTTP lexical validation is necessary; arbitrary direct-SQL
input is a trusted administrative boundary.

List results are bounded100 by default, max200, with hasMore; the UI warns on
truncation. Search is over loaded results; full pagination/search is future work.
UI idempotency keys survive same-form retries only while the component remains
mounted; a page reload loses an ambiguous pending intent. Users must reconcile
history before deliberately re-entering an uncertain command after reload.

The backend and frontend agents stopped after initial schema/partial UI changes;
QA stopped before producing its suite because of a reported usage limit. Primary
completed implementation, migration, all inventory tests/E2E and integration.
No dependency, remote, push, cloud service or global configuration was added.
