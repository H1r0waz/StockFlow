# Suppliers and purchase orders — Phases 6–7

Draft/send/cancel prepares purchase orders without stock effects. Phase 7 adds
[physical receiving](RECEIVING.md), counters, partial/full states and atomic
inventory/ledger integration. Billing, payments and valuation remain absent.

## Supplier identity and lifecycle

Supplier has a UUID, required organizationId/name, optional legalName, taxId,
email, phone and notes, active flag and timestamps. Names may repeat, including
within an organization; tax identifiers are optional administrative text rather
than a verified fiscal identity. Names are trimmed and required (max200), legal
names max200, taxId/phone max100, email max254 and notes max2000. Optional empty
text becomes null. Non-null taxId is unique within its organization, trimmed and
case-sensitive; multiple null values and the same value in other organizations
are allowed. Email is lowercased and syntax-checked. No fiscal verification is claimed.

All reads and mutations are organization-scoped. OWNER and ADMIN edit; MEMBER
reads. PATCH activation/deactivation preserves identity and references. There is
no hard-delete endpoint. An inactive supplier cannot be chosen for a new draft,
edited draft or send. Deactivation is rejected while a DRAFT, SENT or PARTIALLY_RECEIVED order
references it; cancelled historical orders remain readable.

## Order and line contract

PurchaseOrder has a UUID, organization, supplier, creator, status, notes,
created/updated timestamps and send/cancellation metadata. UUID is the public
identifier in this phase. A human sequential number is deliberately omitted:
there is no COUNT+1 or partially implemented numbering promise. Add a dedicated
transactional sequence policy if a later product requirement needs human numbers.

PurchaseOrderLine belongs to its order and organization, references a same-tenant
product and holds orderedQuantity numeric(20,6) and timestamps. Orders contain
1–100 lines with one line per product. Duplicate products are rejected rather
than silently consolidated. Quantities are positive decimal strings validated
before numeric casts, obeying the product's quantityScale and the inventory
parser's exact range. JSON numbers, exponents, signs and more than six fractional
digits are rejected. Purchasing canonicalizes to six places and checks the exact
product-scale multiple, so redundant trailing zeros are accepted (KG scale3
accepts1.2500 and rejects1.2501). This allows a returned fixed-six draft to be
edited without loss; inventory movement APIs retain their original stricter
lexical digit-count contract. DTO quantities use fixed six-place strings.

Unit costs and totals are deliberately absent. A monetary contract needs a
currency, price scale, rounding and total/tax policy; quantity precision is not a
money policy. The UI explains that costs are not recorded. This phase verifies
quantities and lifecycle only, not commercial purchase valuation.

Draft creation/editing requires active same-tenant supplier and products.
Unit/scale changes are blocked while any order line references a product,
including cancelled history; existing inventory-history restrictions remain.
Product archival is blocked while DRAFT/SENT/PARTIALLY_RECEIVED lines reference it. These catalog
writes use the same organization lock as purchasing to prevent validation races.

## State machine and transaction boundary

| Current state | Allowed action                         | Result                                         |
| ------------- | -------------------------------------- | ---------------------------------------------- |
| DRAFT         | Replace supplier/notes/lines           | DRAFT                                          |
| DRAFT         | Send                                   | SENT; supplier and products revalidated active |
| DRAFT         | Cancel with nonempty reason            | CANCELLED                                      |
| SENT          | Cancel with nonempty reason            | CANCELLED; frozen supplier/lines retained      |
| SENT          | Edit or send again with a new intent   | Conflict                                       |
| CANCELLED     | Edit, send or cancel with a new intent | Conflict                                       |

An original successful command replay still returns its stored response after
later transitions; this is not a new transition or a current-state stock view.
PARTIALLY_RECEIVED and RECEIVED are operational receiving states in Phase 7.
SENT/PARTIALLY_RECEIVED receive positive pending quantities; full receipt closes
the order. PARTIALLY_RECEIVED may cancel only its remaining quantities, preserving
received stock. RECEIVED is terminal. See the complete [state machine](RECEIVING.md). No generic PATCH accepts status, creator, organization,
received quantities or timestamps. There is no reopen or order-delete endpoint.

All writes acquire Organization FOR UPDATE and revalidate live session/membership
using the existing tenant writer protocol. This intentionally serializes writes
within one organization, including supplier/catalog changes. It is a compact
correctness choice for this phase; throughput under production load is not
verified. Database guards supplement API validation with tenant composite FKs,
positive quantities, line uniqueness and lifecycle/immutability checks.

Concurrent sends produce one logical transition. Draft edit versus send is
serialized: edit first means send sees its complete replacement; send first
means edit conflicts. Cancel versus send obeys the same machine: a cancelled
order cannot subsequently send; a sent order may cancel. No interleaving can
commit partial replacement lines or an intermediate header state. Any failure
rolls back the draft/lines/command effects together. Draft/send/cancel call no
inventory writer; the separate receiving command does so inside the same transaction.

## API and idempotency

All routes are under /api/organizations/:organizationId:

| Route                            | Behavior                                             |
| -------------------------------- | ---------------------------------------------------- |
| GET /suppliers                   | {suppliers}                                          |
| GET /suppliers/:id               | {supplier}                                           |
| POST /suppliers                  | Create {supplier}                                    |
| PATCH /suppliers/:id             | Edit or change active flag                           |
| GET /purchase-orders             | {purchaseOrders}                                     |
| GET /purchase-orders/:id         | {purchaseOrder}, supplier/creator/lines/product DTOs |
| POST /purchase-orders            | Create a draft                                       |
| PATCH /purchase-orders/:id       | Replace a draft's supplier/notes/entire line set     |
| POST /purchase-orders/:id/send   | Domain send command, body{}                          |
| POST /purchase-orders/:id/cancel | Domain cancellation, body{reason}                    |

Create/replace body: {supplierId,notes?,lines:[{productId,orderedQuantity}]}.
Full replacement implements line addition/removal/quantity editing atomically;
line UUIDs are server-owned. Empty/duplicate/foreign lines reject the entire
request. Foreign order IDs and mixed organization references return scoped404.
Session cookie, exact Origin, CSRF and backend permissions apply to all writes.

Create order, send and cancel require the established Idempotency-Key format.
PurchasingCommand reuses the unique-key/hash/stored-response pattern with a
separate purchasing scope because these commands have no stock movement. Under
the exclusive organization lock, it looks up an existing command before effects
and inserts only its completed response in the same transaction. No pending
claim is persisted. Hash includes tenant-scoped resources, actor, normalized quantities and
intent fields. Same key/intent replays the committed response; changed payload or
actor conflicts. Replay reauthorizes the current actor. Incomplete work rolls
back the claim too; completed commands are immutable and retained without TTL.

Supplier creation has no idempotency key and may create duplicate names if
deliberately retried; check the list after an ambiguous network result. Supplier
PATCH and draft replacement set a complete desired state; they do not append
extra lines on retry. They are not versioned optimistic edits: concurrent draft
edits serialize with the last completed replacement winning. The UI retains a
key for an unchanged order-command retry while mounted; reload loses an ambiguous
pending intent, so reconcile the order list/details before starting a new intent.
Creation returns201; edit/send/cancel return200, including command replays.

## Evidence and limits

See [Phase 7 verification](PHASE7_VERIFICATION.md) and historical
[Phase 6 verification](PHASE6_VERIFICATION.md) for actual PostgreSQL,
concurrency and browser results. API validation is not fiscal validation. Database
owner/manual SQL remains a trusted administrative capability; triggers do not
make data tamper-proof against an owner. Production privileges, TLS/proxy,
sustained load and full business audit remain unverified or future work. Supplier
and order lists currently return all scoped records and order lines; pagination
and large-tenant load behavior remain future work. Notes/contact text is bounded
and control characters are rejected; do not put secrets in these business fields.
