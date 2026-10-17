# Security model and review boundaries

Date: 2026-10-17. This document describes the implemented local application
controls and the remaining deployment boundaries. Executed results, dependency
audit provenance and the final source revision belong in
[Phase 10 verification](PHASE10_VERIFICATION.md). Historical phase reports are
dated evidence, not a claim that their old limitations still describe the code.

## Assets, actors and trust boundaries

Assets include tenant catalog and supplier information, account/session material,
membership authority, exact inventory balances and immutable histories, purchasing
state, replay results and import identities. Anonymous callers, a MEMBER,
an ADMIN/OWNER and a member of another organization have different authority.
An authorized administrator can intentionally change business data within the
documented operations; that permission is not a guarantee of business intent.

The browser sends untrusted paths, bodies, headers, query values and CSV text.
The API authenticates and derives its tenant from the stored session, authorizes
the operation, validates fields and uses parameterized Prisma/SQL. PostgreSQL
transactions, composite foreign keys, uniqueness, CHECKs and triggers form a
second integrity boundary. Database administrators, migration tools and the
machine operating the API remain trusted; no RLS, production runtime SQL role,
external immutable log or protection from a compromised host is claimed.

## Implemented controls

| Surface              | Control and source                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Passwords            | Node scrypt with random 16-byte salts, N=32768/r=8/p=3, 64-byte derived keys and timing-safe comparison. Unknown accounts perform the same derivation. Password inputs are bounded; hashes are excluded from public DTOs. See `apps/api/src/modules/auth/passwords.ts`.                                                                                                                                                                                |
| Sessions             | Random 32-byte opaque cookie values; only SHA-256 token hashes are stored. Seven-day expiry, HttpOnly, SameSite=Lax, Path=/ and mandatory Secure in production. Login/registration rotates the presented session. Logout, membership removal and role changes invalidate affected sessions. See `app.ts`, `modules/auth/security.ts` and the session composite membership FK.                                                                          |
| CSRF/origin          | Every unsafe HTTP method requires an exact configured Origin. Authenticated mutations additionally require a timing-safe checked X-CSRF-Token. WEB_ORIGIN must be a canonical HTTP(S) origin without credentials, wildcard, path, query or fragment; production requires HTTPS. No permissive CORS is enabled. Proxy trust defaults off; deployment can explicitly select one trusted hop after topology verification.                                 |
| Tenant isolation     | Tenant path must equal the authenticated session organization. Resource queries and SQL joins constrain organization IDs. Composite tenant FKs reject mixed-tenant relationships. Global user identity does not grant organization access. Reads resolve live membership per request; writes recheck live session and role under transaction locks.                                                                                                    |
| Roles                | MEMBER reads ordinary operational data; OWNER/ADMIN perform business mutations and read audit/import results. Membership administration is narrower: ADMIN manages only MEMBERs; OWNER manages privileged roles. Last-owner checks serialize on the organization row. UI visibility supplements, and never replaces, API authorization.                                                                                                                |
| Input/SQL            | Explicit body field allowlists reject mass assignment. UUID, enum, text, decimal, filter and pagination validation constrain inputs. Raw SQL uses bound values and static fragments; there is no arbitrary query/sort execution. Errors expose stable safe envelopes rather than SQL, stack traces or connection strings.                                                                                                                              |
| HTTP responses       | API responses have no-store, nosniff, DENY framing, no-referrer and restrictive CSP. HSTS is emitted only in production when request.secure is true. Forwarded protocol is considered only with explicit proxy trust. The optional compiled frontend has a separate self-only CSP; public ingress behavior still needs verification.                                                                                                                   |
| Request bounds       | Ordinary JSON bodies are capped at 100 KiB; import transport at 1 MiB, with the stricter CSV limits below. Development binds loopback; production binds 0.0.0.0. The server sets request/header/keepalive timeouts to 30/10/5 seconds and at most 100 requests per socket. Request receipt timeout does not by itself cancel an application query.                                                                                                     |
| Abuse limits         | Authentication defaults to 20 attempts per 15 minutes by direct peer IP and hashed email identity. Separate authenticated user/organization buckets allow 120 mutations, 60 import requests and 120 dashboard/audit/report/export reads per minute. Buckets expire and each limiter refuses new buckets beyond 10,000 entries. Excess returns 429 with Retry-After. See `http-security.ts`.                                                            |
| Inventory/purchasing | Positive exact decimal strings and bigint millionths avoid floating point arithmetic. Conditional debits prevent negative stock; credits reject overflow. Transfers acquire balance keys in UUID order. Receipts lock the order and validate pending quantities before committing counters, stock, history and replay results together. Deferred triggers enforce complete committed chains/pairs/receipts. See [invariants](INVENTORY_INVARIANTS.md). |
| Replay               | Inventory and purchasing keys bind tenant, command type, normalized payload and actor. Authorization precedes returning a prior result. Changed payload/actor conflicts; incomplete work rolls back. Successful results remain durable instead of expiring silently.                                                                                                                                                                                   |
| CSV import           | UTF-8 text is limited to 256 KiB, 2,000 data rows and eight columns. File names/MIME/paths do not cause server file reads. A 30-minute HMAC preview binds tenant, actor, type, exact CSV hash and current-state fingerprint. Confirmation re-plans under the shared writer lock and commits the batch, job and audit atomically. See [imports](IMPORTS.md).                                                                                            |
| Export               | Eight static projections have bounded pages and tenant filters. Audit requires OWNER/ADMIN; supplier exports omit contacts and tax identifiers. CSV quotes every cell and prefixes formula/control starts with an apostrophe. Downloads never execute user-selected SQL or access a server path. See [reports](REPORTS.md).                                                                                                                            |
| Business audit       | Safe field allowlists exclude credentials, session material, contacts, tax values, free-form notes and uploaded files. Correlation links business events to ledger/documents. Triggers reject UPDATE/DELETE. No actor context intentionally means no event; authentication failures and independent administrative SQL are outside this audit. See [audit](AUDIT.md).                                                                                  |

Mutation reauthorization may be reached twice by an import confirmation, so its
preliminary and transactional checks can each consume an import quota. Limits
are conservative abuse controls, not a promise of an exact number of successful
business operations. Session/auth checks still require database work before an
authenticated operational quota is evaluated.
Logout is exempt from operational quotas so an authenticated user can still
revoke a session after exhausting a write budget; Origin and CSRF remain enforced.
Browser requests have a thirty-second abort signal. After an uncertain write,
the interface tells the user to reconcile history before repeating the intent.
An HTTP/client timeout is not evidence that the database operation rolled back.

## Privacy, retention and trusted administration

Do not put passwords, tokens or other secrets in free-form business fields or
idempotency keys. Public DTOs intentionally contain some account names/emails
and supplier details for authorized tenant workflows; safe export/audit
projections do not make the whole database anonymous. Correlation keys and actor
IDs are internal identifiers, not credentials.

The application does not log request bodies or database queries. The server logs
startup/shutdown errors; access logs, proxy logs and monitoring need an explicit
redaction policy before deployment. Project .env, generated clients, runtime
databases and test artifacts are ignored by Git. That exclusion is not encryption
or a substitute for host access controls.

Unused expired sessions currently need scheduled retention. Committed replay
keys/results, ledger, receipts, imports and audit are retained. Deleting replay
records without a key-age/tombstone contract could execute an old intention
twice. A retention/erasure policy, backup encryption, restore rehearsal and audit
archival require an explicit production design. No automatic repair or historical
backfill is performed.

SQL owners can disable triggers, TRUNCATE, change actor context or alter schema.
Direct numeric casts may round before CHECK/trigger evaluation; strict HTTP
lexical validation is part of the supported write boundary. Constraint triggers
provide transactional integrity, not administrator-proof or cryptographic audit.

## Review performed and limits

The Phase 10 source review examined authentication/session issuance and renewal
boundaries, membership/last-owner operations, all catalog, inventory, transfer,
purchasing, receipt, operations, import and report handlers; decimal/parser
helpers; Prisma tenant relations; and the migration guards enforcing inventory,
receipt, command, import and audit integrity. It cross-checked the historical
Phase 2–9 verification reports against the current code and looked for unsafe raw
SQL, arbitrary execution, raw HTML rendering and browser token persistence.

This was a manual offline source review. The Codex Security skill's formal
desktop workflow requires an authoritative workbench scan and its capability
setup/artifact lifecycle, which was not run within this task's permitted local
workflow. There is no sealed scanner result, penetration test, external service
scan or claim of absolute security. Dependency audit results and all tests are
reported separately with their actual execution evidence.

Remaining deployment work and limitations:

- Rate limits are process-local and reset at restart; they do not coordinate
  multiple replicas or defend against a distributed denial of service. Proxy IP
  trust must be designed for a known deployment topology before enabling it.
- Real HTTPS, public frontend headers/CSP, reverse-proxy TLS/HSTS, request limits,
  PostgreSQL TLS/network controls, least privilege and secret distribution have
  not been established by local configuration. The opt-in production server and headers are implemented and tested locally;
  that does not establish an accepted public launch.
- Password reset, email verification, invitation acceptance, MFA, idle timeout
  and device/session management are not implemented. Adding an existing account
  by email is the documented membership model.
- Read-versus-revocation ordering is checked at request authorization rather than
  serialized with all subsequent reads. A request already authorized may finish
  while its membership is being revoked; new writes reauthorize under locks.
- Organization serialization favors consistency over write throughput. UUID
  lock ordering reduces contention cycles but does not prove all deadlocks
  impossible. Production workload capacity and all future adapter mappings need
  measured validation.
- Import signing material is process-local; restart invalidates pending previews.
  Query a known durable job after uncertainty before creating a new intention.
  Browser replay keys are kept in component memory and disappear on reload;
  reconcile history before re-entering an uncertain stock/purchasing command.
- Offset pages can shift between requests during concurrent writes. Browser
  spreadsheet compatibility is not universal; formula neutralization deliberately
  changes dangerous cell text. Exports are bounded projections, not backups.
- Business audit excludes login/logout, rejected requests, initial registration
  and SQL without actor context. External security telemetry, alert delivery and
  privileged-tampering detection remain unimplemented.

For a suspected issue, retain only minimal sanitized reproduction steps, tenant
and role requirements, affected source revision, observed effects and a focused
regression test. Do not include live cookies, CSV contacts, connection strings
or full database rows in an issue or report.

## Phase 12 deployment preparation

Production request logs use server-generated UUIDs, route patterns, status, duration
and safe failure categories. No request body, query values, cookie or raw database
error is logged. This does not establish provider log retention or monitoring.

PUBLIC_DEMO=true disables registration on the public server; VITE_PUBLIC_DEMO=true
builds a fictional shared-account login. The administrator-only seed requires a
pinned TLS cloud target, project confirmation and a database marker; original
local seed/reset guards remain intact. No public reset endpoint exists.

The explicit runtime grants are verified locally with a non-owner temporary role,
including ordinary writes and absent DDL/history-edit privileges. Cloud role installation and forbidden SQL checks, public HTTPS/Secure cookies/CSRF/Origin/CORS and actual cross-tenant IDs passed. Forged forwarded protocol was rejected at ingress; full IP-throttling spoofing/topology coverage, provider PITR and distributed security remain NO VERIFICADO. See [Phase 12 evidence](PHASE12_VERIFICATION.md),
[deployment](DEPLOYMENT.md) and [recovery](PRODUCTION_RUNBOOK.md).
