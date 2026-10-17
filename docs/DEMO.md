# Fictional local demo

StockFlow is an inventory and purchasing demonstration. **Distribuidora Nova · Fictional demo** is an invented distributor; its people, suppliers, merchandise and activity have no real commercial relationship. This is a local portfolio environment, not a public deployment.

## Run locally

Use the project's existing local PostgreSQL setup and project `.env` described in the README. No external credentials or services are needed.

```powershell
npm run db:start
npm run demo:seed
npm run demo:api
```

In a separate terminal run `npm run dev:web`, then open `http://127.0.0.1:5173`. Stop a normal development API first: the demo API uses the same port, with its database connection overridden only in the child process. The normal development configuration and `.env` are not rewritten. The normal API security, permissions and rate limits remain in force when browsing.

The seed creates and migrates **stockflow_demo**, separate from **stockflow_dev** and **stockflow_test**, on the dedicated project PostgreSQL instance at `127.0.0.1:55434`. Database credentials come only from this project's existing local `DATABASE_URL`; they are never printed or saved to demo artifacts.

## Public fictional accounts

These are deliberately public demo credentials. Never reuse them for a real account, shared environment or production installation.

| Role   | Email                    | Demo password      |
| ------ | ------------------------ | ------------------ |
| OWNER  | owner@nova.example.test  | Nova-demo-only-42! |
| ADMIN  | admin@nova.example.test  | Nova-demo-only-42! |
| MEMBER | member@nova.example.test | Nova-demo-only-42! |

The accounts share exactly one organization. OWNER can manage roles; ADMIN manages operations; MEMBER can inspect operations and reports but cannot change inventory or read restricted audit events. Password hashes use the existing authentication implementation; the seeder does not add a backdoor or special login endpoint.

## Scenario

| Resource                                                 |          Baseline |
| -------------------------------------------------------- | ----------------: |
| Main organization / users                                |             1 / 3 |
| Categories / products                                    |            6 / 40 |
| Warehouses / suppliers                                   |             3 / 6 |
| Purchase orders                                          |                10 |
| DRAFT / SENT / PARTIALLY_RECEIVED / RECEIVED / CANCELLED | 2 / 2 / 2 / 3 / 1 |
| Purchase receipts / transfers                            |             5 / 6 |
| Inventory movements                                      |                88 |
| Minimum-stock rules                                      |                40 |
| LOW / OUT_OF_STOCK products                              |             6 / 6 |
| Confirmed CSV jobs                                       |                 1 |

Central distribution supplies North branch and Retail showroom. The catalog includes fractional kilograms and litres, plus whole units. Opening receipts, dispatches, count adjustments, branch transfers and purchase receipts create the ledger. Balances are never inserted independently. Auditing runs through the same transaction triggers as ordinary operations. A one-row CSV refresh demonstrates a confirmed import without adding a duplicate product.

Natural keys, names, quantities and operations are deterministic; generated IDs and activity timestamps vary. Activity is created at seed time, so the recent-received window naturally ages after 30 days. The seeder's enlarged request budgets exist only on its in-process domain client; the separately started API keeps production-code defaults.

## Safe repeat and explicit reset

`npm run demo:seed` initializes an empty isolated demo database. Repeating it verifies the expected record counts, ledger/balance reconciliation and received-line totals, then reuses the existing data without appending history. It does not undo your interactive changes. If the scenario is incomplete or changed enough to fail verification, it stops and asks for an explicit rebuild. This validation is a coherence check, not a cryptographic baseline comparison.

After stopping the demo API and closing other demo database connections:

```powershell
npm run demo:reset
```

Reset deliberately deletes **only stockflow_demo**, recreates it, reapplies existing migrations and seeds the fictional scenario. It refuses production mode, other hosts/ports/users/database names, URL query overrides, an existing database without the exact StockFlow demo comment marker, and active connections. It never terminates arbitrary sessions or truncates shared tables. A failed initialization may leave partial demo data; reset is the explicit recovery path. Do not store real information in the demo database.

## Suggested portfolio walkthrough

1. Sign in as OWNER and inspect the dashboard's operational counts.
2. Open alerts: compare healthy products with low and zero stock.
3. Inspect `NOVA-001` Long grain rice and its kilogram precision.
4. Record a small receipt or issue, then transfer stock from Central distribution to a branch.
5. Open suppliers and a SENT purchase order; receive part of its pending lines.
6. Inspect business audit events and their technical details.
7. Preview a small fictional CSV and inspect filtered reports/exports.
8. Sign in as MEMBER to demonstrate permission boundaries.

Interactive operations change the scenario. Rebuild explicitly for repeatable screenshots. Use only local screenshots with fictional data; `.env`, session tokens and database credentials must never appear in screenshots or committed artifacts.

## Tests and limits

`apps/api/test/phase11.test.ts` covers URL boundaries, seed repeatability, exact record counts and order states, ledger/receipt reconciliation, fictional account login, role restrictions and safe audit content against real PostgreSQL. The test helper explicitly permits only `stockflow_test`; test namespaces isolate browser scenarios from parallel users. The CLI permits only `stockflow_demo` and never writes the test database.

This seed is intentionally small. It does not prove production capacity, remote deployment security or exhaustive accessibility. No pricing, revenue or financial totals are fabricated.

Database clients explicitly use UTC sessions so application timestamps and SQL-trigger audit timestamps preserve the same instant. The server timezone and historical records are not changed. If evaluating a database created before this correction, investigate possible historical offsets separately; do not shift dates automatically. The isolated demo was explicitly rebuilt for the current screenshots.
