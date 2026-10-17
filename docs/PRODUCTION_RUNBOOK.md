# Public demo operations and recovery

Project: `SC-PROJ-STOCKFLOW`. Updated 2026-10-17. **Status: public demo deployed; actual cloud dump restored into isolated local PostgreSQL. Provider PITR and cloud failover remain unverified.** Commands below are administrative procedures; only the dated [public evidence](PHASE12_PUBLIC_VERIFICATION.md) establishes executed results. Use [deployment configuration](DEPLOYMENT.md) for the actual target.

Current demo: https://stockflow-demo-qsb3.onrender.com. Render service srv-db9uqm7btjjs73d4ruq0; Neon project wandering-snow-13740393, database stockflow_public_demo, both Virginia. Runtime uses stockflow_runtime; owner access stays in private administrator storage. Never use local demo reset against this cloud target.

On this Windows host, Prisma's first IPv6 attempts timed out. An administrative process with connect_timeout=0 and an outer four-minute deadline succeeded without changing network settings. Use Prisma-supported sslmode=require with sslaccept=strict; retain verify-full for pg/libpq. For the executed pg_dump, PGHOSTADDR was resolved to a current public IPv4 address while PGHOST retained the DNS endpoint for certificate checking; an explicit trusted CA bundle was required. Do not pin an old IP permanently, disable TLS checking or copy credentials into command history. If seed stops, inspect exact counts and durable commands before retrying; the initial public continuation completed only missing purchasing/receiving/CSV operations through HTTPS.

## Diagnose before changing state

1. Record UTC time, affected URL, HTTP status, request ID and deployed commit. Inspect public liveness/readiness separately. Never record session cookies, CSRF tokens, passwords, raw imports or connection strings.
2. Inspect provider service/deploy status and redacted logs. Startup, dependency/database failures, status and latency are useful; request bodies and full query strings are not. Request IDs correlate HTTP responses/logs; business correlation IDs identify durable domain operations and are not automatically the same identifier.
3. Check database availability, migration status, connection exhaustion, storage/quota and account limits. Do not run seed/reset to investigate an outage. A successful liveness check does not prove database access or tenant correctness.
4. If traffic follows inactivity, distinguish provider wake-up from application errors. Record wall time from the first request until readiness and a usable dashboard, then record warm samples. No artificial keep-alive service is configured. Render Free can sleep after 15 idle minutes; Neon Free can suspend after five. See the dated provider limits in [deployment](DEPLOYMENT.md).
5. For an uncertain stock write, inspect its original idempotency key, movement/receipt history and resulting state before retrying. Reuse the same key to resolve uncertainty. Do not issue a fresh key or edit balances independently.

Production logs should identify request ID, method, normalized route, response status, duration and safe failure category. Database query text, headers, URLs with credentials, cookies and arbitrary errors must not be printed. Provider log access is administrative and must remain restricted. No paid observability stack or guaranteed alerting is implied.

## Provider recovery limits

Checked 2026-10-17: Neon Free offers a six-hour history window capped at 1 GB of changes. Confirm the live branch's retained interval before relying on it; there is no long-term backup guarantee. A restore-history feature is not an independently retained export. [Neon recovery/history documentation](https://neon.com/docs/introduction/plans).

Render Free Postgres has **no managed backups**. A manually exported `pg_dump` is the available independent path. A fallback Render Free database expires after 30 days; record the creation/expiry dates and export before expiry. The post-expiry grace period is not a freely usable database or a recovery plan. Do not upgrade to a paid plan without authorization. [Render backup documentation](https://render.com/docs/postgresql-backups), [Free database limits](https://render.com/docs/free).

No automated backup schedule, successful cloud restore or measured recovery-time/recovery-point objective exists merely because this runbook exists. Record the last verified export, checksum, restore drill and data-loss interval in the Phase 12 report. If none exists, explicitly mark **NOT VERIFIED**.

## Manual logical export

Use PostgreSQL client binaries compatible with the selected server. `pg_dump` cannot dump a newer server major than itself. Run from the administrator's trusted machine; keep the provider TLS requirements. Use a private PostgreSQL service/passfile so neither password nor URL appears in process arguments or logs. The example `stockflow_public_owner` is a local service alias that must be configured privately; it is not a supplied credential.

Choose an access-controlled backup directory outside Git. If using this workspace's ignored `.cache`, verify ignore status first and remember that it is temporary local storage, not an off-device backup. Keep any retained copy encrypted/access restricted. A dump contains password hashes, sessions and all tenant data even when the business scenario is fictional.

```powershell
# From the StockFlow repository root; privately configure PGSERVICEFILE/PGPASSFILE first.
New-Item -ItemType Directory -Force -Path .cache/backups | Out-Null
$backupFile = Join-Path (Resolve-Path .cache/backups) ('stockflow-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump')
pg_dump --dbname=service=stockflow_public_owner --format=custom --no-acl --file=$backupFile
if ($LASTEXITCODE -ne 0) { throw 'Backup failed; do not use the partial archive.' }
Get-FileHash -Algorithm SHA256 -LiteralPath $backupFile
pg_restore --list $backupFile
if ($LASTEXITCODE -ne 0) { throw 'Archive inspection failed.' }
```

Record UTC export time, source database identity without credentials, server/client versions, deployed revision, migration names, byte size and SHA-256. Do not commit the archive or authentication files. A readable archive list only checks its structure; it does not prove restorability. Roles and cluster-wide configuration require separate reviewed provisioning, not a blind cluster-wide secrets dump. [PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html).

## Restore into a new target

1. Identify and contain the incident. Stop public writes while choosing a consistent recovery point. Export the current state if safely possible, even when recovering an older state. Keep the original database and records; never drop it as a prerequisite.
2. Provision a **new dedicated empty database** within the authorized no-cost resources. If quota blocks it, request a decision; do not upgrade automatically or restore over the live database. Confirm exact provider, region, host and target name. Use a private service alias such as `stockflow_recovery_owner` pointing only to this new target.
3. Verify the recorded archive checksum and list. Restore as the new database owner using the command below. No `--clean`, `--create` or destructive target reuse is required. Abort on failure; do not switch the application to a partial restore.

```powershell
pg_restore --dbname=service=stockflow_recovery_owner --no-owner --no-acl --exit-on-error --single-transaction $backupFile
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; keep the original runtime target.' }
```

4. Restore reviewed runtime role grants separately; a `--no-acl` archive does not recreate them. Confirm ownership, migration records, triggers, ledger immutability, audit permissions, required functions and sequence privileges. Run migration **status** first. Apply only known missing migrations through the owner process after confirming compatibility; never use `db push` or overwrite migration history.
5. Against the recovery target, compare tenant/record counts, ledger sums versus balances, receipt lines versus order received totals, nonnegative balances and enabled constraints. Test ordinary writes with the runtime role and rejected forbidden statements. Exercise login, tenant isolation, idempotent transfer and receipt in dedicated fictional validation data. Do not modify historical quantities to make reconciliation pass.
6. Once accepted, update only the service's runtime `DATABASE_URL` secret, deploy/restart the intended application commit and run the public smoke/browser checks. Revoke stale sessions where needed through a reviewed administrative procedure; restored archives can revive previously valid sessions. Record the switch time and any intentionally lost post-backup demo operations.
7. Retain the original target until acceptance and a recovery record exist. Deleting it is a separate explicit action. Update the current recovery target, backup location and observed timings without exposing secrets.

[PostgreSQL pg_restore options](https://www.postgresql.org/docs/18/app-pgrestore.html) explain custom-archive restoration, owner/ACL handling and transaction behavior. Provider PITR, if actually available, also needs target selection, grants and application acceptance; availability alone does not constitute a rehearsal.

## Fictional demo rebuild

A visitor can change a shared writable sample organization. Use the guarded public administrator tooling and exact cloud target confirmation; never expose its credential or an HTTP reset endpoint. Prefer building a new dedicated database, applying existing migrations, provisioning roles and seeding the fictional scenario, then validating and switching the runtime target. Preserve/export the old target first. This intentionally resets demo history and is different from restoring a customer database.

Local `npm run demo:reset` applies only to the marked loopback `stockflow_demo`; it is not a cloud recovery command. Do not modify its host/database guards. Do not schedule a paid reset job or silently destroy public history. Document the reset time and explain that sample IDs/timestamps can change.

## Application rollback

Record the currently deployed commit and last accepted commit. Roll back application code only when its database compatibility is known. Render Free exposes only the two most recent previous deploys; if needed redeploy a preserved Git commit without rewriting history. [Render Free rollback limits](https://render.com/docs/free).

An application rollback **does not roll back PostgreSQL**. These nine migrations have no implied automatic down path. Keep the existing schema for a compatible code rollback; use the separate new-target recovery procedure for a database rollback. Do not delete migration records, disable constraints or subtract ledger rows. Test login, readiness and the core operation after switching code.

## Timestamp and operational boundaries

UTC database sessions are required for current operations. Older rows created before the verified UTC correction may need a separate provenance-based assessment. Never apply a blanket three-hour shift: PostgreSQL timestamp types, driver conversions and mixed historical writers can differ. Preserve original evidence and design a scoped migration only if actual affected data is proven.

This demo has no verified commercial SLA, load envelope, durable on-call alerting, multi-instance shared rate limiter, independent scheduled backup, universal browser coverage or exhaustive accessibility certification. Changes to proxy/CDN topology, database plan or application origin require repeating ingress, cookie, CSRF, rate-limit and isolation checks. Any security incident involving real secrets requires credential revocation/rotation and investigation, not only rebuilding fictional sample data.
