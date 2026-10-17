# API module boundaries

Add modules as working vertical slices in the roadmap order: auth,
organizations/users, products/warehouses, inventory, suppliers/purchasing and audit.
Do not pre-create empty controllers, repositories or service interfaces.

An HTTP handler parses and validates input, resolves authenticated tenant context
and calls an application operation. The operation owns the transaction; persistence
must receive that transaction and organization scope. Domain rules stay independent
of Express. `database.ts` lazily owns the Prisma PostgreSQL adapter; health checks
do not establish a database connection. The server disconnects its pool on shutdown.

Phase 2 has authentication/session composition in `app.ts`, password and session
security helpers in `auth/`, and membership routes in `organizations/`.
Phase 3 adds category/product/warehouse routes and validation in `catalog/`.
Shared `tenant.ts` resolves scope and serializes writes on the organization row
and rereads the actor membership and session before checking permissions. Future
inventory and purchasing workflows must reuse their own single transaction client.

The initial schema validates only identity and organization membership. `User` is a
global identity, `Organization` is a tenant root, and `Membership` binds the two.
The unique organization/user pair prevents duplicate memberships; role has no
implicit default. Foreign keys restrict identity/organization deletion while
memberships exist. Sessions reference the organization/user membership pair and
are cascaded when that membership is removed. Application login and registration
normalize email; protected operations resolve current membership on the backend.
Business entities added later must carry organization scope and tenant-safe foreign
keys. Never expose global users through an unrestricted tenant API.

See `docs/ARCHITECTURE.md`, `docs/DOMAIN.md` and
`docs/INVENTORY_INVARIANTS.md` at the repository root for the accepted design.
