# StockFlow — explaining every stock change

StockFlow is a portfolio inventory and purchasing application for small and medium businesses. It combines an operational interface with a deliberately strict transaction model. The fictional Distribuidora Nova scenario is available in a [public portfolio demo](https://stockflow-demo-qsb3.onrender.com); no real company or customer outcome is claimed.

## The problem

A distributor needs more than a product list. Operators must know how much is available at each warehouse, what is running low, which supplier orders remain open and whether a delivery has already been received. A quantity that looks correct on one screen can still be wrong if two people issue the same remaining stock or retry a transfer after a timeout.

The design problem was to make these everyday actions understandable while keeping their effects consistent under concurrency. The scope includes stock and physical purchasing quantities; it deliberately avoids ungrounded revenue, margin or inventory valuation claims.

## The solution

StockFlow joins products, categories, warehouses, suppliers and purchase orders to an exact inventory ledger. Users can record receipts, issues and adjustments, transfer stock between locations and receive supplier orders partially or in full. A dashboard surfaces critical stock, open-order counts and recent activity. Configured stock minimums produce location alerts; searchable business audit provides actor and correlation context.

CSV import uses a preview/confirm workflow rather than applying a file on upload. Operational reports and bounded CSV exports make the same scoped data available for follow-up work. OWNER, ADMIN and MEMBER roles expose different actions while the API independently enforces every permission.

## Architecture

The project uses a React / TypeScript / Vite / Tailwind frontend and a modular Node.js / Express / TypeScript API in one npm workspace. PostgreSQL is the transactional authority. Prisma handles schema and scoped persistence; parameterized SQL supplies row locks, conditional updates and migration guards where an inventory invariant needs them.

A single API and database keep receiving, purchasing and inventory inside one commit boundary. No microservice or event-bus layer is needed for the current scope. The browser displays results and validates forms for usability, but it never computes an authoritative balance or grants tenant access.

## Technical challenges and decisions

### Quantities that survive concurrent writes

Quantities travel as decimal strings and use bigint millionths for arithmetic; PostgreSQL stores exact numeric values. Each product declares its unit and precision. Conditional debits and row locks reject an issue that would create negative stock, even when another operator is competing for the same balance.

The materialized balance serves operational reads. Immutable movement history explains it. A successful mutation changes both in one transaction, and checks reconcile quantities, versions and previous/resulting transitions. History is not silently rewritten to repair a mismatch.

### Transfers with one outcome

A warehouse transfer is one business operation with two ledger legs. Source debit, destination credit, transfer record and replay result commit together. Balance keys are locked in a consistent order to reduce lock cycles. A failed destination update cannot leave a committed source debit.

### Receiving against the current order

An order progresses through DRAFT, SENT, PARTIALLY_RECEIVED and RECEIVED; an eligible order can also be cancelled. Receiving locks and rechecks the order and pending line quantities before changing stock. Receipt lines, received counters, aggregate state, ledger and replay response share the same transaction. Cancellation of an unreceived remainder preserves already received stock and history. Returns and receipt reversal are separate future concerns.

### Retries without a second stock effect

A durable idempotency key binds organization, actor, command and normalized intent. Repeating the same successful intention returns its original result; changing the actor or payload conflicts. Permission is checked before replay. This addresses response loss after a commit, while preserving an explicit user decision for a genuinely new action.

Browser keys currently live in component memory. After reload or an uncertain result, users must reconcile history before entering a new intention. A network timeout alone does not prove rollback.

### Multi-tenancy through the complete workflow

Organizations scope reads, writes, joins, aggregates and exports. Composite foreign keys also reject cross-tenant associations at the database boundary. Sessions resolve live memberships; mutations reauthorize under the writer lock. The role matrix separates ordinary read access from business and membership administration. A client-selected organization ID does not grant access.

### CSV confirmation against a moving catalog

Preview validates the bounded file without writing. Its token binds actor, organization, content and current-state fingerprint. Confirmation replans under the same writer lock used by ordinary mutations. If relevant state changed, the user receives a conflict rather than silently importing a stale plan.

The batch, durable ImportJob and safe audit commit together. Product imports match SKU and report create/update/skip operations; supplier imports create records rather than guessing identity from a name. CSV limits and spreadsheet formula neutralization are explicit contracts, not universal spreadsheet compatibility claims.

## Security and operational boundaries

The API uses scrypt password derivation, opaque hashed sessions, HttpOnly cookies, Origin/CSRF checks, live role checks, bounded requests and per-process abuse limits. Business audit uses safe field allowlists and commits with its operation; contacts, credentials, raw files and free-form notes are excluded from its state payloads. API errors avoid exposing SQL or stack traces.

These controls were reviewed and tested locally. They do not constitute a penetration test, compliance certification or administrator-proof audit. Phase 12 verifies public HTTPS/authentication and tenant boundaries, restricted runtime SQL permissions and restoration of a cloud dump into a fresh local database. Distributed limits, complete ingress/IP analysis, retention and provider PITR/cloud failover remain outside the executed evidence. See the full [security model](SECURITY.md).

## Demonstration and evidence

The isolated Distribuidora Nova dataset lets a visitor follow the inventory and purchasing cycle with fictional OWNER, ADMIN and MEMBER accounts. Seed/reset boundaries and the suggested visit are documented in [DEMO.md](DEMO.md). It is a public portfolio demonstration with a reproducible local setup, using fictional data and no evidence of customer use.

Verification combines pure API tests, component tests, real PostgreSQL tests and authenticated Playwright journeys. Concurrency cases use independent requests and connections; rollback cases inject failure and check that partial business effects do not commit. Tenant, role, decimal, direct-SQL guard and malformed-file cases complement the happy paths.

Phase 11 passed 334 integration cases (325 against real PostgreSQL and nine pure demo guards), 44 API checks without a database, 36 frontend tests and 20 real browser journeys. The nine guards also appear in the API count. A fresh migration reconstruction and explicit demo rebuild/repeat succeeded. [Phase 11 verification](PHASE11_VERIFICATION.md) records commands, seed coherence, demo journeys, responsive/accessibility scope, screenshots and limitations. Previous reports remain available for traceability.

## Results and tradeoffs

The implemented application connects stock reads to their underlying commands, ledger entries, receipts and audit identities. The portfolio demonstrates how an ordinary warehouse workflow can enforce concrete consistency rules instead of relying on a disabled button or a browser-side quantity check.

Organization-level serialization deliberately favors consistency and a small coordination model over maximum write throughput. Offset pages can shift during concurrent writes. Database owners can bypass triggers, and pending import previews are invalidated by an API restart. Sustained production load, broad device/assistive-technology compatibility and production infrastructure have not been established by the local evidence.

Phase 12 deploys one Render Free Node service serving the compiled frontend and API under the same [HTTPS origin](https://stockflow-demo-qsb3.onrender.com), with a separate Neon Free PostgreSQL 18.6 database in Virginia. Production options cover bounded readiness, safe request IDs/logs, explicit proxy trust, public-demo registration restrictions and a restricted runtime SQL role. Executed local and public checks, source revision, timings, cloud dump recovery and explicit gaps are recorded in [Phase 12 evidence](PHASE12_VERIFICATION.md). This case study does not claim adoption, cost savings, provider failover validation or commercial production capacity.
