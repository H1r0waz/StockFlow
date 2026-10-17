# Phase 8 verification — dashboard, alerts and business audit

Date: 2026-10-17, America/Buenos_Aires. Baseline: be498f66233cb82bab355b5e30cca31eb760c736.
Result: **APROBADO for the exercised local scope**. Phase 9 has not started.

## Implemented scope and contracts

See [dashboard and pagination](DASHBOARD.md) and [business audit](AUDIT.md) for
the exact DTOs, filters, ordering, action names and safety boundaries.

- Dashboard reads a RepeatableRead transaction: active products/warehouses,
  distinct products with configured LOW locations, products without positive
  stock in any active warehouse, DRAFT/SENT/PARTIALLY_RECEIVED counts, RECEIVED
  in the last thirty days by terminal order updatedAt, five recent movements
  and five recent receipts. asOf is the application response-construction time.
  No financial valuation or sum of incompatible product units is invented.
- InventoryThreshold stores a nonnegative exact numeric(20,6) minimum for each
  tenant/product/warehouse. Missing balance means zero; zero is OUT_OF_STOCK,
  positive below minimum is LOW, otherwise OK. Inactive parents are excluded.
  Only configured pairs appear in alerts. Minimum zero never hides zero stock.
- AuditEvent stores actor/entity/action/time, safe state and correlation inside
  the existing business transaction. SQL triggers reject event UPDATE/DELETE.
  Ordinary stock actions emit one event; transfers and purchasing receipts emit
  one parent event and suppress redundant leg events. Replays add no duplicate
  event. Audit-insert failure rolls back stock and purchasing effects.
- Catalog, supplier, membership, threshold and order changes are captured.
  State and metadata use an explicit allowlist: no passwords, tokens, cookies,
  supplier contacts/tax values or free-form notes. changedFields stores column
  names rather than their sensitive values. Actor displayName is joined at read.
- OWNER/ADMIN configure thresholds and read audit; MEMBER reads dashboard and
  alerts. Every route scopes by authenticated organization and reuses current
  session/tenant authorization. Mutations retain CSRF/origin and reauthorization.
- Business lists return limit+1 bounded queries with hasMore/nextOffset, default
  limit50/max100, offset0..1000000 and deterministic tie-breakers. This includes
  audit, alerts, products/categories/warehouses, balances/movements, suppliers,
  orders, per-order receipts and memberships. UI tables and choices explicitly
  load further pages; an organization switch/logout discards stale responses.
  The existing auth organizations chooser is outside this pagination change.
- Dashboard, alert configuration/list and audit filters are available in the
  operational UI, with existing responsive cards/tables and role-specific controls.
  Pending orders appear as status counts with access to the purchasing screen.

## Executed checks

| Check                                      | Observed result                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| db:migrate                                 | APROBADO: new 202610170007_operations on stockflow_dev and stockflow_test                                                                              |
| db:verify-clean                            | APROBADO: all eight migrations replayed on an empty temporary database; no schema difference; temporary database removed                               |
| test:integration                           | APROBADO: 255/255 PostgreSQL tests, seven files, 212.44 seconds; 208 regressions and 47 Phase 8 cases                                                  |
| npm test                                   | APROBADO: three API smoke tests and 21 frontend tests; 255 PostgreSQL tests explicitly skipped without TEST_DATABASE_URL and executed separately above |
| test:e2e:db with PLAYWRIGHT_CHANNEL=chrome | APROBADO: 15/15 real Chrome/web/API/PostgreSQL journeys, 44.0 seconds; thirteen prior journeys and two Phase 8 journeys                                |
| lint, typecheck, build                     | APROBADO: workspace checks and frontend/backend builds                                                                                                 |
| prisma:validate, prisma:generate           | APROBADO: Prisma 7.10.1 schema validation and client generation                                                                                        |

The Phase 8 PostgreSQL cases exercise active/inactive/missing balance semantics,
minimum equality/zero/decimal boundaries, scale/overflow/negative input, threshold
tenant FKs and SQL guards, dashboard counts/state windows and recent-list caps,
tenant isolation, OWNER/ADMIN/MEMBER permission checks, immutable audit rows,
catalog/roles/order/stock/transfer/receipt audit, safe metadata, idempotent replay,
audit failure rollback and deterministic pages with timestamp/name ties.

The browser owner journey performs real registration/login, creates a product
and warehouse through authenticated API, observes zero stock, sets minimum3 in
the UI, receives2 in Inventory, verifies LOW/out-of-stock dashboard changes and
filters audit by action/entity/actor with the movement correlation. Reload proves
persisted data. A separate MEMBER journey reads dashboard/alerts, has no write
or audit controls, and receives HTTP403 on audit and threshold mutation.

Frontend tests use mocked HTTP and are not substituted for these real journeys.
An additional membership pagination test verifies appended pages and ignores a
late pending response after logout. Initial format check found one test-format
issue; Prettier corrected it before the final format check.

## Query review and bounded local measurement

New indexes cover AuditEvent(organizationId,createdAt,id) and
(organizationId,entityType,entityId,createdAt,id); InventoryThreshold has the unique
tenant/product/warehouse index. Existing catalog, balance, movement, order and
receipt indexes support scoped joins and stable list order. SQL uses parameterized
tenant predicates and aggregates, not browser aggregation or a query per product.
Prisma's bounded relation includes may issue a fixed number of relation queries;
this is not a claim that every endpoint is one SQL statement.

EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ran against the dedicated local development
database in one rolled-back synthetic transaction: 2,000 active UNIT products,
one warehouse, 2,000 thresholds, 5,000 audit events and no balance rows.
No benchmark records committed and no production/other-project data was used.

| Representative query shape                 | Actual rows | Planning ms | Execution ms |
| ------------------------------------------ | ----------- | ----------- | ------------ |
| Alert joins, ordered id, LIMIT51           | 51          | 5.126       | 8.301        |
| Out-of-stock aggregate with NOT EXISTS     | 1 aggregate | 0.749       | 6.563        |
| Tenant audit ordered createdAt/id, LIMIT51 | 51          | 1.408       | 1.762        |

Plans used tenant catalog/balance/threshold indexes and a tenant audit bitmap
scan plus sort. These are representative SQL shapes, not HTTP latency or the
whole dashboard benchmark. Single local runs with uncommitted fixture statistics
do not establish throughput, concurrency capacity or production plans. Audit
actor/action-only searches may scan a tenant slice; alert ordering can sort its
matching slice. No speculative index or denormalization was added without need.

## Review, migrations and preserved behavior

Manual review covered cross-tenant IDs, safe audit fields, invalid/unknown and
array filters, bounded pagination, permission enforcement, explicit mutation
fields and parameterized SQL. This is not an exhaustive security assessment.
No dependency, connector, remote, push, deployment or global configuration was
added. Previous migrations, phase verification reports and AGENTS remain intact.
Legacy test cleanup now truncates the new immutable audit/threshold tables before
deleting their parent fixtures; no production delete endpoint was introduced.

Three subagents handled backend/documentation, frontend and PostgreSQL/E2E tests.
The principal integrated/reviewed them, ran the full checks, measured representative
queries and closed documentation, local Git and authorized project memory.

## Limits and NO VERIFICADO

- Audit is prospective API business activity; initial unauthenticated workspace
  bootstrap, login/logout and direct SQL without transaction actor context are
  excluded. No historical backfill. A database owner can disable triggers or
  TRUNCATE; application append-only is not privileged-administrator tamper proof.
- Independent offset requests can shift during concurrent inserts/deletes. Deep
  offsets and broad audit searches require measurement before large deployments.
  The auth organizations list remains unbounded. Inventory balances retain the
  legacy shared parser accepting movement-only filters without applying them;
  consumers should use productId/warehouseId for balances, as documented.
- Production load, production least privilege/retention/backup/TLS, distributed
  auth throttling and a full security/accessibility/mobile-device audit are
  NO VERIFICADO. Responsive CSS exists; no device/browser matrix is claimed.
- Existing pg warning about overlapping client.query calls remains: all current
  pinned-version checks passed; pg9 compatibility is NO VERIFICADO.
- UI idempotency keys remain component memory and do not survive reload. Reconcile
  operation history before retrying an uncertain intent after a reload.
- No external notifications, financial valuation, CSV, advanced reports or final
  production hardening. Phase 9 CSV/reporting is the recommended next scoped phase.
  The Phase 7 reusable-learning proposal remains only a proposal.

The separate Phase 8 commit starts from the baseline above on local main without
a remote. Canonical project memory records that source revision and preserves
historical sessions. See Git for the immutable final source hash.
