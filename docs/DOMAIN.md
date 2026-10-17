# Domain contract

Status: Phase 0 design. Phase 3 implements Category, Product and Warehouse in addition to Organization, User, Membership and Session. Actual normalization, units and archive rules are in [catalog](CATALOG.md). Phase 4 implements InventoryBalance, InventoryMovement and InventoryCommand for receipts/issues/adjustments. See [current inventory contract](INVENTORY.md) for exact implemented types and fields; Phase 5 adds InventoryTransfer and paired TRANSFER_OUT/TRANSFER_IN movements; see [transfer contract](TRANSFERS.md). The earlier operation/entry vocabulary below remains conceptual purchasing terminology. Positive-stock archive checks and unit/scale history locks now exist. Phase 6 implements Supplier, PurchaseOrder, PurchaseOrderLine and PurchasingCommand with DRAFT/SENT/CANCELLED; see [purchasing](PURCHASING.md). UUID identifies orders; costs/numbers remain deferred. Phase 7 implements PurchaseReceipt/Line, received counters, PARTIALLY_RECEIVED/RECEIVED and cancellation of the remaining quantity; see [receiving](RECEIVING.md). The lifecycle below now has implemented receipt transitions; Phase 8 implements InventoryThreshold and prospective AuditEvent capture plus dashboard, derived alerts and paged reads; see [dashboard](DASHBOARD.md) and [audit](AUDIT.md). Billing/returns remain future. This is the contract future phases must prove.

## Entities and keys

| Entity             | Identity and meaning                                                          | Required constraints                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Organization       | UUID tenant, name, active state                                               | Business data never moves between tenants                                                                                                 |
| User               | Global UUID login identity                                                    | Normalized email unique globally; credentials are never public DTO fields                                                                 |
| Membership         | Organization/user association and role                                        | Unique organization/user; active membership required; owner removal cannot leave no owner                                                 |
| Category           | Tenant UUID, name, active state                                               | Product references category within the same tenant                                                                                        |
| Product            | Tenant UUID, SKU, name, optional category, unit, quantity scale, active state | Unique `(organizationId, normalizedSku)` including inactive products                                                                      |
| Warehouse          | Tenant UUID, code, name, active state                                         | Unique tenant/code; archive only after balance is zero                                                                                    |
| StockBalance       | Current quantity for a product in a warehouse                                 | Unique `(organizationId, productId, warehouseId)`; quantity >= 0                                                                          |
| InventoryOperation | Tenant UUID, kind, actor, time, reason, request reference                     | Immutable durable business command; one transaction owns its entries                                                                      |
| InventoryEntry     | Tenant UUID, operation, product, warehouse, signed delta                      | Nonzero exact delta, append only, references all parents within tenant                                                                    |
| Supplier           | Tenant UUID, name, contact details, active state                              | Orders reference the same tenant; referenced suppliers are archived                                                                       |
| PurchaseOrder      | Tenant UUID, organization-scoped number, supplier, status                     | Unique tenant/number; all lines belong to its tenant                                                                                      |
| PurchaseOrderLine  | UUID under order, product, ordered and received quantities                    | ordered > 0; 0 <= received <= ordered; commercial fields freeze after sending; received counter changes only through receipt transactions |
| PurchaseReceipt    | Tenant UUID, order, destination, actor, timestamp                             | Immutable confirmed receipt with positive per-line quantities                                                                             |
| IdempotencyRecord  | Tenant, operation scope, client key, payload hash, stored response            | Unique `(organizationId, scope, key)`; response commits with effects                                                                      |
| InventoryThreshold | Tenant product/warehouse minimum exact quantity                               | Unique tenant/product/warehouse; nonnegative; respects and freezes product unit/scale                                                     |
| AuditEvent         | Tenant UUID, actor, action, entity, before/after, timestamp                   | Append only; safe allowlist; same transaction for business writes                                                                         |

Use globally unique internal UUIDs and tenant composite unique keys for referenced records. Every business FK includes organizationId; references to a global User use the user identity plus explicit membership checks. Prefer restrictive foreign-key deletion over cascades for durable records. IDs, order numbers, SKU, and warehouse codes are separate concepts.

SKU input is trimmed, normalized to ASCII uppercase, and restricted to `[A-Z0-9._-]` (1-64 characters). Names are nonempty trimmed text (up to 200 characters). SKU identity is tenant-scoped and never reused for a different product after archive. Changing a SKU retains the same product ID and is audited. No automatic alias or case-insensitive database collation assumptions.

## Quantities and units

Persist quantities and deltas as PostgreSQL `numeric(20,6)` (14 integral and six fractional digits). Transport them as decimal strings, never JavaScript numbers; arithmetic uses exact decimal operations. Reject exponent notation, NaN, infinity, excess precision, overflow, or locale commas. Normalize equivalent values to six decimal places for hashing and storage. Validate precision **before** casting to numeric; PostgreSQL scale rounding is not an acceptable validation strategy.

A product has one base unit label and an allowed quantity scale from 0 to 6. For example, pieces use scale 0 and kilograms can use scale 3. A valid quantity is an exact multiple of `10^-scale`, while the storage remains six-place decimal. All order, receipt, transfer, and balance quantities use that base unit. Do not change unit or scale after the product has any stock/order history or a configured InventoryThreshold; conversions, lots, serial numbers, bundles, reservations, inventory valuation, taxes, and multi-currency accounting are outside the MVP. Prices need a separate monetary contract when purchasing is implemented; quantity precision must not be silently reused as a money policy.

## Inventory vocabulary

A product is a catalog identity; a warehouse is a physical/logical location. A balance is a current product/location quantity. A movement is an immutable signed ledger entry explained by an operation. Creating a product or warehouse creates no stock; opening inventory requires an audited RECEIPT or ADJUSTMENT.

| Entry kind   | Signed delta                     | Reason                                                        |
| ------------ | -------------------------------- | ------------------------------------------------------------- |
| RECEIPT      | Positive                         | Direct intake or a purchase receipt with its source reference |
| ISSUE        | Negative                         | Consumption or removal                                        |
| ADJUSTMENT   | Positive or negative, never zero | Explicit signed correction with mandatory reason              |
| TRANSFER_OUT | Negative                         | Source half of one transfer                                   |
| TRANSFER_IN  | Positive                         | Destination half of the same transfer                         |

Adjustment APIs accept a delta, not a blind replacement quantity. A future stock-count screen must lock and compare a version before deriving a delta from a counted total. History is never edited to correct a mistake: post a separately authorized compensating operation that preserves nonnegative stock. A receipt correction is not an unmodeled edit of ordered/received counters; supplier returns and receipt reversal require their own future design.

Inactive products/warehouses reject new movements; require zero stock before archive and reject archiving an entity used by an open order. Lock active-state parent rows in a stable order when writing and have archival operations acquire conflicting locks. No hard delete of ledger-related entities.

## Purchasing lifecycle

| From               | To                            | Conditions/effects                                                                    |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------- |
| DRAFT              | SENT                          | Active same-tenant supplier/products; at least one valid positive line; freezes lines |
| DRAFT              | CANCELLED                     | Reason recorded, no stock effects                                                     |
| SENT               | PARTIALLY_RECEIVED            | A receipt commits and some quantity remains pending                                   |
| SENT               | RECEIVED                      | A receipt commits and every line is fully received                                    |
| SENT               | CANCELLED                     | No receipt yet; record reason                                                         |
| PARTIALLY_RECEIVED | PARTIALLY_RECEIVED / RECEIVED | New receipt within remaining quantities                                               |
| PARTIALLY_RECEIVED | CANCELLED                     | Explicit cancellation of the remainder; keep receipts and stock intact                |

RECEIVED and CANCELLED are terminal; no reopen, editing sent lines, receiving after cancellation, or deleting confirmed receipts. Cancellation after a partial receipt does **not** reverse existing stock. The cancelled order reports historical received quantities and a separately derived cancelled remainder; it has no quantity still receivable. A return is a future explicit stock operation, not cancellation. Header state is derived from locked line counters after each receipt, except explicit cancellation. Two concurrent receipt/cancel operations must serialize on the same order header.

A receipt targets one destination warehouse and one order. It contains each selected line once, each quantity > 0 and <= its locked pending amount; reject duplicate line IDs and lines from another order/tenant. Confirm receipt, counters, stock, ledger, audit, and idempotency result in one transaction. An all-invalid or zero receipt is rejected; there is no partially committed receipt request.

## Roles and read models

Phase 2 replaces the earlier OPERATOR/VIEWER outline with OWNER, ADMIN and MEMBER. OWNER manages ownership and membership roles; ADMIN edits the organization and manages MEMBER memberships only; MEMBER can view the current organization and its members. The implemented [permission matrix](AUTHENTICATION.md) defines the current API. Phase 3 extends it with OWNER/ADMIN catalog writes and MEMBER catalog reads. Phases 4–5 extend OWNER/ADMIN writes and MEMBER reads to inventory and transfers. Phase 6 purchasing uses the same OWNER/ADMIN write and MEMBER read matrix. Every permission is checked server-side. Export/download is a permission, not a bypass.

Phase 8 uses exact nonnegative minima per product/warehouse. Configured active pairs with zero or missing balance are OUT_OF_STOCK; positive balances below minimum are LOW; all other positive balances are OK. Inactive parents are excluded. No implicit alerts exist for unconfigured pairs. Dashboard low-stock counts distinct products with a configured LOW location; out-of-stock counts active products with no positive stock in any active warehouse, independently of thresholds. It never adds kilograms to pieces or invents financial value. The consistent dashboard read returns asOf as application response time, not a reusable database snapshot token. Every tenant member reads dashboard/alerts; only OWNER/ADMIN read full business audit. Notification delivery is outside the phase. See [operational contracts](DASHBOARD.md) and [audit events](AUDIT.md).

Phase 9 CSV starts with product/supplier master data, not arbitrary ledger replacement. Preview has no effects; confirmation revalidates current tenant state and uniqueness under the organization lock. Each bounded file is all-or-nothing: at most 256 KiB, 2,000 data rows and eight columns. Products match tenant SKU; suppliers are create-only and duplicate nonempty tax IDs fail. An immutable ImportJob records successful counts, with the same ID correlating audit and idempotent confirmation replay. A future inventory CSV must invoke stock use cases and cannot directly set balances. [Imports](IMPORTS.md) and [reports](REPORTS.md) define the formats, permitted projections and safe spreadsheet exports. No financial valuation is inferred.
