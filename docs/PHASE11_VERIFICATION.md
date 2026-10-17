# Phase 11 verification — fictional demo and commercial UX

Date: 2026-10-17, America/Buenos_Aires. Baseline:
`8f0719cd0a680da6a1475368a2542e226f9c2dce`, main, initially clean and without remotes.
Scope: local fictional demonstration, commercial presentation and regression.
Phase 12 has not started.

## Delivered scenario and coherence

**Distribuidora Nova · Fictional demo** has one organization, three users
(OWNER / ADMIN / MEMBER), six categories, 40 products, three warehouses and
six suppliers. Ten purchase orders cover DRAFT / SENT / PARTIALLY_RECEIVED /
RECEIVED / CANCELLED in counts 2 / 2 / 2 / 3 / 1. Five purchase receipts,
six transfers, 88 ledger movements, 40 minimum-stock rules and one confirmed
CSV job provide operational history. The baseline has six LOW and six
OUT_OF_STOCK products and 195 business audit events.

Business data is created through the existing authenticated domain operations.
Only additional fictional user identities are bootstrapped directly before
normal membership assignment. Stock balances are never independently inserted.
Verification reconciles ledger sums with balances and physical receipt lines
with received order quantities. The seeded organization has exactly three
memberships, rather than an extra personal organization for each account.

`demo:seed` creates/migrates only the dedicated local `stockflow_demo`;
a repeat verifies and reuses it without adding history. `demo:reset` is an
explicit rebuild of that database. Target guards reject production mode,
other endpoints, users/databases, query overrides, unmarked existing databases
and active connections. Reset does not terminate unrelated sessions.
No schema, historical migration, dependency, global configuration or other
project is changed. See [DEMO.md](DEMO.md) for commands and public fake accounts.

## Commercial interface

- The fictional organization opens on the operational dashboard, with a discreet
  welcome banner. Ordinary organizations retain their existing initial section.
- Dashboard counts, recent receiving/movements, critical-stock previews and
  shortcuts use real scoped API data; no financial metric is invented.
- Shared status badges distinguish stock and purchasing states using both text
  and color. Catalog, purchasing, imports/reports and audit have clearer labels,
  useful empty states, structured data and consistent spacing.
- Audit action names are readable; raw action/entity/correlation references stay
  available under disclosure controls. Permissions remain server enforced.
- The StockFlow wordmark, simple handmade SVG favicon and existing green palette
  provide a consistent identity. No generated or third-party images are used.
- Existing skip link, focus indicators, labels, main landmark, keyboard-focusable
  table regions and error/reconciliation messages remain in place.

## Issues found and corrected during verification

The first demo seed reached full domain population but verification used an
incorrect receipt column name (`quantity` instead of `receivedQuantity`).
That query was corrected; an explicit fresh reset and seed repeat were then
executed. No arbitrary balance repair or historical rewrite was used.

The first full browser run passed 19/20 cases; the CSV test still expected the
raw operation code `CREATE` after the interface changed it to readable
`Create`. The assertion was updated to the visible label. The existing
dashboard movement assertion was similarly updated to verify its readable
parts. Neither change removes an operation or permission check.

A visual review exposed a three-hour movement/audit discrepancy. Read-only
SQL and bound-Date probes confirmed that the installed Prisma PostgreSQL
adapter mishandled timestamps when the PostgreSQL session used a non-UTC
zone: a 12:00Z literal read as 09:00Z and a 12:00Z parameter wrote as 12:00-03.
Explicit UTC sessions preserve both epochs. Application, demo and real test
clients now use the shared UTC connection factory; this does not change the
server's timezone, global configuration or historical records. Only the
isolated fictional demo is rebuilt. Historical databases written before this
fix may contain offset timestamps and require separate investigation before
any correction; no automatic time-shifting migration is applied.

## Executed checks

| Check                          | Final result                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Real database integration      | **APROBADO: 334/334**, 11 files, 259.98 s; 325 PostgreSQL cases plus nine pure target guards                 |
| API without a database         | **APROBADO: 44**, 325 database cases explicitly skipped, 4.60 s                                              |
| Frontend components            | **APROBADO: 36/36**, six files, 11.86 s                                                                      |
| Complete real browser suite    | **APROBADO: 20/20**, installed Chrome, 1.1 min, including both demo journeys                                 |
| Lint / typecheck / build       | **APROBADO**, workspace commands after the UTC correction                                                    |
| Prisma validate / generate     | **APROBADO**, existing schema and generated client                                                           |
| Migrations from empty database | **APROBADO**, nine existing migrations, no schema drift; temporary database removed                          |
| Demo rebuild and repeat        | **APROBADO**, reset returned reused=false; repeat returned reused=true with identical organization ID/counts |
| Formatting                     | **APROBADO**, full repository Prettier check                                                                 |

Earlier successful 332/332 integration results preceded the two UTC regressions;
the final 334/334 run above supersedes them. The nine target guards also appear
in the 44 API count; these counts must not be added as independent coverage.
The driver emits a concurrent-query deprecation warning for a future pg 9
release. It did not fail current checks; no dependency upgrade was attempted.

Local teardown completed cleanly: PostgreSQL logged "database system is shut
down" at 17:59:03 and ports 3001, 5173 and 55434 had no listeners. The first
pg_ctl wait expired while an existing checkpoint was finishing; shutdown then
completed without a forced process kill or an immediate-mode stop.

## Screenshots and responsive review

Eight raw Chromium screenshots against the isolated fictional demo are stored
in [the screenshot gallery](screenshots/README.md). The
[manifest](screenshots/MANIFEST.json) records generation time, base revision,
working-tree provenance, viewport, scenario and each PNG SHA-256. No passwords,
session material, connection strings or real customer records are pictured.
Import capture previews data without confirming it.

Dashboard, Inventory, Purchasing, Audit, Imports and Reports are checked at
320 / 768 / 1440 px (18 document-overflow checks). Tables retain horizontal
scroll regions. Screenshot review and keyboard/contrast spot checks are local
evidence, not an exhaustive WCAG, screen-reader or device certification.

The authenticated browser checks that Tab reaches the skip link and Enter moves
focus to main. Six computed CSS foreground/background samples pass 4.5:1:
body 13.22, normal badge 7.31, LOW 6.43, OUT/CANCELLED 6.73, SENT 6.96 and
DRAFT/INACTIVE 5.87. Inventory capture uses the real product filter NOVA-017
to keep stock and movement history readable; it does not remove underlying data.

## Documentation, coordination and limits

README presents the product, architecture, local commands and evidence.
[CASE_STUDY.md](CASE_STUDY.md) explains technical decisions and tradeoffs.
[PORTFOLIO_DESCRIPTION.md](PORTFOLIO_DESCRIPTION.md) contains short, medium and
long English/Spanish copy. Historical PHASE reports remain unchanged.

Authorized generic subagents contributed demo data/verification, commercial
UI and portfolio documentation. The principal integrated changes, ran combined
verification and served as sole Second Brain custodian. These task roles do not
claim execution of persistent agent profiles.

**PARCIAL:** accessibility is limited to component/browser checks, keyboard and
contrast samples, and visual review in installed Chrome. **NO VERIFICADO:**
production TLS/proxy, public deployment, infrastructure, sustained load,
distributed limits, backup/restore and exhaustive browsers/assistive technology.
Existing limits on privileged SQL audit bypass, API-restart preview invalidation
and component-memory retry keys remain documented in [SECURITY.md](SECURITY.md).
Demo keys/names/quantities are repeatable; IDs and timestamps vary and recent
activity ages. A changed demo may require an explicit reset.

The closing commit, clean main/no-remotes check and four-destination memory
update are recorded in the final delivery and the new Phase 11 session. No
global ADR, reusable-learning note, remote, push or deployment is created.
