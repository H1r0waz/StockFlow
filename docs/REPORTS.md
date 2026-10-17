# Operational reports and exports — Phase 9

Reports use current tenant-scoped records and exact decimal strings. They do not
estimate cost, value, revenue or financial KPIs. Product quantities retain their
unit and are never summed across incompatible units.

## API and permissions

`GET /api/organizations/:organizationId/reports/:type` returns
`{columns,rows,hasMore,nextOffset}`. Columns are ordered human-readable labels;
each row maps those labels to a string or null. Dates are UTC ISO timestamps.
Reports default to 50 rows, maximum 100; offset defaults to zero and is capped
at 1,000,000. Unknown, repeated, malformed or unsupported filters return 400.

`GET /api/organizations/:organizationId/exports/:type` applies the same scope,
permissions and filters. It returns a CSV attachment with a fixed resource-based
filename. Default limit is 1,000, maximum 2,000; offset has the same cap.
`X-Has-More` and `X-Next-Offset` explicitly identify another bounded page.
An empty next-offset header means no further page. The server reads limit + 1
rows, never a whole table, and does not run a per-row query.

OWNER, ADMIN and MEMBER can read reports and exports except `audit`, which
requires OWNER or ADMIN. The active session organization must match the route.
Every SQL root and tenant-owned relation is scoped to that organization.
UUID filters belonging to another tenant produce no matching rows.

| Type            | Supported filters beyond limit/offset           | Exported columns                                                                                    |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| products        | active, categoryId                              | ID, SKU, Product, Category, Unit, Precision, Active                                                 |
| suppliers       | active                                          | ID, Supplier, Active                                                                                |
| inventory       | productId, warehouseId                          | SKU, Product, Warehouse code, Warehouse, Quantity, Unit                                             |
| movements       | productId, warehouseId, type, from, to          | ID, Date, SKU, Product, Warehouse, Type, Quantity, Unit, Previous balance, Resulting balance, Actor |
| purchase-orders | status, supplierId, from, to                    | ID, Date, Supplier, Status                                                                          |
| receipts        | warehouseId, purchaseOrderId, from, to          | ID, Date, Purchase order, Warehouse, Actor                                                          |
| audit           | actorId, entityId, entityType, action, from, to | ID, Date, Actor, Action, Entity type, Entity ID                                                     |
| alerts          | productId, warehouseId, status                  | SKU, Product, Warehouse, Quantity, Minimum, Unit, Status                                            |

`active` accepts `true` or `false`. ID filters require UUIDs. `from` and `to`
are inclusive ISO timestamps and an inverted range is rejected. Movement type,
purchase-order status and alert status use their existing enum values. Audit
action/entity type use 1–64 ASCII letters/underscores.

Inventory shows persisted balances, including inactive products and warehouses,
because those balances remain operational history. It does not fabricate every
possible product/warehouse pair with zero stock. Alerts use configured minimum
pairs with active products and warehouses; a missing balance is zero. Zero is
OUT_OF_STOCK, positive below minimum is LOW, otherwise OK. Purchase-order and
receipt reports show document headers, not misleading mixed-unit totals.

## Safety and consistency

CSV is UTF-8 with BOM, comma-separated, CRLF record endings and every cell
quoted; embedded quotes are doubled. Fields beginning with a formula marker
`=`, `+`, `-`, or `@`, including whitespace-prefixed markers, and leading control
characters receive an apostrophe prefix. This deliberately changes dangerous
spreadsheet-facing text. CSV escaping also preserves embedded commas/newlines.
CSV is not an executable format and nothing in an uploaded/exported cell runs.

Exports omit password/session material, raw audit metadata/state, idempotency
and correlation keys, free-form notes, supplier email, phone, tax ID and legal
name. Supplier exports consequently are a safe directory, not a full backup or
an identity-preserving supplier import template. Use the import template and
explicit supplier identity policy documented in [IMPORTS.md](IMPORTS.md).

Sorting includes a unique ID tie-breaker: SKU/ID for products, name/ID for
suppliers, product SKU/warehouse code/ID for inventory and alerts, newest
createdAt/ID for documents, movements and audit. A single response is one
database query. Offset pages are not a frozen cross-request snapshot; concurrent
inserts/edits can shift page boundaries. Each export page is downloaded
explicitly, with continuation visible to the user. No hidden frontend full-table
fetch loop or long-lived database snapshot is created.

Actual local test and performance evidence is recorded in
[PHASE9_VERIFICATION.md](PHASE9_VERIFICATION.md). Large production datasets,
spreadsheet application behavior across all vendors and cross-request snapshot
exports are not verified by this implementation.
