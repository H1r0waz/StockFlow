# Business audit — Phase 8

AuditEvent answers who performed a business action, on which entity and when.
It complements the inventory ledger; stock quantities and signed delta history
remain authoritative in that ledger. Capture begins with this migration, without
historical backfill, invented actors or external log delivery.

Phase 9 adds an atomic IMPORT_CONFIRM event per confirmed import, with resource
type and total/valid/invalid/created/updated/skipped/failed counts. The import job
UUID correlates this summary with ordinary catalog row events. Raw CSV, preview
tokens and supplier contact values are excluded; replay adds no events. See
[imports](IMPORTS.md) and [report/export permissions](REPORTS.md).

## Atomic capture and safety

After transaction-level reauthorization, tenant and manual inventory writers set
transaction-local stockflow.actor_id. PostgreSQL AFTER row triggers insert audit
inside the same business transaction. An audit insert failure rolls back business
effects, ledger and idempotency state. Completed idempotent replay performs no new
business write and produces no duplicate event. Transaction-local context does
not persist into the next pooled transaction.

No actor context means no event: direct SQL fixtures, initial owner registration
and independent administrative SQL are not attributed. This is prospective API
business auditing, not comprehensive database-access or security-request logging.
Login/logout and failed authentication are deliberately outside it.

## Event contract

Each event has UUID id, organizationId, nullable actorId, action, entityType,
entityId, nullable previousState/newState, metadata, correlationKey and createdAt.
Authorized reads add actor {id,displayName}, or null. Production writers currently
supply an authenticated actor; nullable schema supports future explicit system
actors without inventing one now.

| entityType                             | Captured action names                         |
| -------------------------------------- | --------------------------------------------- |
| Category, Product, Warehouse, Supplier | CREATE, UPDATE, ACTIVATE, DEACTIVATE          |
| Membership                             | CREATE, UPDATE, DELETE                        |
| InventoryThreshold                     | CREATE, UPDATE                                |
| InventoryMovement                      | RECEIPT, ISSUE, ADJUSTMENT_IN, ADJUSTMENT_OUT |
| InventoryTransfer                      | TRANSFER                                      |
| PurchaseOrder                          | CREATE, UPDATE, SEND, CANCEL                  |
| PurchaseReceipt                        | PURCHASE_RECEIPT                              |

Catalog/threshold/membership/order triggers also cover row deletion under an
explicit actor context, but normal HTTP does not expose deletion of durable
business records. The table lists normal application actions, not new endpoints.
A no-op catalog PATCH can still record UPDATE. A draft order's line replacement
records its accompanying header UPDATE without copying all lines into metadata.

Transfer legs and receipt stock legs are omitted from movement audit: one parent
TRANSFER or PURCHASE_RECEIPT event links to their existing immutable history.
Receipt-derived order transitions to PARTIALLY_RECEIVED/RECEIVED are omitted to
avoid redundant events. A later explicit cancellation remains CANCEL.

Previous/new state permits only fields that exist on the entity from this list:
active, role, status, categoryId, unitOfMeasure, quantityScale, supplierId,
minimumQuantity, productId, warehouseId. Values are never a raw row/HTTP body.
For updates metadata.changedFields contains changed column names (excluding
updatedAt); these labels can mention notes or contacts, but never their values.
Native stock events use no previous/new quantity copy. Their metadata contains:

- InventoryMovement: productId, warehouseId, commandId.
- InventoryTransfer: productId, sourceWarehouseId, destinationWarehouseId, commandId.
- PurchaseReceipt: purchaseOrderId, warehouseId, commandId.

Passwords, token/hash/CSRF values, cookies, authorization, supplier contact/tax
values, descriptions, free-form notes, names and arbitrary caller metadata are
not persisted in these audit payloads. Actor displayName is joined only into the
minimal authorized read DTO; it is not copied into immutable metadata.

## Correlation and immutability

Ordinary stock events use the movement's correlationKey (inventory command UUID).
Transfers use transfer UUID, also shared by their ledger legs. Purchasing receipts
use receipt UUID, also shared by receipt ledger rows; metadata links the order and
purchasing command. For tenant writes, a syntactically valid Idempotency-Key is
transaction-local correlation context; order create/send/cancel therefore retain
that key. Without one, audit falls back to the entity UUID. PurchasingCommand and
InventoryCommand retain the persisted idempotency intent/result; audit does not
copy payload hashes or response bodies.

Normal HTTP exposes no audit create/edit/delete API. PostgreSQL rejects UPDATE
and DELETE on AuditEvent with SQLSTATE 55000. Database owners can disable
triggers, TRUNCATE or alter schema; direct SQL without actor context is not
captured. This is application integrity, not tamper-proof storage against a
privileged administrator. Least privilege, retention and external archival remain
production work.

## Permissions, filtering and pagination

GET /api/organizations/:organizationId/audit is OWNER/ADMIN only; MEMBER receives
403 and retains dashboard/alert read access. Session tenant predicates apply to
all queries, including combined filters. Foreign tenant actor/entity UUID filters
return empty results rather than exposing foreign events.

Response: {events,hasMore,nextOffset}. Supported filters:

| Query              | Validation/meaning                                                       |
| ------------------ | ------------------------------------------------------------------------ |
| actorId, entityId  | UUID; exact match                                                        |
| entityType, action | Exact case-sensitive string of 1–64 ASCII letters/underscores            |
| from, to           | Valid ISO timestamp with date and T; inclusive createdAt range; from<=to |
| limit              | Integer string 1–100, default 50                                         |
| offset             | Integer string 0–1,000,000, default 0                                    |

Unknown filters, arrays, malformed IDs/timestamps and abusive page values return 400. No arbitrary sort/SQL column selector exists. Ordering is createdAt DESC,
id DESC; query takes limit+1 and returns at most limit events. nextOffset is
current offset+limit when hasMore, otherwise null. Fixed datasets are stable;
concurrent insertion/deletion can move offsets between independent requests.

New indexes cover (organizationId,createdAt,id) and
(organizationId,entityType,entityId,createdAt,id). Actor/action-only filtering can
still scan a tenant slice. This index review is not a production benchmark;
query-plan/load evidence and executed checks belong in
[Phase 8 verification](PHASE8_VERIFICATION.md). See [dashboard](DASHBOARD.md) for
other paged lists and alert rules. Phase 9 adds bounded [CSV audit exports](REPORTS.md)
for OWNER/ADMIN; production deployment and advanced analytics remain future work.
