# Phase 10 verification — local pre-release hardening

Date: 2026-10-17, America/Buenos_Aires. Baseline:
05ddd0c2d232a496074562e52e2b994b52766f50. Phase 11 is not started.

## Scope and reviewed boundaries

[SECURITY.md](SECURITY.md) records the threat model, concrete controls, privacy
and deployment limits. The review covered current authentication, sessions,
organizations/memberships/roles, catalog, stock/ledger/transfers, purchasing and
receipts, operations, imports, reports, errors and database guards. Phase 2–9
reports were cross-checked as historical evidence. Current code, schema and
migrations retain technical authority.

This is a source-backed manual offline review plus automated local regressions,
not a penetration test, compliance claim or absolute security guarantee. The
formal Codex Security desktop workbench scan, capability configuration and sealed
artifact lifecycle were not started. No external connector, new scanner setup
or global configuration was authorized or used. The dependency audit below is a
separate npm registry advisory check.

## Changes and explicit limits

- API success/error responses have restrictive CSP, no-referrer, DENY framing,
  nosniff and no-store. CSP denies all default resource loads, frames and base
  URLs. These headers protect API responses; they are not a deployed frontend
  static-host policy or a working public TLS configuration.
- WEB_ORIGIN must be one exact canonical HTTP(S) origin, without credentials,
  paths, wildcard, query or fragment; production requires HTTPS. Production cannot
  opt out of Secure session cookies. Existing HttpOnly/SameSite=Lax/rotation,
  hashed tokens, CSRF, exact Origin and live membership checks remain in force.
  No permissive CORS was added; proxy trust is explicitly disabled. HSTS is emitted
  only for an actual secure request in production, never just X-Forwarded-Proto.
- Authentication remains 20 attempts/IP+hashed identity/15 minutes. Independent
  in-memory authenticated user/organization budgets default to 120 mutations,
  60 import checks and 120 costly dashboard/audit/report/export reads per minute.
  Invalid numeric configuration fails startup; each limiter bounds its map to
  10,000 buckets. Requests receive safe 429/Retry-After. Logout is exempt from
  operational quotas, preserving revocation while retaining Origin/CSRF checks.
  Imports can consume preliminary and transactional checks; quotas count checks,
  not exactly successful business commands. They are per-process, not distributed
  DoS protection. E2E and development create separate limiter instances.
- The normal loopback HTTP server explicitly sets request/header/keepalive receipt
  timeouts of 30/10/5 seconds and max100 requests/socket. The browser aborts fetches
  at30 seconds and presents retry/reconciliation guidance. These do not prove
  cancellation of an already-running database command. No public server or TLS
  listener was configured.
- The authenticated organization chooser now uses bounded stable pagination.
  Inventory balances reject movement-only type/from/to filters with400 instead
  of silently ignoring them. Existing UUID/decimal/CSV/body/field limits remain.
- UI recovery explains 403/404/429, expired/restoration errors and uncertain
  results. Mounted stock/import intent keys remain available for safe retry;
  reload/navigation can lose them, so visible guidance requires history/job
  reconciliation before starting another intention. No credential/browser
  storage architecture was added.
- Added a keyboard skip link, focusable main and scrollable table regions,
  responsive minimum-width/wrapping fixes and meaningful recovery tests.
  React text rendering, native labels and scoped requests remain in place.
- API test discovery now excludes ignored compiled dist tests, and production
  compilation excludes source test files. This fixes double counting/execution
  of the CSV source test and its stale compiled copy after build. Early workspace
  output showed44 API tests; the corrected runner executes35 distinct API tests.
- Updated stale current technical documentation about audit, CSV and implemented
  invariants; historical PHASE2–9 reports and all nine migrations are unchanged.
  No schema change, dependency version update or production migration was needed.

## Executed checks

| Check                                  | Evidence                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh migrations/drift                 | Nine migrations on an empty temporary database; no Prisma schema difference; temporary removed                                        |
| Existing integration regression        | 303/303 real PostgreSQL tests, eight files,301.04s                                                                                    |
| Focused new PostgreSQL hardening/roles | 15/15, two files,14.15s                                                                                                               |
| npm test after discovery correction    | 35 distinct API pure/smoke tests and32 frontend tests;318 DB cases explicitly skipped without TEST_DATABASE_URL, executed separately  |
| Dependency audit                       | npm audit JSON: zero known advisories (0 critical/high/moderate/low/info),527 dependency nodes,227 prod and300 dev; no forced updates |
| Prisma validate/generate               | Passed, Prisma7.10.1                                                                                                                  |

**Final combined PostgreSQL regression passed318/318, ten files,265.28s**.
The role matrix was then expanded to check another authorized actor replaying an
import preview and transfer key; its focused rerun passed3/3 in5.78s. No production
code changed after the full integration pass. Final lint, formatting, typecheck,
builds, Prisma validation/generation and144 local Markdown targets passed.
The last matrix-test extension initially inferred a UUID template type for its
helper key; typecheck exposed that test-only mismatch. An explicit string key
annotation corrected it and the final workspace typecheck passed.

The complete installed-Chrome suite passed **18/18 in1.6 minutes**, retaining
the seventeen previous journeys and adding the long business flow below.

The new long browser journey performs every business mutation through the UI:
registration, category/product/two warehouses, initial receipt10, transfer3,
supplier, purchase order5, send, partial receipt2 and final receipt3. It checks
current stock12 at Central and3 at Branch, configures minimum13 to observe LOW,
imports another product, filters receipt audit, downloads the inventory report,
checks dashboard metrics, logs out/in and reloads persisted stock. API calls only
read IDs for selecting existing records; they do not substitute for these UI writes.

Viewport assertions at320/768/1440 pixels check document width on registration,
navigation, forms, inventory, purchasing, alerts, imports and dashboard. Tables
scroll inside focusable regions instead of forcing document overflow. Keyboard
Tab/Enter exercises the skip link and main focus. The principal inspected actual
inventory320, imports320, purchasing768 and dashboard1440 screenshots; controls
and content fit their intended containers with local table scrolling. Primary,
secondary, button and muted text/background CSS pairs measured13.22:1,5.79:1,
12.12:1 and5.33:1 respectively. These sampled pairs are not an exhaustive contrast
audit of every placeholder/state. There was no screen-reader/device/browser
matrix or WCAG certification.

The existing concurrency cases re-exercise competing debits, first-use balance
creation, replay, inverse transfers, purchasing send/edit/cancel, concurrent
receipts/cancellation and import confirmations, and simultaneous last-owner
demotions. They use real PostgreSQL, separate requests/connections and explicit
barriers where their contract requires them. This is evidence for exercised
races, not a proof that all future lock cycles or transient adapter errors are
impossible. Existing exact decimal/ledger/receipt reconciliation guards remain.

The cross-module matrix runs OWNER, ADMIN and MEMBER against actual catalog,
warehouse, supplier, stock receipt/issue/adjustment/transfer, orders, receiving,
thresholds, imports, dashboard and report/export/audit endpoints. ADMIN cannot
grant OWNER; MEMBER reads but cannot mutate or access full audit. Tests also
cover production cookie flags/logout revocation, exact Origin/CSRF, quotas and
reset/independence, bounded own-organization pages and unsupported balance filters.
Safe500 responses to connection and statement-timeout exceptions are injected at
the HTTP boundary; this proves error redaction, not an actual network outage or
database cancellation drill. Domain errors use existing400/401/403/404/409/429
contracts;422 is not an implemented domain response requiring a new API behavior.

Password/token/cookie/request bodies are not logged by the business handlers.
Secret material and dedicated database runtime files remain ignored, and Git
tracks only the secret-free .env.example. No unrelated credential source was read.
Accounts/member DTOs and supplier records can hold basic personal data; export
and audit use narrower projections. Sessions expire at seven days, but unused
expired rows still need a future retention job. Replay/history retention, erasure,
backup policy and administrator SQL privileges need a production design.

## Local performance observation

A guarded ignored script used only stockflow_test with a fictional organization,
2,000 imported products, one warehouse and30 real receipt commands. Later final
integration cleanup removes these fixtures. Times include in-process HTTP and
real PostgreSQL, not network/browser or production throughput. Reads have five
sequential samples; the table reports medians. No speculative indexes or cache
layers were added.

| Operation                  | Observed ms       |
| -------------------------- | ----------------- |
| Dashboard                  | 43.94 median      |
| Catalog first bounded page | 12.32 median      |
| Movement history           | 15.96 median      |
| Audit first bounded page   | 12.70 median      |
| Inventory report           | 17.73 median      |
| Preview2,000 rows          | 166.19 single run |
| Confirm2,000 rows          | 968.80 single run |

Process RSS before/after fixture was133.72/249.89MiB, not a peak-memory/leak test.
Small-query variation and startup/GC effects prevent comparison as a controlled
benchmark. Maximum UPDATE-heavy imports, sustained contention, large deep-offset
tenants and production resource capacity are NO VERIFICADO. The pg8 adapter still
warns about overlapping client.query; no source-level Promise.all transaction
cause was found. Pinned-version regressions pass; pg9 compatibility is unverified.

## Coordination and remaining boundaries

Three subagents reviewed security/DB and wrote SECURITY.md, implemented HTTP
hardening/tests, and implemented frontend recovery/accessibility/business E2E.
The principal integrated, reviewed, added the role/error matrix and test-discovery
fix, ran migrations/dependency/full checks/performance, and owns Git/memory writes.

No confirmed exploitable authorization/SQL-injection/IDOR bypass was found in
the inspected paths; this is not proof of absence. Enumeration by registration
conflict status remains documented. There is no production RLS/runtime role,
MFA/email verification/reset/invitation delivery, shared limiter, external audit
archival/security telemetry, configured public frontend CSP or real TLS/proxy
verification. A SQL owner can disable triggers/TRUNCATE; audit is prospective and
does not capture independent SQL without actor context. Import previews depend
on a process-local secret. Spreadsheet compatibility and assistive-technology
coverage are not universal claims.

Phase11 fictional demo data and commercial UX is the recommended next bounded
scope; it was not started. No remote, push, public deployment, production data,
global ADR, global learning or procedure change was made. Candidates from
Phases7/9 remain proposals: order-lock receipt acceptance with atomic ledger
commit, and fingerprinted preview revalidation under the writer lock.
