# Phase 5 verification — atomic warehouse transfers

Date: 2026-10-17, America/Buenos_Aires. Source baseline a780128.
Result: **APROBADO for the exercised local scope**. No suppliers, purchase
orders, purchasing receipts or commercial dashboard were implemented.

## Model, migration and transaction

InventoryTransfer records the immutable business identity and correlates exactly
one TRANSFER_OUT and one TRANSFER_IN. Each movement retains its own previous and
resulting balance, actor and monotonically increasing version. transferId and
correlationKey both identify the transfer. A separate general AuditEvent model
was not added; these records provide the durable stock-specific evidence.

Migration 202610170004_transfers adds the transfer model, movement directions,
InventoryCommandType with TRANSFER scope and pair/completion protections. The
existing command type is converted through an explicit text cast, preserving old
command values; it is not dropped and recreated as an empty column. Previous
migrations and historical verification reports remain unchanged.

The migration was applied to stockflow_dev and stockflow_test on the dedicated
local PostgreSQL 18.6 cluster at 127.0.0.1:55434. All five migrations also applied
from an empty temporary verification database, with no Prisma schema drift; the
helper removed that temporary database afterward. Direct SQL tests supplement
the schema diff because a diff alone does not verify trigger behavior.

One READ COMMITTED transaction claims the idempotency command, reauthorizes the
actor under organization/membership locks, validates active same-tenant parents,
creates/locks both balance keys in sorted warehouse UUID order, debits/credits,
inserts transfer and ledger pair, stores its exact JSON response and commits.
Any failure rolls back all of those effects. Quantity parsing and arithmetic
reuse the exact numeric(20,6)/bigint protocol, including product precision and
overflow checks. OWNER/ADMIN write; MEMBER reads.

## Executed checks

| Check                         | Observed result                    | Evidence scope                                                                               |
| ----------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| db:migrate                    | APROBADO                           | New migration applied to both dedicated databases                                            |
| db:verify-clean               | APROBADO                           | Five migrations from empty DB, no drift, temporary DB removed                                |
| test:integration              | APROBADO, 137 cases in 68.96s      | Previous103 regressions plus34 real PostgreSQL transfer cases                                |
| npm test                      | APROBADO, 3 API smoke +12 frontend | 137 DB cases explicitly skipped here without TEST_DATABASE_URL and executed separately above |
| test:e2e:db, installed Chrome | APROBADO, 9 cases in 34.6s         | Previous7 journeys and2 new real web/API/PostgreSQL transfer journeys                        |
| lint                          | APROBADO                           | Root ESLint workspace check                                                                  |
| typecheck                     | APROBADO                           | Tools, API, web and shared workspaces                                                        |
| build                         | APROBADO                           | API TypeScript and web TypeScript/Vite                                                       |

Prisma validate/generate and final format:check passed. All49 checked local
Markdown targets resolved. Git diff whitespace checks passed; AGENTS.md, prior
migrations and historical Phase2/3/4 verification reports remain unchanged.
The dedicated PostgreSQL cluster was stopped after verification. Configuration
is never evidence of an executed successful check.

## Real concurrency and rollback

Races A–D use two separate Prisma clients/apps/connections with a deterministic
beforeTransferBalance barrier. Both transactions arrive before row creation or
locking; quantities, persistence and PostgreSQL locking are not mocked. The hook
is internal-only and absent from normal server construction. CaseE concurrently
submits duplicate keys without a barrier behind the command claim.

| Case                                              | Observed outcome                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| A, insufficient shared source                     | One201 and one409, nonnegative source, only successful destination credited |
| B, simultaneous transfers to existing destination | Both201, exact sum, no lost increment, valid per-location chains            |
| C, inverse A→B/B→A                                | Both201; initial10/10 and quantities2/3 produce11/9; no unhandled deadlock  |
| D, absent shared destination                      | Both201; exactly one destination balance and both contributions             |
| E, same concurrent key                            | Equal201 bodies; one logical transfer, exactly two transfer movements       |

Assertions recompute signed ledger sums with bigint millionths and verify every
balance version, previous/resulting transition and total quantity conservation.
An afterTransferDebit failure is injected with both absent and existing
destination balances. Both return a safe500 and leave both balance snapshots
unchanged, with no transfer, partial legs or pending/completed transfer command.
Destination overflow also rolls back the source debit.

## Boundaries and browser evidence

Tests exercise valid fractions, excess scale, zero/negative/number/exponent/space
inputs, UNIT zero precision and very large exact values beyond Number-safe
arithmetic. Cross-tenant product/source/destination and mixed IDs fail; MEMBER
writes fail, ADMIN/OWNER writes pass, a downgraded role blocks replay and a
different authorized actor conflicts with the original key. Equivalent decimal
payloads replay exactly; changed quantities/directions conflict. Inactive product
and either inactive warehouse reject new work. Mass assignment, missing key,
missing CSRF and separate-leg endpoints are rejected.

Direct SQL UPDATE/DELETE of transfer, command and transfer legs fails. A transfer
command without its complete transfer/pair and a transfer entity without its
pair fail deferred completion and leave no effects. Existing Phase4 negative,
ledger chain/immutability and balance-consistency checks remain green.

The browser journey registers and signs in, prepares a product/two warehouses
and source receipt through the real API, displays source availability, transfers
2.125 from5.250, checks3.125000/2.125000 and shared transfer ID in both ledger
rows, rejects insufficient stock and identical warehouses, then reloads and
checks persisted balances/history. The second journey verifies MEMBER has no
transfer form and receives403 from the real HTTP endpoint. Component tests use
HTTP mocks and independently check same-intent network retry key reuse.

## Review, agents and limits

The primary reviewed the SQL pair guards, command enum conversion, scoped IDs,
allowlists, live permissions, replay hashing, lock order including first-use
inserts, exact quantities, rollback, correlated immutable ledger and UI wiring.
No blocking issue remained in this inspected scope. This was a focused manual
review, not a full security scanner or a claim of absolute security.

Three authorized subagents owned backend/schema/migration, frontend/component
tests and PostgreSQL transfer tests respectively. The primary integrated them,
added browser tests/documentation, applied migrations and ran the complete local
verification. Only the primary updates canonical project/session memory.

NO VERIFICADO: sustained production load, every possible driver error mapping,
deliberate real deadlock exhaustion/retry, least-privilege production database
roles, distributed rate limiting and TLS/proxy behavior. Ordered normal inverse
transfers passed; this is not proof against all future lock cycles. The existing
pg adapter emitted a client.query concurrency deprecation warning; checks passed,
but compatibility with a future pg9 upgrade is unverified.

Database owners can disable triggers, TRUNCATE or alter schema. Direct SQL
numeric casts can round before checks; HTTP lexical validation remains required.
UI keys survive while mounted; reload of an uncertain request requires history
reconciliation. Query caps/loaded-result search remain; production pagination and
durable browser intent storage were not added. No new dependency, external
connector, remote, push, deployment or global configuration change was needed.

Next phase: suppliers and purchase orders, with a deliberate monetary/state
contract before implementation. Purchasing receipts remain a subsequent phase.
