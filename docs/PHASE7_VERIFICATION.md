# Phase 7 verification — atomic purchase receipts

Date: 2026-10-17, America/Buenos_Aires. Baseline1e967e7.
Result: **APROBADO for the exercised local scope**.
Scope: partial/full receiving, counters/pending/state, immutable receipt lines,
inventory integration, idempotency and concurrency. Phase8 was not started.

## Implemented model and transaction

PurchaseReceipt has organization/order/warehouse/actor/key/command/time identity.
PurchaseReceiptLine identifies its same-order line/product, receivedQuantity and
one linked inventory movement. No status is needed: only confirmed immutable
receipts commit. Each line uses an ordinary RECEIPT inventory command/movement
and the same shared creditBalance transaction primitive as prior positive stock
commands. InventoryMovement.purchaseReceiptLineId, referenceType PURCHASE_RECEIPT,
referenceId and correlationKey equal to receipt UUID reconstruct the order/line
chain. Standalone stock/transfer inputs cannot impersonate the reserved reference.

PurchaseOrderLine.receivedQuantity is nonnegative, bounded by orderedQuantity and
equal to the sum of immutable receipt lines. DTOs return exact ordered/received/
remaining/pending/cancelled strings. Pending is ordered minus received, except
cancelled orders report pending0 and cancelledQuantity equal to the unreceived
remainder. Cancellation preserves received stock and all history.

SENT can move to PARTIALLY_RECEIVED or directly RECEIVED. PARTIALLY_RECEIVED can
receive again or cancel the remainder. RECEIVED/CANCELLED are terminal; DRAFT
cannot receive. Existing generic PATCH still cannot set status or counters.
OWNER/ADMIN receive and MEMBER reads; live permission checks also precede replay.
Warehouse/product must be active and scoped; input does not accept a product
identity separate from its order line.

The existing purchasing writer takes Organization FOR UPDATE and reauthorizes
the session/membership. It explicitly locks PurchaseOrder FOR UPDATE before
state/pending validation, locks order lines by UUID, and processes selected stock
keys by product UUID for the one destination. Organization locking is intentionally
stronger than per-order serialization; it also coordinates cancellation,
supplier/catalog changes and stock writers using Organization FOR SHARE.

One transaction commits receipt/lines, stock increments, ledger, counters,
aggregate status, internal stock command responses and the outer RECEIVE result.
The receipt→PurchasingCommand FK is deferred so the immutable completed command
can be inserted after all effects inside that same transaction. Deferred guards
require receipt/command identity, nonempty lines, coherent ledger/counters/state;
the internal incomplete stage never commits. Any error rolls back everything.
No inventory HTTP call or second independent stock transaction is used.

## Migration and actual checks

Migration202610170006_receiving was applied to stockflow_dev and stockflow_test
on the dedicated local PostgreSQL18.6 cluster,127.0.0.1:55434. Seven migrations
applied from an empty temporary verification database; Prisma reported no schema
drift and the helper removed that temporary database. Earlier migrations were
not modified. Direct SQL tests exercise guards beyond what schema diff verifies.

| Check                            | Observed evidence                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| db:migrate                       | APROBADO, both dedicated databases                                                     |
| db:verify-clean                  | APROBADO, seven migrations from empty DB, no drift                                     |
| Initial test:integration         | 207 passed/1 failed; fixture error described below                                     |
| Focused corrected isolation test | APROBADO,1 passed/32 skipped                                                           |
| npm test                         | APROBADO,3 API smoke +16 frontend;208 DB cases explicitly skip here and run separately |
| lint/typecheck                   | APROBADO, full workspace                                                               |
| build                            | APROBADO, API TypeScript and web TypeScript/Vite                                       |

The first complete PostgreSQL run had207 passes and one new isolation case fail
before its HTTP assertions: the alien-order fixture redundantly supplied
organizationId on a nested Prisma line create, where the parent composite
relation already supplies it. Removing that fixture field fixed the targeted
case. This was not a successful tenant check until the corrected test executed.
A repetition after resuming the session failed all208 setup cases because the
dedicated PostgreSQL server was stopped (connection refused), not because those
HTTP/database assertions ran and failed. The project-only cluster was restarted
with db:start and confirmed by db:status before continuation. The full expanded
suite and browser closure are recorded after completion.

The final complete PostgreSQL suite passed: **208 cases in164.00s**, comprising
175 prior regressions and33 receiving cases. Prisma validate/generate and
format:check passed; all77 checked local Markdown targets resolved. AGENTS.md,
the six earlier migrations and Phase2–6 reports remain unchanged.

The full real Chrome/web/API/PostgreSQL suite passed: **13 cases in50.8s**
(11 prior journeys and2 receiving journeys). The new flow logs in, prepares a
supplier/product/order/warehouse through real APIs, sends the order, receives
1.250 of5, verifies PARTIALLY_RECEIVED and stock1.250000, rejects an excess4,
receives3.750 and verifies RECEIVED/stock5.000000. It checks two immutable
RECEIPT movements with actor/receipt-line/reference correlation, receipt history
and persistence after reload. MEMBER can read pending/history but has no form
and receives403 from the real receiving endpoint.

## Real PostgreSQL concurrency and rollback

All receiving races use independent Prisma clients/apps and a deterministic
beforeWrite barrier before lock acquisition. SQL/persistence/quantities are real.
The locks serialize the competing attempts; tests do not claim parallel execution
inside the protected critical section or production throughput.

| Race                                 | Exercised invariant                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| A,6+6 against10                      | Exactly one201/one409; received6, never12; stock/ledger agree                        |
| B,4+6 against10                      | Both201; received10, state RECEIVED, two receipts                                    |
| C, distinct order lines              | Both progress, aggregate state RECEIVED and exact sums                               |
| D, receipt4 versus cancel            | Final CANCELLED; receipt either precedes cancellation or conflicts, with no reversal |
| D, receipt10 versus cancel           | Full receipt wins→RECEIVED/cancel409; cancel wins→CANCELLED/receipt409               |
| E, same key concurrently             | Equal201 response bodies, one logical receipt and stock effect                       |
| F, two orders/missing shared balance | One balance, exact sum10, valid receipt/counter/ledger chains                        |

Assertions reconcile each received counter with immutable receipt sums and each
stock key with its exact signed ledger/version chain. Large numeric values use
bigint millionths/SQL numeric. A forced afterReceiptStock failure on the first
line of a multi-line receipt leaves no receipt/line, changed balance, partial
ledger/internal command, outer completed result or corrupt PO state. Retrying
the same key on the healthy writer succeeds once. Balance overflow likewise
rejects all effects.

Coverage includes repeated partial/multi-line/full receipt; invalid/over-pending
quantities; DRAFT/CANCELLED/RECEIVED rejection; unit scale and canonical zeros;
foreign warehouse/line/order/receipt IDs; IDs from a different order in the same
tenant; active destination; MEMBER and ADMIN; CSRF/key validation; replay after
completion/cancellation and actor/key conflicts; mass assignment and direct
received-counter manipulation. Direct SQL receipt/line mutation, inconsistent
counters/state and a receipt committed without its stock ledger are rejected.

## Review, agents and limits

Three authorized subagents owned backend/schema/migration, frontend/component
tests and PostgreSQL receiving tests. The primary reviewed/integrated, extended
the catalog open-order guard, added E2E/docs, applied migrations and ran real
checks. Only the primary integrates canonical Second Brain memory.

Manual review covered tenant predicates/composite references, order-line product
identity, counter bounds/sums, state commands, active parents, canonical actor/key
hashing, replay reauthorization, lock order, shared stock credit, reserved
references and deferred completion. No blocking issue remained in the reviewed
scope. This was not a full security scanner and does not prove absolute security.

NO VERIFICADO: production throughput, contention across large orders, transaction
timeout capacity at the100-line maximum, every driver/deadlock mapping/retry,
least-privilege roles, TLS/proxy and distributed auth throttling. Purchasing uses
the existing transaction timeout and caller same-key retry rather than a new
automatic deadlock retry loop. The pg client.query concurrency deprecation
warning remains; future pg9 compatibility is not verified.

UI keys are component memory and disappear on reload; reconcile uncertain
results with receipt history. Lists are unpaginated outside inventory's existing
caps. Manual DB owners can disable triggers/TRUNCATE; numeric casts can round
before SQL sees excess scale, so HTTP lexical validation is necessary. Returns,
receipt reversal, costs/totals, dashboards/alerts/general audit UI, billing,
payments and deployment remain outside this phase. No dependency, connector,
remote, push or global configuration change was needed.

The dedicated PostgreSQL cluster was stopped after final verification. No
web/API process is intentionally left running by the E2E suite.

Proposed reusable learning, not written globally: serialize order acceptance and
commit its receipt/counter/stock/ledger/result together; deriving pending outside
that boundary cannot prevent over-receipt. Next recommended phase is8, after
explicit scope review; no Phase8 implementation was started.
