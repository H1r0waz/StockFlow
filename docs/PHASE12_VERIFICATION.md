# Phase 12 verification — deployment preparation

Date: 2026-10-17, America/Buenos_Aires. Baseline:
`0c169357e2bc9b103f3d8beaa82c081bf3d36680`, main, initially clean.

**PARCIAL — public deployment acceptance remains pending.**
The user selected Neon Free, confirmed Bruno's Render workspace and authorized
a public H1r0waz/StockFlow repository. After GH007 rejected publication of a protected private author email, the user explicitly authorized a fresh public history with a noreply identity; original history stays intact on local main. No cloud database,
Render service, public application URL or deployed revision is verified.
The browser tool reports **Local browser use is disabled in Work settings**;
there is no available Neon connector or authorized Neon API key. Selecting
“enable browser” does not itself change that technical setting. No access
restriction was bypassed, paid resource created or unrelated project changed.

## Implemented and reviewed

- One Express service can publish the compiled Vite frontend and API under the
  same origin. Production binds 0.0.0.0 and the hosting PORT; local development
  remains loopback. Root `npm start` runs the compiled server and
  `npm run build:production` generates Prisma and builds both workspaces.
- SERVE_WEB=true enables static files and HTML navigation fallback. API paths
  and missing assets retain 404 rather than receiving HTML. Frontend CSP permits
  its own assets; API CSP remains restrictive. No permissive CORS is added.
- TRUST_PROXY_HOPS accepts only unset/0/1; default is untrusted. A one-hop Render
  configuration remains a deployment assumption requiring real ingress tests.
  Production cookies stay Secure / HttpOnly / SameSite=Lax; exact Origin and
  CSRF remain enforced.
- PUBLIC_DEMO=true disables server registration. VITE_PUBLIC_DEMO=true builds a
  login exposing only deliberately public fictional OWNER/MEMBER credentials,
  with a shared-data notice and no registration control. Ordinary local builds
  retain registration. An explicit in-process administrator option can bootstrap
  fictional data; HTTP clients cannot override it.
- /api/health is liveness; /api/ready checks PostgreSQL in a bounded transaction,
  with statement timeout and a safe 503 deadline. Pool connection timeout is
  two seconds. A response deadline alone does not prove DB work was cancelled.
- Server-generated UUID request IDs, route patterns, status, duration and safe
  failure categories are logged. Bodies, query values, cookies, tokens, raw SQL
  and connection strings are omitted.
- The separate public administrator seed requires an exact new cloud
  host/database, TLS, project confirmation and a database marker. Local guards
  are preserved. There is no cloud drop/reset action, public reset endpoint,
  db-push deployment path or seed/migrate-on-start.
- Explicit runtime SQL grants separate application access from migration
  ownership. Required ordinary operations are tested with a temporary
  non-owner role; runtime has no schema CREATE, TRUNCATE, history UPDATE or
  migration-table read permission. This is not RLS or protection against an
  already compromised application. The role can read tenant tables and insert
  the audit required by invoker triggers.

## Executed local evidence

| Check                          | Result                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint / typecheck               | APROBADO, all workspaces                                                                                                                    |
| npm test                       | APROBADO: 71 API cases, 327 database cases explicitly skipped; 37 frontend cases                                                            |
| Production build               | APROBADO, including VITE_PUBLIC_DEMO=true artifact                                                                                          |
| Prisma validate / generate     | APROBADO                                                                                                                                    |
| Fresh migrations               | APROBADO: nine existing migrations, no schema drift; temporary database removed                                                             |
| Restricted SQL role            | APROBADO locally: login, transfer, purchase receipt, CSV preview/confirm, MEMBER removal and last-OWNER protection; forbidden grants absent |
| Full real database integration | APROBADO: 352/352, 12 files, 330.44 s; 327 PostgreSQL cases and 25 pure guards                                                              |
| Full real browser regression   | APROBADO: 20/20, installed Chrome, 1.5 min; real local frontend/API/PostgreSQL                                                              |
| Formatting and link checks     | APROBADO: full Prettier and local Markdown target checks                                                                                    |

The final integration count includes pure target guards; do not add it to the
API count as entirely independent coverage. A first frontend run inherited the
public-build flag and failed two normal-registration expectations. Fixtures now
explicitly select normal mode and override it in the public-mode case; the
subsequent complete frontend run passed all 37 cases. No behavior test was removed.

A real Chrome session exercised the **local compiled production artifact over
HTTP**, with its own server and the isolated local fictional demo:
public login copy, disabled registration UI/backend, HTML fallback, API JSON404,
PostgreSQL readiness, real account login/session, Secure/HttpOnly/Lax response
attributes, missing-CSRF and wrong-Origin rejection, logout/revocation,
and no browser page errors. Login/session/logout used explicit HTTP requests;
this is not a public browser-cookie or HTTPS acceptance test. Layout fit
320/768/1440 px. The owned server/browser were closed. Its screenshot remains
an ignored local diagnostic, not a substituted public capture.

## Backup and restoration rehearsal

APROBADO locally: pg_dump custom format of the isolated fictional stockflow_demo,
pg_restore --list, restoration into a new temporary database without owner/ACL
restoration, nine completed migration records and reconciliation of:
40 products, six categories, three warehouses, six suppliers, ten orders,
five receipts, six transfers, 88 movements, 195 audit events and three memberships.
The original database was preserved and the restored temporary target removed.

Dump size: 182403 bytes. SHA-256:
`dffe09dacb752d89cab5bdb261bf2ac496f1812a2f6d6bde37d45302bb6386c7`.
The dump and diagnostic JSON stay under ignored .cache, never in Git.
This does **not** verify Neon snapshots, PITR, retention or cloud restore.

## Publication and provider decision

The historical publication scan checked 338 Git blobs for actual project-local
database credentials, supported token/private-key patterns, tracked environment
files, dumps and unnecessary private artifacts. It passed. This is a scoped
pattern review, not an exhaustive secret-scanner guarantee. Final publication
checks and remote revision are recorded at closure.

Repository: [H1r0waz/StockFlow](https://github.com/H1r0waz/StockFlow), public,
created without auto-initialization. Original local main remains unchanged; the authorized public copy uses a parentless noreply commit on local codex/public-release and remote main. Source trees are compared for equality. Original private-history commits are not pushed again; GitHub email privacy settings stay enabled.
No force-push is authorized or used.

The selected architecture and current free-plan limits are documented with
official sources in [DEPLOYMENT.md](DEPLOYMENT.md). Render Free compute alone
does not establish zero billing: verify existing workspace allowances and
overage controls before a build. Neon Free is selected; Render's expiring
PostgreSQL fallback was not selected. No paid add-on, disk, cron, keep-alive,
new observability stack or cross-project credential is used.

## Public acceptance — NO VERIFICADO

| Required evidence                                                           | Current state                  |
| --------------------------------------------------------------------------- | ------------------------------ |
| Public frontend/API/database and URL                                        | NO VERIFICADO; not provisioned |
| Actual region, PostgreSQL version, project quotas                           | NO VERIFICADO                  |
| Cloud migration status/drift and public seed                                | NO VERIFICADO                  |
| Live runtime role/grants and TLS DB connection                              | NO VERIFICADO                  |
| HTTPS, ingress/IP/proxy/HSTS, browser Secure cookies                        | NO VERIFICADO                  |
| Public login/session/logout, CSRF/Origin/CORS                               | NO VERIFICADO                  |
| Public inventory, transfer, supplier, order, receiving, CSV/report workflow | NO VERIFICADO                  |
| Actual cross-tenant IDs and public browser E2E                              | NO VERIFICADO                  |
| Public responsive / Chrome / Edge                                           | NO VERIFICADO                  |
| Public first load/login/dashboard/inventory/report warm timings             | NO VERIFICADO                  |
| Confirmed idle cold start                                                   | NO VERIFICADO                  |
| Provider backup/PITR/restore execution                                      | NO VERIFICADO                  |
| Deployed commit                                                             | None                           |

Existing Phase 11 screenshots remain real local captures with original
provenance. Regenerate affected screenshots from the public release after it
exists; never relabel local images as production evidence.

## Portfolio, coordination and continuation

README, case study and bilingual portfolio fields now link the source and
explicitly distinguish deployment preparation from a verified live demo.
[PRODUCTION_RUNBOOK.md](PRODUCTION_RUNBOOK.md) describes administrative seed,
private dumps, recovery into a new target, compatibility-aware application
rollback, quota/cold-start limits and actual acceptance checks.

Authorized generic subagents reviewed/implemented production HTTP boundaries,
public data/SQL grants and deployment/recovery documentation. The principal
integrated changes, ran combined verification, checked publication and remains
the sole Second Brain custodian. No persistent agent-profile execution is claimed.

Next required action: enable authorized browser access for the user-selected
Neon account (or provide an approved secure API path), verify Free/account quotas,
create a dedicated StockFlow project/database and runtime role, apply migrations,
seed fictional data, then create the Free Render service with the exact origin
and restricted runtime secret. Perform all public acceptance checks before
declaring Phase 12 complete. No commercial production-readiness verdict is made.
