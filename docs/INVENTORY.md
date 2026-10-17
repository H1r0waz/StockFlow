# Inventory — Phases 4–8

Materialized balances and an append-only movement ledger are implemented for
RECEIPT, ISSUE, ADJUSTMENT_IN and ADJUSTMENT_OUT. Phase 5 adds paired
TRANSFER_OUT/TRANSFER_IN through one [transfer command](TRANSFERS.md). Phase 6 [supplier/order commands](PURCHASING.md) exist but never mutate stock.
Phase 7 [purchasing receipts](RECEIVING.md) reuse the transactional credit primitive
and append linked RECEIPT movements with receipt-line identity. Phase 8 adds
[transactional business audit](AUDIT.md) without duplicating transfer/receipt
legs. External notifications remain future work; the inventory ledger retains
durable actor/reason/correlation evidence.

## Model and exact quantities

InventoryBalance is unique on (organizationId,productId,warehouseId). It holds
quantity numeric(20,6) and a monotonically increasing bigint version. Composite
Product/Warehouse foreign keys prohibit cross-tenant associations.

InventoryMovement stores positive quantity, previousBalance, resultingBalance,
balanceVersion, type, actor, optional reason/referenceType/referenceId, command,
idempotency/correlation keys and timestamp. Balance versions, not timestamps or
UUID order, define the transition order. Product/warehouse/balance/command FKs
are tenant-safe; the actor is a global user checked through active membership.

Ordinary inventory commands own exactly one movement; TRANSFER owns exactly two
correlated movements and an immutable InventoryTransfer. Its stored JSON
response is committed with the movement. No success response is sent until commit.
Both representations are authoritative together: the ledger explains all changes;
the materialized quantity serves reads and conditional writes. Corrections are
new explicit adjustments, never ledger edits.

Quantity payloads must be strings in plain positive decimal notation: no sign,
exponent, commas, whitespace, zero or more than 14 integral / 6 fractional digits.
Fractional digit count cannot exceed Product.quantityScale, including trailing
zeros. Transported quantities use fixed six-place decimal strings. Critical
arithmetic uses bigint in millionths plus PostgreSQL numeric, never Number.
Version also travels as a string. Noncritical bounded limits use Number.

Examples: KG scale3 accepts 1.250 and rejects 1.2509. UNIT scale0 accepts 1 and
rejects 1.0. Maximum stored quantity is 99999999999999.999999. Credits exceeding
it return a conflict without changing history. Unit and precision cannot change
after any movement; catalog deactivation rejects positive stock. At zero stock,
deactivation is allowed and all history remains queryable. Inactive product or
warehouse rejects new mutations. Category archival does not prohibit stock for
an otherwise active product already associated with that category.

## Transaction and concurrency protocol

At READ COMMITTED, claim the unique (organizationId,type,key) idempotency record
with INSERT ON CONFLICT DO NOTHING. Then acquire Organization FOR SHARE and
Membership FOR SHARE; reread live session and actor permission. Catalog and
membership writers use Organization FOR UPDATE, so archiving/unit changes and
revocation serialize against inventory. Inventory writers share that lock and
can genuinely compete on the same balance row.

For RECEIPT/ADJUSTMENT_IN, insert a zero/version0 balance with ON CONFLICT DO
NOTHING, then atomically increment quantity and version using UPDATE RETURNING.
For ISSUE/ADJUSTMENT_OUT, UPDATE subtracts only WHERE quantity >= requested.
No row means insufficient stock, including an absent balance. A failed debit
does not create a balance. The previous quantity is derived exactly from the
returned committed-row transition, not from an unlocked SELECT snapshot.

Insert the corresponding movement, store the exact JSON response and commit.
Any failure, including failure after UPDATE or a deferred consistency failure,
rolls back balance, ledger and idempotency claim. The transaction contains no
external side effects. SQLSTATE 40001/40P01 and Prisma P2034 mappings trigger at
most three total transaction attempts with bounded jitter, keeping key/hash.
Business conflicts are not automatically retried. Exhaustion/unrecognized
database errors use the safe existing error response; caller retries the same
key after an ambiguous network result. Real deadlock-retry behavior has not yet
been load-tested; the normal concurrent paths are tested against PostgreSQL.

## SQL defenses

Migration 202610170003_inventory adds:

- Nonnegative balance quantity/version; positive movement quantity/version and
  nonnegative previous/resulting quantities; direction-specific arithmetic CHECK.
- Unique balance key, unique movement version for that key and one movement per
  ordinary command; tenant composite FKs; required nonempty adjustment reason.
- BEFORE INSERT movement trigger checking product precision, previous-version
  continuity and matching command actor/type/key.
- Deferred balance/movement triggers requiring final balance version/quantity to
  equal the latest movement, or zero/version0 for a new unused balance.
- Deferred command completion requiring a stored JSON object and its movement.
- BEFORE UPDATE/DELETE movement rejection and completed-command immutability.

Checks operate at commit where needed, allowing temporary internal imbalance
within a transaction but rejecting a confirmed partial result. A privileged
administrator can disable triggers, TRUNCATE tables or alter schema. These
controls are not tamper-proof against database owners. Tests TRUNCATE only the
guarded dedicated stockflow_test database. Production role separation and
TRUNCATE revocation are still required before deployment.

PostgreSQL numeric(20,6) casts round excess scale before row checks see it;
strict lexical validation at the HTTP boundary prevents that behavior for API
requests. Direct SQL users are a trusted operational boundary, not permitted
to bypass the application's decimal parser. No representation promises arbitrary
precision beyond numeric(20,6).

## Idempotency

Every stock command requires Idempotency-Key, 1–128 ASCII characters from
A–Z/a–z/0–9/._:-. Scope is tenant plus command type plus key (TRANSFER for a paired transfer). The canonical
SHA-256 payload includes actor, normalized quantity, resource IDs, reason and
optional references. Equivalent valid decimals 1.25/1.250 hash identically.
Same intent replays its stored 201 body; changed intent or actor returns409.
Replay rechecks current membership/permission even if catalog state changed.

Concurrent duplicate keys coordinate via PostgreSQL unique-key conflict waiting;
the losing transaction rereads the committed result. Failure before commit
leaves no durable unfinished claim. Keys have no automatic TTL: completed
commands/results are retained to avoid executing an old retry twice. Responses
represent the original command result, not current stock. Reference fields are
bounded text, not arbitrary request metadata; callers must not place secrets there.
The UI keeps the same key for a same-form retry after an ambiguous failure.

## HTTP and UI

Under /api/organizations/:organizationId/inventory:

| Route             | Behavior                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| GET /balances     | {balances,hasMore}; materialized keys only; absent keys mean zero         |
| GET /movements    | {movements,hasMore}; latest movements first                               |
| POST /receipts    | Positive intake                                                           |
| POST /issues      | Positive requested removal                                                |
| POST /adjustments | direction IN/OUT and required reason                                      |
| POST /transfers   | One atomic transfer with source/destination; see [contract](TRANSFERS.md) |

Commands take productId,warehouseId,quantity and optional reason/reference fields;
adjustments also take direction. Success201 returns {movement,balance}. OWNER
and ADMIN write; MEMBER reads. Exact Origin, CSRF and session tenant binding are
unchanged. Allowlists reject organizationId, balances, actors, timestamps or
other mass-assignment fields. There is no generic movement PATCH/DELETE.

List filters: productId, warehouseId; movements additionally type and ISO
timestamp from/to. Limit defaults100, maximum200; hasMore reports truncation.
The UI searches product name/SKU within loaded results, filters warehouse and
movement type, displays exact strings, unit, actor and timestamp, and offers the
four commands only to editors. It discloses result limits; cursor pagination,
full-dataset search and commercial dashboard are not implemented.

Executed checks and limitations: [Phase 7 verification](PHASE7_VERIFICATION.md);
[Phase 5 verification](PHASE5_VERIFICATION.md) covers transfer introduction;
[Phase 4 verification](PHASE4_VERIFICATION.md) is historical evidence.

Primitive semantics were checked against PostgreSQL18 official
[READ COMMITTED documentation](https://www.postgresql.org/docs/18/transaction-iso.html)
and [constraint-trigger documentation](https://www.postgresql.org/docs/18/sql-createtrigger.html).
