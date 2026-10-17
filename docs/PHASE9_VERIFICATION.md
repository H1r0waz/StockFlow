# Phase 9 verification — CSV imports and operational reports

Date: 2026-10-17, America/Buenos_Aires. Baseline:
ac8295038e70b179aa25eb79ae89356faf73ce18. Phase 10 is not started.

## Implemented contracts

[IMPORTS.md](IMPORTS.md) defines exact headers, normalization, identities and
confirmation behavior. [REPORTS.md](REPORTS.md) defines the eight report/export
projections, permissions, filters, limits and formula-neutralization policy.

Products match SKU within the organization and CREATE, UPDATE or SKIP normalized
metadata. Existing optional values survive omitted columns; explicit empty
category/description clears them. Active state is not importable. Existing stock,
order and threshold history freezes product unit/precision. Suppliers are
create-only; names never imply updates and duplicate nonempty tax IDs fail.
Categories, warehouses and stock movements are deliberately not imported.

CSV is bounded to 256 KiB UTF-8, 2,000 data rows and eight columns. Commas, quoted
fields, escaped quotes, embedded newlines, BOM, CRLF/LF and empty lines have explicit
parser behavior. Invalid headers, quoting, replacement characters, NUL, surrogate
errors and abusive limits fail safely. JSON imports have a separate 1 MiB envelope
cap; ordinary routes retain their 100 KiB cap. Files are selected in the browser
and sent as text; filenames, MIME claims and paths never select a server file.

Preview parses/normalizes/validates and returns row errors/operations/counts
without any database write. An HMAC token binds actor, tenant, resource, exact
CSV hash, current plan fingerprint, proposed job ID and thirty-minute expiry.
Confirm reauthorizes inside the existing organization writer, replans current
references/identities/history and rejects stale intent with 409. The entire
bounded batch, immutable ImportJob and safe audit commit together or roll back.
Successful jobs replay without duplicate catalog effects or audit. Ordinary
catalog audit events share the job correlation ID with IMPORT_CONFIRM counts.
No raw file, supplier contacts, notes or preview token enters audit/job storage.

The signing secret is process-local: restart invalidates tokens, while committed
job status remains queryable. Within the same process, a committed matching job
replays even after preview expiry, following live authorization. An unconfirmed
expired preview must be regenerated. A new preview is a new command, including
create-only suppliers without tax IDs; it is not file-level deduplication.

Reports cover products, suppliers, current persisted balances, movements,
purchase-order headers, receipt headers, configured critical stock and filtered
audit. They use fixed parameterized tenant projections, not arbitrary SQL or
whole-table browser aggregation. No mixed-unit totals or financial KPIs are
invented. Reports default50/max100, exports default1000/max2000, offset<=1000000.
Exports expose continuation headers; UI exports the explicitly filtered current
50-row page. Audit requires OWNER/ADMIN; other reports are available to MEMBER.
CSV quotes every cell, doubles embedded quotes, emits UTF-8 BOM/CRLF and prefixes
spreadsheet formula/control prefixes with an apostrophe. Exports are safe limited
projections, not backups or universal round-trip import templates.

## Executed evidence

| Check                          | Result                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| db:migrate                     | APROBADO: 202610170008_imports on dedicated stockflow_dev and stockflow_test                                                                                  |
| db:verify-clean                | APROBADO: nine migrations on empty temporary database, no Prisma schema difference; temporary removed                                                         |
| Initial focused Phase 9 suite  | APROBADO: 43 cases in 48.80s                                                                                                                                  |
| Expanded focused Phase 9 suite | APROBADO: 47 cases in 33.83s                                                                                                                                  |
| Full PostgreSQL suite          | APROBADO: 302 cases, eight files, 250.30s; 255 prior regressions and 47 Phase 9 cases                                                                         |
| npm test                       | APROBADO: 3 API smoke + 11 pure CSV serializer cases and 27 frontend cases; 302 DB cases explicitly skipped without TEST_DATABASE_URL and executed separately |
| Prisma validate/generate       | APROBADO, Prisma 7.10.1                                                                                                                                       |

Final focused verification after the review corrections: **48/48 PostgreSQL
Phase 9 cases passed in 45.69s**. Together with the full regression run above,
this covers the final import/report corrections and the added category case;
it does not claim that a 303-case full suite was rerun.

**17/17 E2E passed in 1.2 minutes**, using installed Chrome and real web/API/test
PostgreSQL. Fifteen existing journeys and two CSV journeys passed. The owner
registers/logs in, inspects duplicate-row errors with confirmation disabled,
previews a valid file while the catalog remains empty, and confirms. The test
aborts delivery of the successful response after the server commit; retry with
the same preview returns the original result with two products and one import
summary audit. Supplier import, browser reload and downloaded product/supplier
CSV content are verified, including formula protection and omitted contacts.
MEMBER cannot import or download full audit, while ordinary reports remain usable.

Final lint, format:check, typecheck and builds passed; 125 local Markdown targets
resolve. The first final formatting attempt identified only the new E2E file's
formatting, which was corrected before the passing check.

Tests exercise read-only preview, valid create/update/skip, supplier identity,
row/format/encoding errors, tenant SKU reuse, references, role revocation,
token tampering, expiry, stale product/category state, idempotency and direct
SQL job immutability. Two concurrent independent HTTP confirmations meet at an
explicit barrier before opening their transaction: different previews competing
for the same SKU yield one success and one stale conflict; the same preview
replays one committed result. A late injected failure rolls back all catalog,
job and audit effects, then retry succeeds. These use the real PostgreSQL adapter
and pool, not a mocked database.

Nonempty operational fixtures verify filtered balances, movements, partial orders,
receipts, alerts and import audit exports; all eight report/export types are
bounded and tenant scoped. Tests cover formula cells and omitted contact/secret
fields, foreign IDs, stable ties/pages and truncation headers. Frontend tests use
mocked HTTP for preview/confirm/invalid/stale/network retry/member/report paging;
they do not replace real database/browser evidence.

Review found and corrected a retained-category lookup when the CSV omits its
category header, UUID case normalization in report filters and supplier UI copy
that incorrectly implied upsert. A regression test retains an inactive existing
category through update/skip; uppercase existing report UUIDs are also checked.
Previous migrations, AGENTS and prior phase verification reports are preserved.
Old test cleanup now includes ImportJob because immutable job FKs retain actors
and organizations; no production delete API was added.

## Local measurement

A guarded ignored script used only the dedicated stockflow_test database and a
fictional benchmark organization. One process created three disjoint SKU batches,
then replayed each confirmation and checked an export cap. Measurements are single
runs with startup/cache/GC effects; RSS is whole-process before/after, not peak
parser memory or a statistically controlled leak/capacity experiment.

| Data rows    | CSV bytes | Preview ms | Confirm ms | Replay ms | RSS before/after MiB |
| ------------ | --------- | ---------- | ---------- | --------- | -------------------- |
| 100          | 4116      | 124.14     | 139.25     | 19.48     | 175.69 / 142.94      |
| 1000         | 43816     | 25.99      | 471.49     | 19.95     | 142.94 / 206.92      |
| 2000 maximum | 89816     | 48.52      | 674.00     | 21.95     | 206.92 / 263.96      |

All rows committed with expected counts and replayed the same job. A 2,000-row
export returned200,203114 bytes and X-Has-More=true. Subsequent integration cleanup
removed those fictional fixtures. These timings measure HTTP-in-process plus
database, not network/browser throughput. Maximum UPDATE-heavy batches, broad
tenant contention and sustained production memory/latency are NO VERIFICADO.

## Boundaries and remaining risk

Manual review covered stale writes, lock compatibility, scoped joins, permissions,
safe metadata, hostile fields, bounds, path/MIME handling and CSV formula markers.
Three subagents implemented imports, reports and frontend; the report agent also
reviewed the integrated diff read-only. The principal integrated, tested and
closed documentation/Git/memory. This is a focused review, not an exhaustive
security audit. No dependencies, external connectors or global settings changed.

Offset pages can shift across concurrent requests. Privileged SQL writers can
bypass the application's organization locking; constraints still apply, but no
administrator-proof audit/immutability claim is made. Supplier exports omit
identity/contact data and formula neutralization deliberately changes cell text.
Browser spreadsheet applications were not executed, so universal spreadsheet
compatibility is NO VERIFICADO. Process restart loses preview signing capability;
reconcile durable job status before creating a new intention after uncertainty.
The existing pg concurrent-query deprecation warning remains; pinned-version
checks pass and pg9 compatibility is NO VERIFICADO.

Production privileges, load, retention/backups/TLS, final security/accessibility
hardening and deployment remain outside this phase. No queues, bulk stock import,
PDF, external integration or advanced financial reporting was introduced.

A reusable lesson is proposed, not written: bind a read-only preview to a current
state fingerprint, replan under the same writer lock, and commit catalog, result
identity and audit together. The existing Second Brain CSV confirmation note is
an antecedent; extending it requires separate authorization. The Phase 7 global
learning proposal likewise remains only a proposal.

The next recommended phase is Phase 10 consolidated hardening and verification,
subject to its own scope. Work stops after this phase's report.
