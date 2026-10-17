# Catalog master data — Phase 3

Scope: category/product/warehouse rules introduced in Phase 3. Phase 4 now adds
[stock and ledger](INVENTORY.md); Phase 5 adds [transfers](TRANSFERS.md) and Phase 6 adds [suppliers/orders](PURCHASING.md).

## Identity and storage

All three entities use internal UUIDs, a required organizationId, createdAt,
updatedAt and an active flag. Composite unique keys (organizationId,id) prepare
tenant-safe references for later inventory tables. Natural keys remain reserved
even after deactivation. The same natural key is valid in a different tenant.

| Entity    | Business fields                                                                  | Organization-scoped uniqueness |
| --------- | -------------------------------------------------------------------------------- | ------------------------------ |
| Category  | name, normalizedName, optional description, active                               | normalizedName                 |
| Product   | sku, name, optional description/categoryId, unitOfMeasure, quantityScale, active | sku                            |
| Warehouse | code, name, optional description, active                                         | code                           |

Names are trimmed, whitespace-collapsed and Unicode NFKC-normalized, then checked
for 1–200 characters. Category's internal normalizedName is lowercased from the
normalized name. It avoids case/spacing variants without a public slug; a slug
adds no value to these authenticated UUID routes. Descriptions are optional/null,
bounded to 2,000 characters; empty descriptions become null.

Category key generation belongs to the backend; database uniqueness protects the
stored key. An administrator writing arbitrary normalizedName values directly
could bypass the intended Unicode equivalence policy. The local privileged role
is not a claim of hardened production database permissions.

## SKU and warehouse codes

SKU is an internal product business identifier separate from the UUID. Input is
trimmed and normalized to ASCII uppercase; stored values match
`[A-Z0-9._-]{1,64}`. Warehouse code follows the same policy with 1–32 characters.
Neither is globally unique: `(organizationId,sku)` and `(organizationId,code)` are
unique in PostgreSQL. Case variants collide within the tenant. Editing an
identifier keeps the internal UUID. Inactive records retain their identifier;
creating a replacement with the same key returns a safe 409 conflict.

## Units and precision

Supported units: UNIT, KG, G, L, ML, M and CM. No conversions are implemented.
quantityScale is an integer from 0 to 6, defaulting to 0 for UNIT and 3 for other
units in the application. It declares permitted precision for future exact
`numeric(20,6)` inventory quantities; it is not a stock quantity. An explicit
scale in the supported range can override the default. A unit change without
an explicit scale selects the new unit's default.

Unit and scale can change only before any inventory movement or purchase-order
line exists. Phases 4 and 6 reject those changes once referenced history exists.
Product deactivation also rejects references from DRAFT/SENT/PARTIALLY_RECEIVED orders; cancelled
order history remains and still freezes unit/scale. No historical conversion is
promised. minimumStock is deferred to inventory thresholds per product/warehouse;
there is no misleading global quantity field on Product.

## Category assignment and lifecycle

Product.categoryId is optional/null. Its composite foreign key
`(organizationId,categoryId) -> Category(organizationId,id)` prevents a category
from another organization even when HTTP validation is bypassed. An unknown or
cross-tenant category is not a valid assignment. New assignments require an
active category. Retaining the same inactive category on an existing product is
allowed while editing unrelated metadata; it can also be cleared or replaced by
an active same-tenant category.

Deactivating a category does not deactivate or detach existing products. Existing
references remain readable. All lists include active and inactive records so
archived master data does not disappear. Activation/deactivation is a PATCH of
the boolean active field; no hard-delete HTTP endpoint exists for any entity.
The database uses restrictive relations for catalog references. Phase 4 rejects product/warehouse deactivation when any balance is positive;
zero-stock archive retains history. Open-order checks remain future purchasing work.

## HTTP and authorization

All routes are under `/api/organizations/:organizationId`. The path must match
the organization bound to the live session. No body field may choose a tenant.

| Collection  | Operations                                  |
| ----------- | ------------------------------------------- |
| /categories | GET list; POST create; GET /:id; PATCH /:id |
| /products   | GET list; POST create; GET /:id; PATCH /:id |
| /warehouses | GET list; POST create; GET /:id; PATCH /:id |

List responses use plural envelopes; item/create/update responses use singular
envelopes. Creation returns 201. Validation uses 400, inaccessible IDs use 404,
permission failures use 403 and duplicate keys use 409. Errors follow the safe
existing JSON envelope; they do not return SQL or internal stack traces.

OWNER and ADMIN create/update/activate/deactivate; MEMBER reads only. The shared
tenant context is used by organization and catalog modules. Writes retain the
organization-row lock and in-transaction session/actor recheck, so membership
revocation and catalog authorization use the same discipline. Category archive
and product assignment also serialize through that organization lock. This is
deliberately coarse for the initial catalog; measure contention before replacing
it, and preserve the shared lock order when inventory is added.

Input field allowlists prevent mass assignment; IDs, text lengths, enums, boolean
flags and integer scale are validated server-side. Database checks additionally
reject invalid stored SKU/code syntax, out-of-range scale and empty trimmed names.
Origin and session-CSRF checks still protect mutations. React renders server text
as text, without injecting HTML. No CORS bypass or client role check authorizes a
write. See [authentication](AUTHENTICATION.md) for unchanged session behavior.

## UI and limits

Authenticated navigation exposes Members, Categories, Products and Warehouses.
Catalog views provide list, create/edit, activation state, loading, empty/error
states and reload persistence. MEMBER has read-only views; API authorization
remains authoritative. Product forms choose a same-tenant category and unit/scale.

Later phases add [inventory](INVENTORY.md), [dashboard/pagination](DASHBOARD.md),
[business audit](AUDIT.md), and [Phase 9 product CSV imports](IMPORTS.md) with
[safe exports/reports](REPORTS.md). These imports reuse catalog normalization
and preserve unit/scale history guards. Production-scale performance and database
privilege hardening remain unverified. Phase 3 evidence is historical; current
import verification is recorded in [Phase 9 evidence](PHASE9_VERIFICATION.md).
