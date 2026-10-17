# Inventory invariants and acceptance contract

**Phase 0 design contract, partially implemented in Phases 4–7.** Receipts/issues/adjustments, materialized balance, immutable movement chain and idempotency now have real PostgreSQL evidence in [Phase 4 verification](PHASE4_VERIFICATION.md). Atomic transfers now have a concrete [contract](TRANSFERS.md) and [Phase 5 verification](PHASE5_VERIFICATION.md). Phase 7 implements [purchasing receipts](RECEIVING.md) with [real verification](PHASE7_VERIFICATION.md). Phase 8 [business audit](AUDIT.md) is implemented; current combined regression is recorded in [Phase 10 verification](PHASE10_VERIFICATION.md). SQL below is pseudocode, not a migration or an executable routine. Unit tests or schema validation cannot establish these guarantees. Future integration tests need an authorized PostgreSQL instance, applied migrations, independent connections, and deterministic synchronization rather than timing sleeps.

## Invariants

1. Every balance, entry, operation, receipt, order line, and audit row belongs to exactly one organization. Composite FKs reject cross-tenant references; scoped authorization protects reads and writes.
2. Each product/warehouse has at most one balance within its organization, starting at zero. Every committed balance is nonnegative and follows product precision.
3. For each key, `balance.quantity = SUM(committed entry.delta)`, including opening and compensating entries. No public API may mutate one side independently. Absence of a balance represents zero; no ledger may exist without its balance key.
4. Every stock operation writes its balance changes, immutable ledger entries, business audit, and successful idempotency result in one database transaction. Rollback leaves none of those effects.
5. A transfer has different source/destination warehouses, same product/unit/organization, exactly two entries with equal magnitude and opposite signs, and no net change across warehouses. Source sufficiency is checked atomically.
6. Purchase quantities satisfy `0 <= received <= ordered`. Receipt quantities are positive and counted once. No confirmed receipt survives without its stock/ledger effects or vice versa.
7. Idempotency replays the same committed intent within the same tenant/scope; a different payload with the same key is a conflict. It does not replace balance locking or authorize the caller.
8. Ledger and business audit are append only; corrections create compensating records. Runtime database grants/triggers must reject ordinary UPDATE/DELETE of these histories.

CHECK constraints enforce per-row values/signs, `NOT NULL`, bounds and precision rules where representable. Unique/composite FKs enforce identity/tenancy. Equality to the ledger and a two-entry transfer are cross-row invariants: the common transaction writer and integration tests enforce them, with reconciliation detecting drift. The implemented Phase 5 model additionally uses deferred cross-row triggers for transfer pairs and command completion; these are **not** enforced by a single CHECK or Prisma relation. The runtime role must not have unrestricted stock-write paths outside the writer; owner/manual SQL access remains a trusted administrative boundary.

## Atomic issue

Use READ COMMITTED, a conditional UPDATE, and `CHECK (quantity >= 0)`. PostgreSQL rechecks an UPDATE predicate after a concurrent row updater commits at READ COMMITTED; this is the basis of the guarded decrement. See official [transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html).

```sql
-- PSEUDOCODE: validate q > 0 and exact scale before opening transaction.
-- organization and actor come from authenticated/authorized context.
BEGIN;
-- Claim idempotency, lock active product/warehouse as described below.
UPDATE stock_balance
SET quantity = quantity - :q
WHERE organization_id = :org AND product_id = :product
  AND warehouse_id = :warehouse AND quantity >= :q
RETURNING quantity;
-- Exactly one row required. Zero rows => insufficient stock (including absent row).
-- On rejection: ROLLBACK, no ledger/audit-success/idempotency success record.
INSERT INTO inventory_operation (...) VALUES (...);
INSERT INTO inventory_entry (..., delta) VALUES (..., -:q);
INSERT INTO audit_event (...) VALUES (...);
-- Persist replay response on claimed idempotency record.
COMMIT;
```

For stock 5 with simultaneous issues 4 and 3, one succeeds and the other fails; final stock is 1 or 2, never -2. A prior unlocked SELECT is informational only. A positive credit uses `quantity = quantity + :q`, not a replacement computed in application memory. Reject numeric overflow and roll back the entire operation.

## Transfers and lock discipline

Global mutation order: claim idempotency; lock Organization FOR SHARE (FOR UPDATE for membership/ownership changes); lock the actor membership FOR SHARE and recheck active role/permission; lock active parents (products by UUID, then warehouses by UUID); lock purchasing header if applicable, then its lines by UUID; create/lock balance rows by `(organizationId, productId, warehouseId)` bytewise UUID order. Every writer touching multiple rows must use this order, including first-use creation. Membership/archival changes acquire conflicting parent locks; no writer may acquire an earlier resource after a later resource. Avoid calls to another use case that secretly begins its own transaction or acquires locks out of order.

```sql
-- PSEUDOCODE: one transaction, positive q, distinct warehouses, same tenant.
-- First claim idempotency and validate/lock active parents.
-- For each balance key in sorted order, sequentially (not Promise.all):
INSERT INTO stock_balance (organization_id, product_id, warehouse_id, quantity)
VALUES (:org, :product, :warehouse, 0)
ON CONFLICT (organization_id, product_id, warehouse_id) DO NOTHING;
-- Then SELECT each key FOR UPDATE in the same sorted order.
-- Zero rows cannot be locked: sorted upsert handles first-use destination races.
-- Conditional debit source as above; require one affected row.
UPDATE stock_balance SET quantity = quantity + :q WHERE ...destination key...;
-- Write one operation, TRANSFER_OUT(-q), TRANSFER_IN(+q), audit, stored response.
-- COMMIT all; any exception ROLLBACK all.
```

Sorted locking reduces deadlocks; it does not prove they never happen (FK locks and new code can introduce cycles). PostgreSQL may abort one transaction on deadlock. See [explicit locking and deadlocks](https://www.postgresql.org/docs/18/explicit-locking.html). The whole transaction retry must reacquire all locks from the start.

## Partial purchase receipts

After idempotency and active-parent locks, `SELECT ... FROM purchase_order WHERE organization_id=:org AND id=:id FOR UPDATE`. Every receipt, send/edit, and cancellation uses this header lock. Read current state **after** acquiring it; reject DRAFT/RECEIVED/CANCELLED as appropriate. Lock requested lines in ID order and revalidate tenant/order membership, duplicate IDs, exact quantity and current pending amount. Update received counters with a conditional predicate and CHECK bounds as a defense. Acquire affected balance keys in sorted order, credit them, append receipt/ledger/audit and recompute header state from all lines. Persist replay response and commit together.

For ordered 10 / received 6, simultaneous receipts of 3 and 2 cannot both succeed: the second sees the updated pending amount under the header lock. Receipt-versus-cancellation is ordered by that same lock. Cancellation after partial receiving preserves all completed receipts and stock while preventing further receipt.

## Idempotency protocol

Require a bounded opaque client key for every stock command and receipt (also transfer and confirmed import). Scope is a versioned command name, e.g. `inventory.transfer.v1`; uniqueness is `(organizationId, scope, key)`. Hash a canonical representation of the validated command including normalized decimals, resource IDs, effective actor, and business fields. Reject repeated line IDs before canonical sorting. Do not hash raw JSON formatting. Include the target order ID where applicable. Keys and hashes must never contain secrets.

1. Authenticate and preliminarily authorize every request, including replay. This check grants no durable permission by itself. Inside the transaction, after claiming the idempotency key, lock Organization FOR SHARE, then the actor membership FOR SHARE, and recheck active status and permission before replay or mutation. FOR SHARE conflicts with non-key role/status updates; FOR KEY SHARE is insufficient. Membership/ownership changes take Organization FOR UPDATE first and recheck the last-owner invariant under that common lock. All writers follow the same order.
2. Begin transaction and insert the unique idempotency claim using `ON CONFLICT DO NOTHING RETURNING ...`. The uncommitted unique key coordinates simultaneous duplicates. If no row was inserted, issue a subsequent SELECT at READ COMMITTED to read the now committed result; then acquire the organization/membership locks and reauthorize as above before comparing hash/actor. Same hash returns stored status/body/resource IDs, different hash returns 409. The winning claim also acquires those locks before business mutation. Never treat a unique violation as automatic success.
3. Winner performs the command and stores a complete success response on that row in the same transaction. No durable incomplete claim is committed. Lock wait/statement timeout produces a retryable response, not a second operation.
4. Commit before responding. A disconnect after commit replays the stored result. Failure before commit rolls back claim and effects, permitting a retry. Deterministic rejected commands are not persisted initially; document that a later retry may succeed if stock changes.

Retain committed keys/results for the MVP lifetime; do not silently TTL-delete them and allow an old request to execute twice. A later retention policy must define a maximum accepted key age and rejection/tombstone semantics first. Replayed responses describe the original result; they are not a promise of the current balance. Never store tokens or personal details unnecessarily in responses.

Retry only recognized SQLSTATE 40001/40P01 (and verified Prisma mappings) with at most three total transaction attempts and bounded jitter. Treat lock timeouts separately with a clear retryable error; do not loop indefinitely. Retry keeps the same key/hash. Constraint/insufficient-stock/permission/payload conflicts are not automatic retries. No external effects occur inside a retried transaction.

## Required acceptance scenarios (design checklist; see current phase evidence)

| Case                                         | Required proof                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Two issues 4 and 3 against 5                 | Independently synchronized clients; exactly one success; balance 1 or 2; one operation and matching ledger/audit   |
| 50 competing issues against bounded stock    | No negative value; successful deltas equal initial minus final; each success has one operation                     |
| Direct negative SQL                          | Applied CHECK rejects negative balance even outside HTTP                                                           |
| Decimal boundaries                           | Fractional allowed unit accepted; excess product scale, >6 decimals and overflow rejected without rounding/effects |
| Transfer failure after debit                 | Inject failure before credit/ledger/audit/result; both balances and all histories unchanged                        |
| Opposite-direction and first-use transfers   | Separate clients, absent destination rows, forced overlap; conservation and bounded retry; no duplicate balances   |
| Concurrent credits                           | Exact sum preserved, no lost update                                                                                |
| Receipt 3 and 2 with only 4 pending          | Exactly one success; counter <= ordered; only successful receipt increases stock                                   |
| Receipt/cancel race and partial cancellation | Serialized state; prior receipts preserved; no receipt commits after cancellation wins                             |
| Concurrent same key/payload                  | One effect; all completed responses replay same resource/status/body, including after simulated lost response      |
| Same key/different payload or actor          | 409 and no second effect; other organization can independently use the same key                                    |
| Failed command then retry                    | Rollback leaves no incomplete claim; retry can apply once after transient failure                                  |
| Tenant boundary                              | IDs from another tenant rejected on reads/lists/joins/exports/writes; direct composite FK violation fails          |
| Archive/revoke race                          | Writer and archive/membership change serialize; no unauthorized/inactive mutation after revocation wins            |
| Append-only history                          | Runtime role cannot UPDATE/DELETE ledger/audit; compensating entry preserves history                               |
| Audit failure                                | Forced audit insertion failure rolls back balance, receipt, ledger and replay result                               |
| Deadlock/serialization failure               | Real/injected recognized failure retries whole transaction within limit with one committed effect                  |
| Reconciliation                               | Consistent snapshot agrees for all keys; deliberate fixture drift is reported without automatic repair             |

Run tests on the actual migration set and database major version intended for use. HTTP mocks and in-memory repositories are insufficient evidence for isolation. Record commands, database version, commit, repetitions and failures before upgrading this design to verified behavior.
