# Public demo deployment

Project: `SC-PROJ-STOCKFLOW`. Prepared 2026-10-17. **Status: public portfolio demo deployed; scoped acceptance verified.** Live URL: [StockFlow](https://stockflow-demo-qsb3.onrender.com). Remaining unverified operational checks are explicit in the Phase 12 report. See [Phase 12 evidence](PHASE12_VERIFICATION.md) for executed results and the exact deployed revision.

## Architecture decision

Use one Render Free Node web service to serve the built Vite frontend and Express `/api` under one HTTPS origin. PostgreSQL is a separate, dedicated managed database. This keeps the existing session-cookie architecture, avoids a second frontend deployment and removes cross-site cookie dependencies. Vercel is unnecessary for this version. This is a portfolio demo, not a commercial availability commitment.

Neon Free is the user-selected database because Render Free Postgres expires. On 2026-10-17, the authenticated Chrome console created the dedicated `stockflow-demo` project (`wandering-snow-13740393`), production branch `br-patient-star-b7j4953l`, database `stockflow_public_demo`, AWS N. Virginia (`us-east-1`). The server reports PostgreSQL 18.6. The console confirms Free, 1 GB storage, 100 compute hours, up to 2 CU and six-hour history. The active compute reports max_connections=901; this is a server setting, not a promise of 901 usable application connections. Only PostgreSQL was enabled. Match the application region to Virginia. “Bruno's workspace” is the user-confirmed Render workspace; StockFlow service srv-db9uqm7btjjs73d4ruq0 now runs on Free in Virginia, auto-deploy off, health path /api/ready.

The current Render workspace billing screen confirms Hobby, no card on file, $0 accrued/projected charges, and a $0 monthly pipeline spend limit that stops builds after included minutes run out. Observed shared usage: 26.08/750 free hours, 91 MB/5 GB bandwidth and 21/500 pipeline minutes. These are a time-specific account snapshot; recheck before provisioning if the workspace changes. No billing setting was modified.

Provider documentation checked 2026-10-17:

| Option               | Current documented constraints                                                                                                                                                               | Decision                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Render Free web      | Sleeps after 15 idle minutes; wake-up about a minute; ephemeral filesystem; 750 instance hours/workspace/month; no persistent disk.                                                          | One service; all durable state in PostgreSQL. Measure actual wake-up. |
| Render Free Postgres | 1 GB; expires after 30 days; no managed backups or pooling.                                                                                                                                  | Time-limited fallback only after explicit selection; record expiry.   |
| Neon Free            | 100 CU-hours/project/month; 1 GB PostgreSQL/project, 20 GB/account; 5 GB public transfer/project/month; suspension after 5 idle minutes; six-hour restore history capped at 1 GB of changes. | Preferred, subject to accessible authorized account and quota.        |

Sources: [Render Free](https://render.com/docs/free), [Neon plans](https://neon.com/docs/introduction/plans). Older indexed Neon pages mention 0.5 GB; the current plan page above states 1 GB. Recheck the selected account before provisioning.

Selected **Free**, no paid upgrades, disks, cron jobs or ancillary services. A Free Render compute instance alone does not guarantee a zero bill: bandwidth/build overages can be charged when a payment method exists. Inspect workspace allowances and billing settings; do not authorize supplementary charges. If an enforceable no-cost configuration is unavailable, pause resource creation. [Render billing FAQ](https://render.com/docs/faq).

## Build and service configuration

Use the repository root, `main`, and an explicitly recorded commit. Preserve the original local main history; never force-push. After GitHub rejected the original push with GH007, the user explicitly authorized a fresh public copy using a noreply identity. Local codex/public-release maps that copy to remote main; its tree must equal local main, while commit ancestry intentionally differs. Do not push the private-history branch. Before publication inspect tracked files and history for credentials, dumps, `.env` and unrelated artifacts. Generated clients, `.cache`, local databases and test output must remain ignored. Repository creation/push and the actual service deployment require their existing task authorization; do not infer publication from this document.

Planned Render build:

```sh
npm ci --include=dev
npm run prisma:generate
npm run build
```

Start: `npm start` from the repository root (`node apps/api/dist/server.js`). Build: `npm run build:production` generates Prisma and builds both apps. No migrations or seed belong in the start command. Pin a compatible Node 24 version within the package engine range and npm 11; record the actual build versions. Render allows a `NODE_VERSION` override. [Node version selection](https://render.com/docs/node-version).

Production must listen on `0.0.0.0` and Render's injected `PORT`; do not expose the development loopback binding. Configure `/api/ready` as the hosting health check and separately inspect `/api/health` liveness. A healthy process alone does not prove database readiness. [Render port binding](https://render.com/docs/web-services), [health checks](https://render.com/docs/health-checks).

| Variable           | Required value or handling                                                  |
| ------------------ | --------------------------------------------------------------------------- |
| `NODE_ENV`         | `production`                                                                |
| `SERVE_WEB`        | `true`, serve the built frontend                                            |
| `PUBLIC_DEMO`      | `true`, disable public registration                                         |
| `WEB_ORIGIN`       | Exact assigned HTTPS origin, no wildcard or guessed URL                     |
| `TRUST_PROXY_HOPS` | `1` for the verified single trusted ingress; otherwise investigate topology |
| `DATABASE_URL`     | Secret TLS connection for the restricted runtime role only                  |
| `PORT`             | Provided by Render                                                          |
| `NODE_VERSION`     | Explicit compatible Node 24 version                                         |

Frontend API calls use relative `/api`; do not embed a database URL, private host or secret in Vite variables. Render terminates TLS before forwarding traffic. A hop count is a topology assumption requiring public verification; never set blanket `trust proxy=true`. Check request protocol, secure cookies, IP-based throttling and spoofed forwarding headers at the real ingress. [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/).

## Database, migrations and fictional scenario

Create a new dedicated cloud database. Never repurpose `stockflow_dev`, `stockflow_test` or the local `stockflow_demo`. Keep the owner/migration credential in a restricted, ignored administrator environment file or password store; put only runtime credentials in the web service. Use TLS with certificate verification where supported; do not disable validation to bypass a connection failure.

Apply the **nine existing migrations**, using the owner connection in the administrative process:

```sh
npm exec --workspace @stockflow/api -- prisma migrate deploy
npm exec --workspace @stockflow/api -- prisma migrate status
```

Set `DATABASE_URL` privately for this process; never paste it into a logged shell command. Do not use `prisma db push`, rewrite migrations or run migrations on every boot. Render's pre-deploy command requires a paid service, so the Free setup performs this explicit administrative step separately. A migration status check does not prove absence of schema drift; record any actual comparison and its limits. [Render deploy stages](https://render.com/docs/deploys).

Provision a dedicated non-owner runtime role with only the schema, table, sequence and function rights used by the application. Do not grant superuser, role creation, schema creation, ownership, trigger disabling or blanket all-table write privileges. Preserve append-only ledger/audit restrictions and transactional trigger functionality. Verify successful ordinary operations **and** rejected forbidden SQL with that role. Owner access remains a trusted administrative boundary. Record actual grants and test results rather than claiming least privilege from the role name.

Use the guarded Phase 12 public-demo administrator tooling after reviewing its exact target checks. It must pin the cloud host/database, require explicit project confirmation and use only fictional Distribuidora Nova data. The local `demo:seed`/`demo:reset` commands deliberately reject cloud targets; do not loosen those safeguards. Inspect the final administrator script's help/source for current commands and environment names before execution.

Public sample credentials are intentionally fictional, never real passwords. Public registration should be disabled for this bounded demo; this is a deployment policy, not a replacement for tenant authorization. A shared writable OWNER can change sample business data and roles; there is no password-change endpoint. Document that limitation and use the [manual recovery procedure](PRODUCTION_RUNBOOK.md); do not expose reset or migration endpoints.

## Release acceptance

Run local lint, formatting, types, unit tests, build, Prisma validation/generation and migrations from empty. Then record the public URL, provider/region/version, commit, migration results, fake-data counts and exact runtime role.

Execute public HTTPS/health/static-route checks and real browser login, session, cookie attributes, CSRF/Origin/CORS rejection, stock/transfer/purchasing/receiving, dashboard/alerts/audit, CSV/reports and logout. Use dedicated fictional test tenants; preserve shared sample history. Check cross-tenant IDs, desktop/mobile, refresh, errors and persistence after restart. List actual browsers and paths. A deployed page, HTTP 200 or local E2E result cannot substitute for this evidence.

Measure first load, login, dashboard, inventory and reports with timestamps and repetitions. Separate warm measurements from a confirmed idle cold start. Do not install keep-alive pings or scheduled wake-ups. Mark unavailable checks **NOT VERIFIED**, partial checks **PARTIAL**, failures **FAILED**, and completed checks **PASSED**. Do not close Phase 12 until its public acceptance criteria are met.

## Reviewed public administrator commands

Use `node --import tsx scripts/public-demo.mjs seed` or `verify`.
Required private environment: PUBLIC_DEMO_ADMIN_URL (owner, never runtime),
PUBLIC_DEMO_HOST, PUBLIC_DEMO_DATABASE and
STOCKFLOW_PUBLIC_DEMO_CONFIRM=SC-PROJ-STOCKFLOW. There is no .env/runtime URL
fallback. The target must use TLS, match the exact newly created cloud database
and carry database comment `StockFlow public fictional demo v1`.
Apply only to the authorized new resource after migrations; never mark an unrelated
database. Keep SERVE_WEB unset in the administrative process. If NODE_ENV is
production, set WEB_ORIGIN to the exact HTTPS origin.

Create stockflow_runtime as a dedicated LOGIN with a generated secret outside
source control, no ownership or privileged membership. Apply
[the explicit grants](../scripts/sql/stockflow-runtime.sql) as owner. Verify
actual runtime operations before switching the service to this role.

Set VITE_PUBLIC_DEMO=true at build time and PUBLIC_DEMO=true at runtime.
The built login documents only intentionally public fictional OWNER/MEMBER
credentials; normal local development keeps registration. No public reset
endpoint or seed-on-start exists.
