# ADR 0001: Transactional balances with an immutable inventory ledger

- Date: 2026-10-16
- Status: Accepted for design on 2026-10-16; implemented incrementally in Phases 4–9. Current executed regression and limits are in [Phase 10 verification](../PHASE10_VERIFICATION.md).
- Scope: Inventory, transfers, purchasing receipts, audit and idempotency

## Context

StockFlow needs fast per-warehouse availability, fractional quantities, explainable history, and correctness when separate API processes compete. A read/check/write in application memory races. A client retry can duplicate an otherwise correct transaction. Ledger-only summation makes guarded consumption and hot-path reads harder; balance-only storage loses the durable explanation.

## Decision

Keep one materialized exact-decimal balance per tenant/product/warehouse and immutable signed ledger entries. Update balances, operation/receipt, ledger, business audit and stored idempotent response in one PostgreSQL transaction. History explains every change and supports reconstruction; balances are the operational projection, and equality between them is an explicit invariant.

Use READ COMMITTED with conditional atomic debit (`quantity >= requested`) plus nonnegative CHECK constraints. Acquire multi-row locks and first-use upserts in a deterministic global order. Serialize purchase changes on the order header and validate line pending amounts under that lock. Use tenant composite foreign keys and request authorization together. Use a tenant/scope/key unique idempotency record with canonical payload hash and stored result in the same transaction. Apply bounded retries only to recognized transaction aborts.

Detailed contracts and unexecuted SQL are in [inventory invariants](../INVENTORY_INVARIANTS.md); quantities and order lifecycle are in [domain](../DOMAIN.md).

## Consequences

Reads stay simple and transactions can enforce source sufficiency without serializing unrelated products. Two representations require one controlled writer, restrictive runtime access, migrations beyond Prisma's declarative model, consistent-snapshot reconciliation, and failure/concurrency integration tests. A database administrator can still alter data; append-only does not mean cryptographic tamper-proofing. Partial-order cancellation keeps prior receipts and cancels only the remainder.

Not chosen: ledger-only stock aggregation, mutable history, application-only mutexes, balance-only persistence, or blanket SERIALIZABLE isolation. SERIALIZABLE can be reconsidered for new multi-row invariants, with measured retry behavior. No choice here proves the constraints exist or tests pass in a live database.
