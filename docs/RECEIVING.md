# Purchase receiving — Phase 7

PurchaseReceipt represents one committed physical delivery for one purchase order
and one destination warehouse. PurchaseReceiptLine identifies an ordered line,
product and positive receivedQuantity. There are no draft receipts: a committed
receipt is confirmed; failure leaves no receipt. Header/lines are immutable and
have tenant identity, actor/key/time and stock correlation. Reversal, returns,
editing and deleting a confirmed receipt are not implemented.

## API and read models

Under /api/organizations/:organizationId/purchase-orders/:purchaseOrderId:

| Route                    | Contract                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| POST /receipts           | {warehouseId,lines:[{purchaseOrderLineId,quantity}]}; Idempotency-Key required;201 {receipt,purchaseOrder} |
| GET /receipts            | {receipts}, scoped history                                                                                 |
| GET /receipts/:receiptId | {receipt}, scoped detail                                                                                   |

An authenticated OWNER/ADMIN receives; MEMBER reads history and quantities only.
Origin, CSRF, live session/membership validation and strict allowlists apply.
Caller-supplied organization, product, actor, received counters or state are not
accepted. Product comes from the same-order line; warehouse must belong to the
same tenant and be active. Received products must be active. Unknown/foreign
order, warehouse, receipt or order-line references fail without resource leakage.

Select1–100 unique lines of that order per receipt. Blank UI quantities omit a
line; the HTTP body must contain positive exact decimal strings. Numeric(20,6)
range and the product's quantity scale apply before effects. Quantities use the
same purchasing fixed-six normalization/exact-multiple contract, not floating
point. All quantities in DTOs are strings.

Order detail reports, for each line:

- orderedQuantity: frozen ordered amount after sending;
- receivedQuantity: transactionally maintained counter equal to the sum of
  immutable receipt-line quantities;
- remainingQuantity: ordered minus received, always nonnegative;
- pendingQuantity: remaining on non-cancelled orders, zero after cancellation;
- cancelledQuantity: remaining after cancellation, otherwise zero.

Pending is a backend read model, not a browser sum used for authorization.
Cancellation does not rewrite ordered or received quantities and never reverses
stock. Closed remanent is separately visible rather than presented as receivable.

## State machine

| From                    | Command                      | To                 |
| ----------------------- | ---------------------------- | ------------------ |
| DRAFT                   | Edit                         | DRAFT              |
| DRAFT                   | Send                         | SENT               |
| DRAFT                   | Cancel with reason           | CANCELLED          |
| SENT                    | Receive some but not all     | PARTIALLY_RECEIVED |
| SENT                    | Receive all                  | RECEIVED           |
| PARTIALLY_RECEIVED      | Receive some remaining       | PARTIALLY_RECEIVED |
| PARTIALLY_RECEIVED      | Receive final remaining      | RECEIVED           |
| SENT/PARTIALLY_RECEIVED | Cancel remaining with reason | CANCELLED          |

DRAFT/CANCELLED/RECEIVED reject new receiving work. RECEIVED and CANCELLED are
terminal. Original idempotent replays can return an earlier stored response after
the current state changes; that is no new receiving or backward transition.
Supplier/products remain protected from archival while an order is DRAFT, SENT
or PARTIALLY_RECEIVED. Unit/scale history locks still apply after closure.

## Single transaction and locks

The existing purchasing tenant writer acquires Organization FOR UPDATE and
reauthorizes the actor. Receiving also explicitly locks the PurchaseOrder row
FOR UPDATE before checking its state and counters, then locks selected lines in
stable UUID order. The current organization lock is stronger than per-order
serialization and deliberately coordinates send/cancel, catalog changes and
existing inventory writers, which take Organization FOR SHARE.

Under that lock, a positive conditional counter update cannot exceed ordered
quantity. Independent receipt requests see the prior committed counters before
acceptance, including disjoint-line requests that must derive one aggregate
header state. Selected stock keys are processed in product UUID order for the
fixed destination warehouse. Missing balance keys use the existing unique
insert/increment protocol through a shared inventory credit primitive.

One PostgreSQL transaction commits receipt/header/lines, received counters,
aggregate PO status, materialized balances, immutable movements and command
responses together. No separate inventory HTTP call, second transaction,
frontend computation or external delivery is involved. A failure after a first
stock credit rolls back all prior credits, receipt lines, counters, state and
idempotency effects. Balance overflow is also an all-or-nothing conflict.

Receipts and transfers use the same inventory tables and exact-quantity/ledger
constraints. Each receipt line has one normal InventoryCommand of type RECEIPT
and one InventoryMovement of type RECEIPT. The movement links
purchaseReceiptLineId and records referenceType PURCHASE_RECEIPT,
referenceId=receipt.id and correlationKey=receipt.id; its product/order line is
recoverable through the receipt line. The internal command key is derived from
the generated receipt-line identity and is separate from the outer receiving key.
No parallel stock system is introduced.

The receipt-to-command foreign key is deferred: the outer completed command is
inserted after its receipt/stock effects in the same transaction. Deferred
completion checks require its RECEIVE scope, actor/key/tenant and matching stored
receipt/order identities. PURCHASE_RECEIPT references are reserved for this writer;
standalone stock and transfer requests cannot manufacture that association.

## Idempotency and SQL defenses

PurchasingCommand adds RECEIVE scope to the existing tenant/key/actor hash and
stored-response protocol. Normalized quantity, order, warehouse and sorted
line identities define the canonical payload. Same key/intent returns the
original201 receipt/order result. Changed intent or actor conflicts. Concurrent
duplicates serialize and return one receipt, its lines and stock effects once.
Replays still require current permissions. Failed work has no completed result.

Deferred constraints check received counters against receipt sums, quantity
bounds, aggregate order state, receipt-line identity and movement linkage.
Existing immutable ledger/balance/command checks remain. New receipts/lines are
append only. Receipt command linkage is checked inside the same commit boundary;
an intermediate internal insert is not independently confirmed evidence. Real
SQL rejection tests supplement Prisma schema validation/diff.

## UI and operational limits

Order detail displays ordered/received/pending/cancelled quantities, active
warehouse selection and optional received amounts per line. The receive form is
available only to editors on SENT/PARTIALLY_RECEIVED orders. Busy state prevents
double submit; same-form retries retain their key after an ambiguous response.
Receipt history shows destination, actor, date and lines, and stock/ledger remain
queryable in Inventory after reload.

UI intent keys are memory-only; reconcile history before deliberately re-entering
an uncertain operation after reload. Organization-level serialization is a
correctness tradeoff, not a production throughput claim. Phase 8 adds bounded
[receipt and business-list pages](DASHBOARD.md), audit, alerts and dashboard;
Phase 9 adds reports and CSV. Returns, reversal, costs/totals, billing, payments
and deployment remain outside current scope.
Owners can disable SQL triggers/TRUNCATE; production role separation and load
testing remain necessary. See [executed evidence](PHASE7_VERIFICATION.md).
