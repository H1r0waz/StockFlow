# Phase 6 verification — suppliers and purchase orders

Date: 2026-10-17, America/Buenos_Aires. Baseline b5b3ae0.
Result: **APROBADO in the exercised local scope**.
Scope: Supplier, PurchaseOrder, PurchaseOrderLine, DRAFT/SENT/CANCELLED, API/UI,
tenant isolation, live permissions and command idempotency. This phase never
creates stock and has no purchasing receipt, billing or payment functionality.

## Model and migration

Migration 202610170005_purchasing adds the three business models and immutable
PurchasingCommand records with CREATE/SEND/CANCEL scopes. Supplier and order
references use organization composite FKs; order lines are unique per product,
positive numeric(20,6), obey product scale and require1–100 lines at commit.
Header/line guards freeze sent/cancelled content and forbid backwards
transitions/history deletion. Catalog guards prevent archival under open orders
and unit/scale changes under any remaining order line. Nullable cancellation
reason is explicitly rejected for CANCELLED, rather than relying on a nullable
CHECK expression alone.

The migration applied to stockflow_dev and stockflow_test on the project-only
PostgreSQL18.6 cluster at127.0.0.1:55434. Six migrations also applied from an
empty temporary verification database with no Prisma schema drift; that helper
removed the temporary database. Previous migrations and verification reports
were preserved. Guards are additionally exercised with real direct SQL tests;
Prisma diff alone is not evidence of trigger semantics.

Orders use UUIDs; human sequence numbering is deliberately omitted. Unit costs,
currency and totals are absent until a separate monetary contract exists. Only
DRAFT/SENT/CANCELLED exist in the actual enum. PARTIALLY_RECEIVED/RECEIVED are
future receipt behavior and are not advertised as verified functionality.

## Commands, concurrency and review

Purchasing reuses the existing tenant writer's Organization FOR UPDATE lock,
live-session/membership recheck and OWNER/ADMIN permissions. Under this lock it
validates active same-tenant parents, edits complete drafts or performs an
explicit transition, then stores a completed command response in the same
transaction. No pending command row or stock mutation is needed. MEMBER reads.

The key/hash/result protocol matches inventory conceptually but has separate
purchasing command storage. Scope is tenant plus CREATE/SEND/CANCEL plus key;
canonical intent includes actor and sorted/normalized lines. A replay returns
the original201 creation or200 transition response even after later state
changes. Changed payload/actor conflicts; current permission is checked first.
Draft PATCH atomically replaces all lines and is not an optimistic-version edit;
concurrent draft replacements serialize and the last successful replacement wins.
Supplier POST has no replay key and may duplicate names after an uncertain retry.

Concurrency cases use independent Prisma clients/apps with a deterministic
beforeWrite barrier before the organization lock, not timing sleeps or mocked
SQL. Two different-key sends yield one200 transition and one409; same-key sends
replay equal200 responses. Edit versus send either commits the complete edit
before send or rejects editing the SENT order. Cancel versus send always ends
CANCELLED under the allowed state machine, with send either preceding it or
being rejected. Concurrent same-key creates yield one order and equal201 bodies.
No numbering race test is claimed because numbering was not implemented.

An internal afterDraftLines hook injects failure after create/replacement lines.
Rollback preserves original draft lines or removes the entire new draft/lines
and command. These hooks are absent from normal construction and not HTTP APIs.
Tests assert inventory balances/movements/transfers remain absent.

The primary reviewed tenant-scoped lookups/DTOs, allowlists, decimal boundaries,
state commands, response hashing, organization serialization, SQL partial
immutability and catalog interactions. No blocking issue remained in the
inspected scope. This was a focused manual review, not a full security scanner
or claim of absolute security.

## Executed evidence

| Check                       | Observed result                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| db:migrate                  | APROBADO, new migration applied to both dedicated databases                                                           |
| db:verify-clean             | APROBADO, six migrations from empty DB, no drift                                                                      |
| test:integration, first run | APROBADO,173 cases in96.39s; before the final two SQL cases were added                                                |
| npm test                    | APROBADO,3 API smoke and14 frontend;175 DB cases explicitly skipped without TEST_DATABASE_URL and executed separately |
| lint/typecheck              | APROBADO, full workspace                                                                                              |
| build                       | APROBADO, API TypeScript and web TypeScript/Vite                                                                      |

The final expanded PostgreSQL suite passed: **175 cases in100.08s** (137 prior
regressions plus38 purchasing cases). Prisma validate/generate and format:check
passed. All61 checked local Markdown targets resolved. AGENTS.md, the five prior
migrations and Phase2–5 verification reports remain unchanged.

The full real Chrome browser suite passed: **11 cases in26.7s**. Purchasing
registers/logs in, creates/edits/deactivates/reactivates a supplier, creates a draft,
adds/removes a line, edits quantities, sends, verifies absence of edit controls
and backend409 for forbidden SENT edits, reloads to confirm state/creator/quantity,
cancels and reloads again. Balances and ledger remain empty. A separate MEMBER
journey verifies read-only UI and403 for a real HTTP purchase-order write.

The initial full browser run had9 passes and2 failures: added authentication
journeys crossed the normal shared loopback-IP limit of20 attempts/15 minutes,
with a429 on a previous auth journey and registration rejection in a transfer
journey. The expanded suite now uses tests/e2e/server.ts with the existing
createApp rateLimit injection set to1000. It refuses production mode and any
DATABASE_URL different from the dedicated TEST_DATABASE_URL/stockflow_test local
target. The normal API server/default limiter is unchanged; limiter-specific
real PostgreSQL tests remain in Phase2. Without TEST_DATABASE_URL, Playwright
keeps the original normal-server path for the bootstrap smoke. The complete
11-case suite was repeated and passed; the initial failures are not passes.

The transfer/inventory/auth/catalog suites are included as actual regressions,
not assumed from earlier reports. New purchasing tests cover supplier
create/edit/availability/tax uniqueness, nullable tax IDs, valid/exact/invalid
lines, replacement/add/remove, duplicate/empty/over-limit lines, tenant/role
boundaries, generic state/cost/mass-assignment rejection, no-delete endpoints,
transitions, replay conflicts, rollback and real races. Direct SQL attempts at
nonpositive/foreign/fractional lines, frozen SENT edits/deletes, reverse states,
empty order/last-line removal, order deletion, immutable command mutation and
open-parent archival/unit changes are rejected.

Purchasing accepts redundant trailing zeros within six places and checks exact
product-scale multiples after canonicalization. Existing inventory APIs keep
their stricter lexical digit-count contract unchanged. This permits round-trip
editing of a fixed-six-place draft DTO without numerical rounding.

## Agents and limits

Three user-authorized subagents owned backend/schema/migration, frontend/tests
and PostgreSQL purchasing tests. The primary integrated/reviewed, added catalog
API guards, test cleanup/run integration, browser journeys and documentation,
applied migrations and ran complete verification. Memory integration has one
custodian. No dependencies, external connectors, global configuration, remote,
push or deployment were added.

NO VERIFICADO: sustained load, production DB privileges/TLS/proxy/distributed
auth throttling, future pg9 adapter compatibility and every possible contention
failure. Existing pg emitted a client.query concurrency deprecation warning.
Organization serialization favors correctness over parallel purchasing throughput.
Supplier/order lists are currently unpaginated. Concurrent draft edits have no
expected-version protection. UI replay keys are in component memory and disappear
on reload; reconcile ambiguous results before starting a new intent. Text/tax ID
validation is not fiscal verification. Direct SQL numeric casts can round before
checks, and owners can disable triggers/TRUNCATE. Full general business audit,
costs/totals, human numbering and physical receipts remain future work.

The dedicated PostgreSQL cluster was stopped after verification. No web/API
development service is intentionally left running by the browser suite.

Next recommended phase: partial/full purchasing receipts with explicit received
counters, cancellation-of-remainder policy and atomic stock/ledger/result work
inside the same transaction. No such route was implemented in this phase.
