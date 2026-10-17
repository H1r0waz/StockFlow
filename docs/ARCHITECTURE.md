# Architecture

StockFlow (`SC-PROJ-STOCKFLOW`) is an inventory and purchasing SaaS for small and medium businesses. This document records Phase 0 decisions for the Phase 1 bootstrap. Phase 3 adds Category, Product and Warehouse master data, API and protected UI; see [catalog rules](CATALOG.md) and [Phase 3 evidence](PHASE3_VERIFICATION.md). Phase 2 authentication, organizations and memberships remain implemented; see [authentication](AUTHENTICATION.md) and [current evidence](PHASE2_VERIFICATION.md). Phase 4 inventory receipts/issues/adjustments and their local concurrency guarantees are implemented and tested; see [inventory](INVENTORY.md). Phase 5 adds atomic transfers and ordered balance locking; see [transfers](TRANSFERS.md) and [Phase 5 evidence](PHASE5_VERIFICATION.md). Phase 6 adds suppliers and purchase-order drafts/send/cancel, without receipts or stock effects; see [purchasing](PURCHASING.md) and [Phase 6 evidence](PHASE6_VERIFICATION.md). Phase 7 adds [physical receipts](RECEIVING.md) with counter/state/stock/ledger atomicity; see [Phase 7 evidence](PHASE7_VERIFICATION.md). Phase 8 adds [operational dashboard/alerts and paged read models](DASHBOARD.md) plus [prospective business audit](AUDIT.md); see [current Phase 8 evidence](PHASE8_VERIFICATION.md). See [roadmap](ROADMAP.md) and [inventory invariants](INVENTORY_INVARIANTS.md).

## Shape and boundaries

Use one npm workspace with `apps/web` (React, TypeScript, Vite, Tailwind), `apps/api` (Express, TypeScript, Prisma/PostgreSQL), and `packages/shared` (small public contracts used by both apps). Keep one database and one deployable API initially. No queues, distributed transactions, event bus, microservices, generic repository framework, or event-sourcing framework are needed for the MVP.

The API owns validation, authorization, transactions, and inventory decisions. The browser presents server results; it cannot authorize an organization or calculate an authoritative balance. Shared contracts must not contain database clients, server configuration, session secrets, or persistence entities. Avoid duplicating domain rules in shared UI code.

Create each module when its phase begins: `auth`, `organizations`, `users`, `products` (including categories), `warehouses`, `inventory`, `suppliers`, `purchasing`, and `audit`. A module starts with routes/validation and an application service. Add a persistence file for SQL/Prisma operations and pure domain functions only when the logic warrants them. Do not generate empty CRUD handlers or five layers for every entity. Dependencies point from HTTP to use cases to persistence/domain; other modules invoke use cases rather than another module's routes.

Inventory owns stock mutation and ledger append. Phase 6 purchasing uses the existing exclusive tenant writer for master data and order lifecycle, with no inventory mutation. Phase 7 receiving coordinates purchasing and the shared inventory credit primitive within the **same transaction client**. Audit writes also use that client; no independently committed helper is allowed. Domain errors map to stable HTTP responses at the API boundary, without exposing SQL or stack traces. Phase 8 audit correlates persisted business command/entity identities; a distributed request tracing/logging system is not implemented.

## Tenant and identity boundary

`User` is a global login identity; `Organization` is a tenant. `Membership` associates a user with an organization and role, uniquely per `(organizationId, userId)`. All business records have a non-null `organizationId`. Phase 2 roles are OWNER, ADMIN and MEMBER, replacing the Phase 0 OPERATOR/VIEWER outline. Explicit backend permissions and last-owner protection are implemented. A global user is the deliberate exception to business-record tenancy; a user DTO never exposes another organization's memberships.

An authenticated session identifies the user. Each protected operation resolves an active membership for its organization and required permission; a client-supplied organization ID alone grants nothing. Reads, lists, joins, exports, aggregate queries, and writes always include tenant predicates. Composite references such as `(organizationId, productId) -> Product(organizationId, id)` prevent cross-tenant associations even when application validation is bypassed. An ID-only global primary key does not replace these constraints. Cross-tenant object lookup returns 404 without disclosing existence; unauthenticated access returns 401 and insufficient permission within the tenant returns 403.

Use explicit tenant parameters rather than a magical Prisma extension as the only safeguard. PostgreSQL RLS is a possible later defense, not a bootstrap claim. Composite FKs protect associations, not unauthorized reads; acceptance tests must prove both. Business records are archived rather than cascade-deleted once referenced by the ledger. User deletion must preserve a stable audit actor identifier without retaining unnecessary personal data.

Phase 2 implements server-side sessions using opaque random tokens stored hashed, HttpOnly cookies, environment-appropriate Secure/SameSite settings, expiry/revocation, Origin and CSRF protection, scrypt password hashing and bounded in-process login throttling. No authentication stub or pretend login is used. Configure same-origin production routing; any development CORS allowlist is explicit and does not replace authorization.

## Persistence and transaction boundary

Use Prisma for foundational schema and ordinary scoped queries. Use parameterized SQL inside Prisma interactive transactions where conditional mutation or row locks express a concurrency invariant more clearly. Never interpolate IDs or amounts into raw SQL. Add SQL migrations for CHECK constraints and ledger immutability; a Prisma schema alone does not prove those constraints are deployed.

Phase 3 adds Category, Product and Warehouse with tenant composite keys and Product–Category composite FK to the Phase 2 foundations. Seven migrations are applied to dedicated local PostgreSQL development/test databases. Organization and catalog modules share the same tenant resolver, row-lock writer and actor/session recheck. InventoryBalance, InventoryMovement, InventoryCommand and InventoryTransfer are implemented with SQL checks, deferred consistency triggers and immutable history. Prisma schema validation alone does not prove migration or concurrency behavior; real Phase 2 test results are recorded separately. No external database is authorized.

Keep transactions short, with no HTTP calls, email, file parsing, or UI interaction inside them. Default planned isolation is READ COMMITTED with conditional debit and ordered row locks. Retry the entire transaction only for recognized transient deadlock/serialization failures, at most three total attempts with bounded jitter. Inventory conflicts and validation errors are not transient. An ambiguous commit must be resolved with the original idempotency key, never a new key.

Ledger history is the durable explanation of inventory. Materialized balances serve stock reads and guarded writes; both change atomically. Reconciliation compares both using a consistent snapshot and reports mismatches; it does not silently rewrite history or repair balances. See [ADR 0001](adr/0001-inventory-consistency.md).

## Audit and operational limits

Phase 8 business audit stores organization, actor, action, entity identity, allowlisted before/after values, timestamp and business correlation references; see [exact event coverage](AUDIT.md). Catalog, memberships/roles, order commands, stock operations and receipts use transactional capture. Inventory and purchasing success audit commits atomically with business effects; audit failure aborts the operation. CSV confirmation auditing remains a future requirement. Authentication failures and rejected requests are not successful business events; a retained security logging system is not implemented by this phase.

Never store passwords, tokens, cookies, authorization headers, full raw imports, or arbitrary request bodies in audit/logs. Administrative database access remains a trusted operational capability: triggers/permissions should prevent ordinary application ledger updates/deletes, but cannot make history tamper-proof against a database owner. Notifications are derived after commit; adding reliable external delivery later requires an outbox and its own acceptance tests.

## Evidence and continuation

The initial canonical memory card dated 2026-10-16 describes an empty pre-bootstrap folder and predates local AGENTS.md. It is historical context, not current implementation authority. Historical booking and CSV notes informed separate treatment of concurrency, idempotency, and confirmation-time revalidation; they do not verify StockFlow. Canonical project/session/index updates are authorized by the current phase; global learning/ADR notes still require separate authorization.

For a change, first inspect instructions, Git diff, relevant module and its phase. Implement one use case end to end with its tenant checks and transaction tests. Agents may own disjoint files; one coordinator reviews integration and runs verification. Do not add business features merely because they appear in the roadmap.

PostgreSQL semantics were checked against official [row locking documentation](https://www.postgresql.org/docs/18/explicit-locking.html) and [transaction isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html) on 2026-10-16. These explain the chosen primitives; actual selected-server behavior still requires integration tests.

## Phase 8 operational read/write boundary

The operations module reads tenant-scoped aggregates in a RepeatableRead dashboard
transaction and computes configured-location alert statuses in SQL. It never
mutates balances or sums incompatible units. InventoryThreshold is exact per
product/warehouse, with tenant FKs, nonnegative/precision constraints and
product-unit/scale protection after configuration. Bounded read lists use shared
limit/offset parsing and stable UUID tie breakers; separate page requests do not
share a snapshot.

Business writers set authenticated actor context transaction-locally after
reauthorization. SQL row triggers append safe AuditEvent payloads in that same
transaction. Audit insertion failure aborts business effects. Transfer/receipt
parent events replace redundant leg audit rows; ledger history remains intact.
Audit UPDATE/DELETE is rejected, but privileged administrators and SQL outside
actor context remain outside this application integrity boundary. No backfill,
queue, external notification, CSV or production deployment is introduced.

## Phase 9 import and report boundary

The [imports module](IMPORTS.md) parses bounded CSV before opening a write
transaction. Preview is read-only and signs a tenant/actor/file/state intent
without persisting raw input. Confirm reauthorizes under the existing exclusive
organization lock, rebuilds the current plan, rejects stale intent and commits
catalog effects, immutable ImportJob and audit together. This bounded transaction
uses a 30-second timeout; ordinary writers retain their default timeout.
Products match tenant SKU; suppliers are create-only with existing tax-ID
uniqueness. No CSV mutates stock directly or creates categories/warehouses.

Nine migrations now define the database. [Reports](REPORTS.md) use fixed,
parameterized, tenant-scoped projections and bounded pages. CSV exports use
allowlisted fields and spreadsheet-formula neutralization. The signing secret
is process-local: unconfirmed previews expire in thirty minutes or upon restart.
Confirmed job status survives restart. No worker, external service, dependency,
financial analytics or production deployment is added.

## Phase 10 local pre-release boundary

[Security controls](SECURITY.md) now include strict configured origins, mandatory
production Secure cookies, API CSP/framing/referrer/cache policies and independent
authenticated user/organization quotas. Logout remains available after quota
exhaustion. The HTTP server bounds header/request/keepalive receipt time; browser
requests abort after thirty seconds and retain explicit reconciliation guidance
for uncertain writes. Neither browser abort nor HTTP receipt timeout proves a
database statement was cancelled. Real TLS/proxy/frontend-host headers and runtime
SQL least privilege remain deployment responsibilities.

The API test runner excludes compiled dist files and production compilation
excludes source test files, avoiding duplicate source/compiled test discovery.
No schema change or historical migration rewrite is required by this phase.
