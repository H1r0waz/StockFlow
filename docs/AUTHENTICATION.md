# Authentication and tenant authorization — Phase 2

Implementation scope: opaque web sessions, organizations and memberships only.
Phase 3 adds tenant-scoped catalog routes using this same authorization context; see [catalog permissions](CATALOG.md). Phase 4 inventory reads use the same session tenant and require OWNER/ADMIN for writes; see [inventory](INVENTORY.md). Phase 6 suppliers/orders use OWNER/ADMIN writes and MEMBER reads; see [purchasing](PURCHASING.md). Phase 7 [receiving](RECEIVING.md) uses the same OWNER/ADMIN write and MEMBER read matrix. Phase 0 envisaged OPERATOR and
VIEWER; Phase 2 intentionally replaces them with the requested MEMBER role.
Receiving rechecks current permission before replaying a completed command.
Phase 8 allows every member to read dashboard/alerts; OWNER/ADMIN configure
minimum stock and read [business audit](AUDIT.md). The same tenant/session
authorization applies to these routes and their bounded pages.

## Identity and session lifecycle

Registration atomically creates a global User, Organization, OWNER Membership
and Session. Email is trimmed/lowercased and unique; names are bounded and trimmed.
Passwords have 12–128 characters at registration, are never trimmed and use
Node scrypt (N=32768, r=8, p=3, 16-byte random salt, 64-byte result, bounded memory).
The encoded string includes fixed checked algorithm parameters. Passwords and
tokens are not returned in DTOs, audits or logs. Unknown-user login performs the
same costly derivation; incorrect credentials return the same safe 401 message.
Registration conflicts remain generic 409 and can still reveal account existence
through status; this portfolio phase does not promise enumeration resistance.

Session cookies contain 32 random bytes encoded as hex. Only SHA-256(token) is
stored; a database tokenHash cannot be used as a session cookie. Absolute expiry
is seven days with no sliding extension. Successful login/registration replaces
any presented old session; logout deletes the row and clears the cookie. Role
changes and membership removal revoke sessions in that organization. Each request
rechecks expiry and membership, and responses use allowlisted user fields.
Session's composite FK to Membership(organizationId,userId) prevents a database
session from pairing a tenant with a nonmember global identity.

Cookie: stockflow_session, HttpOnly, SameSite=Lax, Path=/, no Domain, Secure in
production. Production requires HTTPS WEB_ORIGIN. Local HTTP uses non-Secure
cookies on loopback only. No JWT or browser localStorage credential exists.
An existing multi-organization user may supply organizationId at login; it must
be one of that user's memberships. Without it, the oldest membership is chosen.
The minimal UI shows the current organization and does not implement a selector.

## CSRF, origin and throttling

All non-safe HTTP methods require exact WEB_ORIGIN (default
http://127.0.0.1:5173), including login and registration. Authenticated mutations
also require X-CSRF-Token matching the per-session random token returned by the
same-origin session endpoint. Hex/length validation precedes timing-safe compare.
No CORS allowlist or wildcard is installed. Vite proxies /api to the loopback API.
SameSite is defense in depth, not the only CSRF control. Tokens should never be
placed in URLs or logs. No XSS immunity is claimed.

Authentication attempts are limited per direct client IP and hashed normalized
identity: 20 per 15 minutes by default. No trust-proxy setting accepts spoofed
forwarding headers. The in-process limiter caps buckets at 10,000 and rejects
new buckets when full; it is not distributed or durable across restart. Configure
proxy trust and shared throttling deliberately before any deployment.

Malformed JSON, unknown routes, validation conflicts and unexpected errors use
safe JSON envelopes. No stack trace, password hash or connection string is sent.
The ordinary JSON body limit is 100 KiB; bounded import routes allow a 1 MiB JSON envelope for their 256 KiB CSV cap. Responses use no-store and security headers; see [current security controls](SECURITY.md).

## Permission matrix

| Action within current organization         | OWNER                            | ADMIN                      | MEMBER |
| ------------------------------------------ | -------------------------------- | -------------------------- | ------ |
| View own session, current org, member list | Yes                              | Yes                        | Yes    |
| Edit organization name                     | Yes                              | Yes                        | No     |
| Add existing account as MEMBER             | Yes                              | Yes                        | No     |
| Add existing account as ADMIN/OWNER        | Yes                              | No                         | No     |
| Change/remove MEMBER membership            | Yes                              | Yes, MEMBER remains MEMBER | No     |
| Change/remove ADMIN or OWNER               | Yes, preserve at least one OWNER | No                         | No     |
| Promote to ADMIN/OWNER                     | Yes                              | No                         | No     |
| Logout own session                         | Yes                              | Yes                        | Yes    |

Membership creation adds an already registered account by normalized email. It
does not send invitations, create accounts/passwords for others or prove email
ownership. Only authorized managers may look up account availability through this
flow. Email delivery, verification and invitation acceptance are future work.

## Tenant boundary and concurrency

Session organization is authoritative. A path with another organization returns
404 even if the user belongs to that other organization; login to the selected
membership first. Membership target lookups include organizationId. Body field
allowlists reject an artificial organizationId or userId. Shared organization
route helpers resolve auth, tenant and permission consistently in backend.
Private DTOs never include passwordHash, tokenHash or another tenant's memberships.

Organization/membership writes lock the Organization row FOR UPDATE, reread the
actor membership and live session inside the transaction, check role and target,
and preserve the last owner before committing. This serializes concurrent owner
demotions/removals and rejects stale permissions after revocation wins the lock.
Session creation also uses the organization lock. Reads check authorization at
request resolution; no claim of serializable read-versus-revocation ordering.
Database owners remain trusted: FK/uniqueness alone cannot prevent an administrator
from changing a role or removing the last owner with direct SQL. Application
production database role separation/RLS remain unverified; Phase 8 business audit is implemented in [AUDIT.md](AUDIT.md).

## Local database and migrations

Requires existing PostgreSQL binaries on PATH; verified locally with PostgreSQL
18.6 on Windows. `npm run db:start` initializes only .cache/postgres/data, uses
fresh generated credentials in ignored .env, binds 127.0.0.1:55434, and enables
SCRAM authentication. No Windows service, cloud resource or other project is used.
`npm run db:create` creates stockflow_dev and stockflow_test. Database helpers
reject connections outside that exact instance and expected database names.

Migration 202610160001_foundation represents the original Phase 1 schema.
Migration 202610170001_auth changes roles, adds passwordHash and Session with
membership FK. These are intended for the originally empty Phase 1 foundation;
a populated installation with old roles/accounts would need an explicit data and
credential migration first. Never deploy this migration blindly to an old live DB.

```sh
npm run db:start
npm run db:create
npm run db:migrate
npm run prisma:generate
npm run test:integration
# PowerShell: $env:PLAYWRIGHT_CHANNEL = 'chrome'
npm run test:e2e:db
npm run db:stop
```

Dev/API commands and database helpers load root .env with Node's built-in loader.
Production start expects explicit environment variables; copying .env alone does
not configure production. Never print DATABASE_URL or commit the ignored file.
Integration tests delete only their guarded stockflow_test records; do not run
concurrently with E2E against that database. E2E records are fictional and isolated
from stockflow_dev. No production credentials or database are involved.

## Evidence and remaining work

Actual command outcomes are recorded in PHASE2_VERIFICATION.md. Test source
presence is not proof by itself. Production TLS/cookie behavior in a real
deployment, distributed throttling, password reset/email verification, session
cleanup scheduling, a production database role and broad load testing remain
unverified or unimplemented. Expired sessions are rejected and removed when used;
unused expired rows need a future retention job. Business audit now records the actions specified in [AUDIT.md](AUDIT.md); authentication events remain excluded.
