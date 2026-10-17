# Phase 12 — current public evidence

Date: 2026-10-17. Project: SC-PROJ-STOCKFLOW.

**PARCIAL: the public portfolio demo and core journeys are verified. Extended operational acceptance remains open.** This release does not establish commercial production readiness.

## Deployed resources

- Demo: [StockFlow](https://stockflow-demo-qsb3.onrender.com).
- Source: [H1r0waz/StockFlow](https://github.com/H1r0waz/StockFlow).
- Current deployed revision: `423e9753036aa806fa24df1eb3f423bc6224e47e`. Initial business/browser checks ran on `1ed9e3d1eed2434f1929d6a2a2ca3518f0e5fd61`; the later revision changes documentation only.
- Render Free Node service `srv-db9uqm7btjjs73d4ruq0`, Virginia, one instance, auto-deploy off, previews off, readiness `/api/ready`. Deployment `dep-db9uqnu54i7c738ft07g` reached live at 21:50:57 UTC. Express serves built Vite assets and `/api` on the same HTTPS origin. No Vercel service is needed.
- Neon Free project `stockflow-demo`, `wandering-snow-13740393`; production branch `br-patient-star-b7j4953l`; database `stockflow_public_demo`; AWS N. Virginia. Actual server version PostgreSQL 18.6.
- Console confirms Free: 1 GB/project, 100 compute hours, up to 2 CU, ten branches, six-hour history. Actual compute `max_connections=901` is a server setting, not a guaranteed application allowance.
- Render workspace Hobby, no card, $0 accrued/projected charges and $0 pipeline monthly spend limit. Observed shared usage before creation: 26.08/750 hours, 91 MB/5 GB bandwidth and 21/500 pipeline minutes. No paid plan, disk, worker, cron, keepalive or other optional resource was created.

## Database and seed

All nine existing migrations applied using `prisma migrate deploy`; `prisma migrate status` reports up to date. All nine stored checksums match local migration files. No `db push`, migration rewrite or boot-time migration was used. A read-only Prisma migrate diff from the actual cloud datasource to the checked-in schema returned exit0, No difference detected. This covers Prisma-supported schema objects; custom trigger definitions are outside that comparison.

Administrative Prisma initially selected an unreachable IPv6 address and returned P1001. An isolated diagnostic with `connect_timeout=0` connected after approximately 65 seconds; the administrative process then applied migrations with an outer four-minute deadline. Prisma uses `sslmode=require&sslaccept=strict`; pg runtime/admin verification uses `verify-full`, TLS 1.3 and certificate authorization true. No global networking or TLS validation was weakened.

The first seed ran through 40 products, all opening/issue/adjustment/transfer movements and five orders before stopping. This coincided with the first receiving operation; the exact server failure was not captured, so WAN/transaction latency is a hypothesis, not a proven root cause. A guarded administrator continuation inspected the existing records and completed only absent order/receipt/CSV operations through the deployed API, with fresh stable resume keys. No original ledger, balance or receipt was deleted or manually overwritten.

`public-demo verify` then passed: 40 products, six categories, three warehouses, six suppliers, ten orders, five receipts, six transfers, 88 movements, 195 audit events, one import and three memberships. Sums reconcile between ledger and balances, and between receipt lines and order counters. Dashboard shows six low-stock and six out-of-stock products, two draft, two sent, two partial and three fully received orders.

Sample accounts are intentionally public and fictional: `owner@nova.example.test`, `admin@nova.example.test`, `member@nova.example.test`; sample password `Nova-demo-only-42!`. Registration is disabled. Visitors share mutable sample business data; this is not an account for private data. Separate QA organizations remain isolated and contain only fictional records.

The service receives only `stockflow_runtime`. Owner credentials remain in ignored private administrative cache. Runtime role: non-superuser, no create database/role, no inheritance, no schema creation. Product SELECT/INSERT are allowed; ledger UPDATE/DELETE/TRUNCATE, audit UPDATE and migration-table SELECT are absent. Actual forbidden SQL returned 42501 in three checks. Business writes succeeded through the service using this role. This is not RLS and does not resist a compromised owner or full runtime credential.

## Executed public checks

| Scope               | Observed result                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP/TLS            | HTTPS liveness/readiness 200, HTTP redirects to HTTPS, HSTS, static navigation fallback and CSP, unknown API JSON404                                                                                 |
| Session/security    | Real login/session/logout; Secure, HttpOnly, SameSite=Lax; missing CSRF and foreign Origin rejected; no foreign-origin CORS grant; registration disabled; supplied request ID replaced               |
| Ingress             | Forged X-Forwarded-Proto=http did not remove HTTPS HSTS; complete IP-spoofing/throttling/topology analysis NOT VERIFIED                                                                              |
| Public business API | Category/product/two warehouses, receipt/issue/adjustment, transfer and matching replay, negative-stock409, supplier/order/send/partial+total receipt, thresholds/dashboard/alerts/audit             |
| CSV/reports         | Preview/confirmation and CSV export passed; inventory/movements/purchase-order reports200                                                                                                            |
| Actual tenant IDs   | Foreign organization read/write and real product/order IDs denied404; separate actual authenticated QA tenants                                                                                       |
| Reconciliation      | QA ledger/balances reconcile; transfer/receipts yielded exact expected source7/destination8 before the browser's additional transfer                                                                 |
| Chrome UI           | Real HTTPS login, session after refresh, transfer confirmation and source6/destination9 after refresh, draft/send/partial receiving, report rows; total receiving through Chrome remains unconfirmed |
| Responsive          | Actual public inventory at 320/768/1440 without document overflow; dashboard320 without overflow. Not a complete device/accessibility matrix                                                         |
| Logout              | Public HTTP logout and revocation pass; Chrome Nova signout followed by QA login worked. Final QA logout after CSV download interruption was not observed                                            |

The exact checks and timestamps are in [sanitized evidence](phase12-public-evidence.json). API and browser scopes are distinct; the historical 20 local Playwright tests are not relabeled as public E2E. One public journey assertion initially compared JSON property order; verification was corrected to compare transfer and movement IDs and then passed in fresh QA fixtures. No product change was needed.

Browser control stopped responding while waiting for the CSV download. Render logs show the export returned200; local download completion is NOT VERIFIED. A later browser reacquisition reported user unavailable, so Edge, additional public captures and further browser work were not attempted through another automation method.

## Performance and observability

Three warm HTTP samples from the local Windows client, including body consumption:

| Operation           | Milliseconds       |
| ------------------- | ------------------ |
| First HTML document | 337 / 217 / 179    |
| Login               | 1894 / 1831 / 1843 |
| Dashboard           | 265 / 206 / 211    |
| Inventory           | 194 / 185 / 191    |
| Inventory report    | 181 / 193 / 183    |

These are request times, not browser paint/LCP or a capacity benchmark. Confirmed idle cold start remains NOT VERIFIED. No pinger or scheduled wake-up was installed. Render/Neon sleep and quota limits apply.

Actual Render application logs showed server UUID, method, route pattern, status and duration for receipts, reads and CSV export; inspected entries contained no cookies, passwords, raw SQL, request bodies or contact payloads. This sample is not an exhaustive retention or log-security audit. No paid monitoring was added.

## Controlled replacement and persistence

Deployment dep-db9v4deq1p3s739n38qg reached live at 22:11:11 UTC on revision423e9753036aa806fa24df1eb3f423bc6224e47e. After actual service replacement, public health/ready200, login and logout204 passed; QA balances6/10 and the Chrome-created order persisted. The order was PARTIALLY_RECEIVED, with one unit remaining: this corrects the earlier interpretation of a generic Fully received DOM line that belonged to the pre-existing API-created order. No total-receiving Chrome pass is claimed. The API journey had independently completed partial and total receiving successfully. Same-cookie continuity across replacement was not tested.

## Backup and recovery

An actual custom `pg_dump` from Neon was restored with `pg_restore --no-owner --no-acl --exit-on-error` into a fresh isolated local PostgreSQL18 database. Nine completed migrations and the full Nova counts/ledger/receiving reconciliation passed. Cloud source and existing local databases were preserved; only the new temporary recovery target was removed, and the locally started PostgreSQL instance was stopped afterward.

Dump: 199620 bytes, SHA256 `05596d180ba59be88fc8e64fcea78def5eecd5ff2d9dacc76618b3060978b109`; combined dump/restore/verification approximately26.3s. This is an observed rehearsal duration, not an RTO/RPO commitment. Dump and credentials remain ignored/private.

The Windows libpq client needed a current DNS IPv4 address supplied as `PGHOSTADDR` while preserving the endpoint hostname for TLS verification, plus an explicit CA bundle from the already trusted Node root store. No certificate verification was disabled. Neon PITR, cloud-to-cloud restoration, endpoint failover, role recreation and live credential switching remain NOT VERIFIED. The documented six-hour provider history is not a substitute for this external dump.

## Portfolio, source and remaining acceptance

[Public QA inventory screenshot](screenshots/public-qa-inventory.jpg) is an unedited Chrome viewport capture from this public URL; provenance/hash and timestamp are in the JSON evidence. It shows an isolated fictional QA organization. Existing eight Phase11 screenshots and their original local provenance remain unchanged. No local image was relabeled as public.

README, case study, bilingual portfolio descriptions and operational docs now link the live demo and state the real limits. Public source uses the authorized noreply history on `codex/public-release` mapped to remote main; original local main ancestry stays private and must never be pushed directly. The private archive remains private. See the historical privacy incident in [Phase12 preparation](PHASE12_VERIFICATION.md).

Remaining acceptance: confirmed cold start, Edge, browser total receiving and CSV download completion, full ingress/IP spoofing checks, provider PITR/cloud failover and broader responsive/browser coverage. The demo is useful for portfolio now, but **Phase12 remains partial until required outstanding checks are resolved or explicitly accepted**. No commercial-readiness conclusion is made.

The principal executed this continuation. A new focused subagent attempt failed before delivering work because of an account usage limit; no result from it is credited as verification. Historical Phase12 review agents remain documented in the preparation report.
