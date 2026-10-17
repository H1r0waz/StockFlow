# Atomic warehouse transfers — Phase 5

One transfer moves a positive exact quantity of one product between distinct
warehouses in the same organization. Phase 6 adds [suppliers and purchase
orders](PURCHASING.md) separately; Phase 7 adds [receiving](RECEIVING.md) sharing
inventory primitives. Commercial dashboards remain future work.

## Contract and evidence

POST /api/organizations/:organizationId/inventory/transfers requires the existing
session cookie, Origin/CSRF protection and Idempotency-Key. OWNER and ADMIN can
transfer; MEMBER can query inventory but cannot transfer.

The allowlisted body is productId, sourceWarehouseId, destinationWarehouseId and
quantity, with optional reason, referenceType and referenceId. IDs must be valid
UUIDs. All parents must exist in the session's organization. Product and both
warehouses must be active. An archived source is deliberately rejected too;
reactivate it before moving remaining stock. Existing catalog rules prohibit
archiving positive stock. The source must differ from the destination.

Quantity uses the existing positive decimal-string parser: numeric(20,6) range,
at most the product's quantityScale fractional digits, no exponent, signs,
whitespace, commas or JSON numbers. There is no conversion between products or
units. Critical calculations use bigint millionths and PostgreSQL numeric.

Success201 returns {transfer,sourceBalance,destinationBalance,movements}.
Quantities and balance versions are strings. InventoryTransfer provides a stable
immutable identity, organization/product/source/destination, quantity, actor,
command, key, optional reason/references and timestamp. No status is needed:
only fully committed transfers exist; rejected or rolled-back attempts have no
transfer record. Cancellation/reversal and transfer editing/deletion are absent.

Exactly two immutable movements belong to a transfer: TRANSFER_OUT at source and
TRANSFER_IN at destination. Both carry transferId and correlationKey equal to the
transfer UUID, plus their own previous/resulting balance and version. Their
quantities are equal and their signed sum is zero. This ledger and transfer
record provide the stock-specific audit evidence. No separate general-purpose
business AuditEvent model or audit UI is claimed.

## Transaction and locks

Use one READ COMMITTED Prisma interactive PostgreSQL transaction:

1. Claim the existing tenant/scope/key command identity, then lock Organization
   FOR SHARE and actor membership FOR SHARE; revalidate live session and role.
2. Replay a completed matching intent or reject a changed payload/actor. For new
   work, validate same-tenant active parents and product precision.
3. Sort the two normalized warehouse UUIDs in ascending lexical order. Product
   and organization are fixed, so this orders the full balance keys too. For
   each key sequentially, insert a zero/version0 balance ON CONFLICT DO NOTHING
   and lock that row FOR UPDATE. Creation is part of the same lock discipline;
   never create destination first by its business role or in Promise.all.
4. Debit source with a conditional nonnegative guard and credit destination with
   a maximum-range guard, incrementing each balance version. Derive previous
   quantities exactly from the returned transitions.
5. Insert transfer and both ledger movements, persist the exact success response
   on the command and commit. A failure at any point rolls back everything,
   including newly created zero rows and the idempotency claim.

Opposite A→B and B→A operations take the same first lock. Two credits to an absent
destination coordinate via the existing unique organization/product/warehouse
constraint, and increments cannot overwrite a stale application snapshot.
Single-location receipt/issue/adjustment writers touch only one balance, so they
do not introduce a reverse second balance acquisition. Catalog/membership changes
take Organization FOR UPDATE and serialize against these inventory writers.

Recognized serialization/deadlock conflicts reuse the existing bounded retry
policy: at most three whole-transaction attempts with jitter. Business conflicts
are not automatically retried. Deterministic ordering removes the ordinary
opposite-transfer cycle; it is not a claim that every possible administrative or
future multi-resource workload is deadlock-free.

## Database defenses and idempotency

The additive transfer migration preserves prior migrations and inventory checks.
It extends movement directions, relaxes one-command/one-movement to a constrained
pair for TRANSFER commands, and keeps ordinary commands at exactly one movement.
Tenant composite foreign keys, positive quantities, distinct warehouses,
per-command direction uniqueness, immutable transfers/movements, movement chain
validation and deferred transfer/command completion checks reject partial or
mismatched committed evidence. Balance/ledger consistency is still checked at
commit. A schema diff does not independently prove trigger semantics; direct SQL
rejection tests supplement migration replay.

Scope remains (organizationId,commandType,key), with TRANSFER as the transfer
scope. Canonical payload hashing includes the actor, both warehouse IDs, product,
normalized quantity and optional reason/references. Same key and same intent
replay the original201 body, even if stock later changes. A different direction,
quantity, actor or other payload field conflicts. Replay reauthorizes current
session/membership. Concurrent duplicates wait on the unique command claim and
produce one logical transfer and two movements. Failed commands leave no
completed or pending claim. No retention/TTL policy deletes completed results.

## UI, limits and verification

The inventory UI offers product/source/destination selection, exact available
source stock, quantity, success/error feedback, balance refresh and correlated
history. Available stock is informational; the backend decides sufficiency.
MEMBER sees no write controls. The form retains a key for a same-intent network
retry while mounted. Reload loses an ambiguous pending intent; reconcile history
before deliberately entering it again. List limits and loaded-result search from
Phase 4 remain; transfer creation has no generic movement CRUD bypass.

See [Phase 5 verification](PHASE5_VERIFICATION.md) for actually executed results.
Concurrency examples and injected rollback are not a sustained-load benchmark.
Production role separation, TRUNCATE revocation, TLS/proxy configuration and all
possible driver retry mappings remain outside local evidence. Database owners
can disable triggers or alter schema; strict lexical input validation is needed
because direct numeric casts can round before SQL checks see their input.
