# Operations dashboard and stock alerts — Phase 8

The organization-scoped operational read model derives from committed inventory
and purchasing records. It adds no financial valuation, external notifications,
scheduled workers, CSV or advanced reporting.

## Dashboard API and metrics

GET /api/organizations/:organizationId/dashboard is available to every authenticated
tenant member. It accepts no query parameters and returns:

```text
{dashboard:{asOf,activeProducts,activeWarehouses,lowStockProducts,
 outOfStockProducts,purchaseOrders:{DRAFT,SENT,PARTIALLY_RECEIVED,recentReceived},
 recentMovements:[...],recentReceipts:[...]}}
```

- activeProducts/activeWarehouses count records with active=true.
- lowStockProducts counts distinct active products with a configured active
  warehouse whose exact balance is positive and below its minimum.
- outOfStockProducts counts active products without any positive balance in an
  active warehouse. Missing balances qualify. This metric does not require a
  configured minimum; stock in inactive warehouses does not satisfy it.
- DRAFT, SENT and PARTIALLY_RECEIVED count all tenant orders in those states.
- recentReceived counts orders currently RECEIVED whose updatedAt is within the
  preceding thirty days. RECEIVED is terminal, so normal API behavior uses its
  completion update as that timestamp; this is not an independent receivedAt field.

Counts use PostgreSQL aggregates in one RepeatableRead transaction with the recent
queries. asOf is the application's response construction time, not a PostgreSQL
snapshot identifier or a guarantee that future requests share the same snapshot.
There is no sum across incompatible units.

Both recent arrays contain at most five rows ordered createdAt DESC, id DESC.
Recent movements expose id, type, quantity (fixed-six decimal string), createdAt,
correlationKey, product {id,sku,name,unitOfMeasure}, warehouse {id,code,name},
and actor {id,displayName}. Recent receipts expose id, purchaseOrderId,
warehouseId, createdAt, warehouse and actor with the same minimal shapes.
The UI displays summary counts, activity, critical locations and quick links to
inventory and pending purchasing work; it does not fabricate a complete feed.

## Per-location minimum and server rules

InventoryThreshold configures one (organizationId,productId,warehouseId) pair,
with composite tenant foreign keys and a unique composite key. Minimum is an
exact nonnegative numeric(20,6); a location-specific policy fits the existing
multi-warehouse domain better than one global Product minimum.

PUT /api/organizations/:organizationId/inventory/thresholds accepts only
{productId,warehouseId,minimumQuantity}. OWNER/ADMIN write; MEMBER reads.
Parents must be active and belong to the tenant. The response is {threshold},
including its UUID, tenant/product/warehouse IDs, timestamps and minimumQuantity
as a fixed-six decimal string. No stock is created by configuration.

Input uses the inventory decimal grammar: at most fourteen integral and six
fractional digits, no exponent, commas, signs or numeric JSON values. Fractional
digit count must not exceed Product.quantityScale, including trailing zeros:
UNIT scale 0 accepts "0", not "0.000000". PostgreSQL also checks nonnegativity
and product precision. Existing thresholds freeze product unit/scale through both
API validation and a SQL trigger, even when no stock history exists.

GET /api/organizations/:organizationId/inventory/alerts returns configured pairs
only and calculates status in PostgreSQL:

| Exact quantity                    | Status       |
| --------------------------------- | ------------ |
| Zero, including a missing balance | OUT_OF_STOCK |
| Positive and below minimum        | LOW          |
| Equal to or above minimum         | OK           |

A zero minimum suppresses LOW for positive balances, while zero stock remains
OUT_OF_STOCK. Inactive products/warehouses are excluded; their configuration is
retained. Unconfigured combinations do not create an implicit product/warehouse
Cartesian list. A product can be LOW at one monitored location and still have
stock elsewhere. Numeric comparisons remain on the server without Number or
rounding deciding a boundary.

The response is {alerts,hasMore,nextOffset}. Each alert contains id (threshold UUID),
productId, warehouseId, minimumQuantity and quantity (fixed-six strings), status,
product {id,sku,name,unitOfMeasure,quantityScale}, warehouse {id,code,name}.
Filters: productId, warehouseId (UUID), status (OK|LOW|OUT_OF_STOCK), limit, offset.
Unknown filters and malformed values return 400. Foreign tenant UUID filters
return an empty scoped result. Ordering is threshold id ASC.

## Pagination shared by domain lists

All pages preserve their original array field and add hasMore and nextOffset.
limit defaults to 50 and is 1–100; offset defaults to 0 and is 0–1,000,000.
nextOffset is offset+limit when an extra row exists, otherwise null. Queries fetch
at most limit+1 rows. Unknown query parameters fail with 400.

| Endpoint suffix                     | Array                            | Ordering                | Additional filters                     |
| ----------------------------------- | -------------------------------- | ----------------------- | -------------------------------------- |
| /categories, /products, /warehouses | categories, products, warehouses | name ASC, id ASC        | None                                   |
| /suppliers                          | suppliers                        | name ASC, id ASC        | None                                   |
| /memberships                        | memberships                      | createdAt ASC, id ASC   | None                                   |
| /purchase-orders                    | purchaseOrders                   | createdAt DESC, id DESC | None                                   |
| /purchase-orders/:id/receipts       | receipts                         | createdAt DESC, id DESC | Parent order in path                   |
| /inventory/balances                 | balances                         | id ASC                  | productId, warehouseId                 |
| /inventory/movements                | movements                        | createdAt DESC, id DESC | productId, warehouseId, type, from, to |
| /inventory/alerts                   | alerts                           | id ASC                  | productId, warehouseId, status         |
| /audit                              | events                           | createdAt DESC, id DESC | See [audit](AUDIT.md)                  |

Phase 10 rejects type/from/to on balances with400: current materialized state
accepts only productId/warehouseId and pagination. Invalid parent inventory filters return
404; these do not disclose another tenant's resource. ISO timestamp movement
filters are inclusive and require a valid from<=to range.

Offset is a simple local MVP choice. Timestamp/name ties resolve through UUID;
fixed datasets have deterministic pages. Concurrent inserts, edits or deletes
between requests can shift offsets. This is not a cross-request snapshot or a
durable bookmark. The UI exposes further pages and picker choices explicitly.
Phase 10 also bounds the authentication organization chooser with the same
limit/offset and hasMore/nextOffset contract, scoped to the authenticated user.

## Queries, indexes and limits

Aggregation and numeric comparisons run in PostgreSQL; bounded recent lists use
minimal selects. There is no per-row application lookup or whole-table transfer
to the browser for aggregation. Prisma may issue a fixed set of relation-loading
queries; no claim of one SQL statement per endpoint is implied.

The new threshold unique index starts with organizationId/productId/warehouseId.
Audit indexes are documented in [audit](AUDIT.md). Existing movement and order
indexes begin organizationId,createdAt,id; receipt history begins
organizationId,purchaseOrderId,createdAt,id. Product/warehouse primary and tenant
unique keys support joins. Dashboard's global recent-receipt ordering and some
name/filter sorts can still require filtering/sorting; index existence does not
prove all requests use an index or meet a latency target.

No throughput/load claim follows from this structural query review. Deep offsets,
large tenants, query-plan measurement, production tuning and privileged database
controls remain operational work. Executed checks and outstanding limits are in
[Phase 8 verification](PHASE8_VERIFICATION.md).
