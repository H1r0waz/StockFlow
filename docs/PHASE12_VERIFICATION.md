# Phase 12 verification — public portfolio deployment

Date: 2026-10-17, America/Buenos_Aires. Project SC-PROJ-STOCKFLOW.

**PARCIAL: public demo and core acceptance verified; extended operational checks remain open.**

Live demo: [StockFlow](https://stockflow-demo-qsb3.onrender.com).
Source: [H1r0waz/StockFlow](https://github.com/H1r0waz/StockFlow).
Current deployed revision: 423e9753036aa806fa24df1eb3f423bc6224e47e.
See [current public evidence](PHASE12_PUBLIC_VERIFICATION.md) for the authoritative
provider IDs, migrations, actual HTTPS/API/browser results, recovery drill and gaps.
The preparation and publication history below is retained; its earlier pending
provider states are superseded by the dated public report. No commercial production
readiness claim is made.

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
created without auto-initialization. Original local main remains unchanged; the authorized public copy uses fresh noreply history rooted in a parentless commit on local codex/public-release and remote main. Source trees are compared for equality. Original private-history commits are not pushed again; GitHub email privacy settings stay enabled.
No force-push is authorized or used.

The selected architecture and current free-plan limits are documented with
official sources in [DEPLOYMENT.md](DEPLOYMENT.md). Render Free compute alone
does not establish zero billing: verify existing workspace allowances and
overage controls before a build. Neon Free is selected; Render's expiring
PostgreSQL fallback was not selected. No paid add-on, disk, cron, keep-alive,
new observability stack or cross-project credential is used.

## Historical acceptance checklist before cloud continuation — superseded

| Required evidence                                                           | Current state                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Public frontend/API/database and URL                                        | PARTIAL: Neon database created; application URL absent                        |
| Actual region, PostgreSQL version, project quotas                           | Neon Free / Virginia / PostgreSQL 18.6 observed; connection allowance pending |
| Cloud migration status/drift and public seed                                | NO VERIFICADO                                                                 |
| Live runtime role/grants and TLS DB connection                              | NO VERIFICADO                                                                 |
| HTTPS, ingress/IP/proxy/HSTS, browser Secure cookies                        | NO VERIFICADO                                                                 |
| Public login/session/logout, CSRF/Origin/CORS                               | NO VERIFICADO                                                                 |
| Public inventory, transfer, supplier, order, receiving, CSV/report workflow | NO VERIFICADO                                                                 |
| Actual cross-tenant IDs and public browser E2E                              | NO VERIFICADO                                                                 |
| Public responsive / Chrome / Edge                                           | NO VERIFICADO                                                                 |
| Public first load/login/dashboard/inventory/report warm timings             | NO VERIFICADO                                                                 |
| Confirmed idle cold start                                                   | NO VERIFICADO                                                                 |
| Provider backup/PITR/restore execution                                      | NO VERIFICADO                                                                 |
| Deployed commit                                                             | None                                                                          |

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

Next required action: complete the existing Neon target's migrations, runtime
role and fictional seed, then create the Free Render service with the exact
origin and restricted runtime secret. Browser access and resource creation were
verified during the continuation below. Perform all public acceptance checks
before declaring Phase 12 complete. No commercial production-readiness verdict
is made.

## Initial browser and Neon continuation — 2026-10-17 (historical diagnostic snapshot)

- Chrome extension access works; authenticated Neon and Render consoles were
  used without connecting another account or installing software.
- Created only Neon Free project `stockflow-demo`, ID
  `wandering-snow-13740393`, production branch `br-patient-star-b7j4953l`,
  database `stockflow_public_demo`, region AWS `us-east-1` (N. Virginia).
  Other optional services remained disabled. PostgreSQL reports 18.6.
- Confirmed Free in the console: 1 GB storage, 100 compute hours, up to 2 CU,
  ten branches and six-hour restore history. Restore execution is not verified.
- Read-only Node/pg connection succeeds over IPv4 with TLS 1.3, certificate
  authorization true and `sslmode=verify-full`. Server-side `pg_stat_ssl`
  describes the proxy-to-backend connection, so it is not used as proof of
  client-side transport encryption.
- Render workspace `tea-db42gkub7d7c73a4fo90`: Hobby, no card on file,
  $0 accrued/projected charges, pipeline monthly spend limit $0. Observed
  shared usage: 26.08/750 free hours, 91 MB/5 GB bandwidth, 21/500 pipeline
  minutes. No billing changes or paid resources.
- Prisma migration engine returns P1001. During the attempt, Windows reports
  the schema-engine process in `SynSent` to a Neon IPv6 address on port 5432;
  Node connects to the same endpoint over IPv4. `verify-full` is not a
  documented Prisma schema-engine sslmode; the administrative Prisma-only
  URL uses `sslmode=require&sslaccept=strict`, retaining certificate validation.
  See [Prisma PostgreSQL URL options](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql).
- The inspected target still has zero public tables and no runtime role.
  No migration, seed or application deployment is claimed. No global network,
  DNS, firewall or TLS-validation setting was changed; no Docker or installed
  WSL environment was available. Local approved regression was not repeated.
- Owner credentials are stored only in ignored local administrative cache;
  no connection string appears in documentation, public source or vault.

## Publication privacy follow-up

GitHub rejected the original push with GH007 but retained commit objects that
were anonymously discoverable through its commit API. The initial repository
was made private and renamed StockFlow-private-history-20261017 without deleting
its data. A new independent public StockFlow repository was created; only the
authorized noreply copy was pushed. Anonymous checks then returned 422 for the
original development commits and 404 for the private archive. This is a
point-in-time containment check, not proof that nobody accessed the author email
during the earlier interval. Original local history and GitHub email privacy
settings remain preserved. Public and local commit identities intentionally differ;
their source trees are checked for equality.
