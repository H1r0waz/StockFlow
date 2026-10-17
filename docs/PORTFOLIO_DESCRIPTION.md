# StockFlow — portfolio descriptions

Copy for project cards, profile entries and a longer project page. StockFlow is a portfolio application with a [public fictional demo](https://stockflow-demo-qsb3.onrender.com). No real customer use, business impact or commercial production capacity is claimed. Technical details and dated evidence: [case study](CASE_STUDY.md), [Phase 11 verification](PHASE11_VERIFICATION.md) and [security](SECURITY.md).

## Español

### Breve

StockFlow es una aplicación de inventario y compras para pymes. Gestiona stock por depósito, transferencias, proveedores y recepciones parciales, con aislamiento por organización y operaciones atómicas. Incluye una demo pública con datos ficticios.

### Media

StockFlow conecta inventario, proveedores y órdenes de compra en una aplicación multiempresa. Permite consultar stock por depósito, registrar movimientos, transferir mercadería y recibir pedidos de forma parcial o total. Un dashboard, alertas de stock mínimo y auditoría ayudan a entender la operación diaria.

El diferencial técnico es la consistencia bajo concurrencia: cantidades exactas, prevención de stock negativo, ledger y saldos en una misma transacción, y claves de idempotencia para reintentos seguros. Desarrollado con React, TypeScript, Express, PostgreSQL y Prisma; incluye importación CSV con preview y revalidación, reportes operativos y pruebas con PostgreSQL real y Playwright. La demo pública utiliza un distribuidor completamente ficticio.

### Extensa

StockFlow es un proyecto de portfolio que aborda un problema cotidiano de las pymes: mantener coherencia entre lo disponible en cada depósito, los movimientos registrados y las compras pendientes de recepción. La aplicación reúne productos, categorías, depósitos, proveedores, órdenes y recepciones dentro de organizaciones separadas, con permisos OWNER, ADMIN y MEMBER.

El núcleo está diseñado para operaciones que pueden competir entre sí. Un egreso no puede consumir stock que otra operación ya utilizó; una transferencia confirma sus dos lados juntos; una recepción revalida el pendiente de la orden antes de actualizar contadores, stock e historial. Las cantidades se manejan con precisión exacta. Los comandos conservan resultados de idempotencia para que un reintento con la misma intención no duplique sus efectos.

La interfaz presenta un dashboard operativo, alertas por producto y depósito, auditoría correlacionada y reportes filtrados. La importación CSV separa preview y confirmación: valida sin escribir y vuelve a comprobar el estado actual antes de confirmar todo el lote. Las exportaciones son acotadas y neutralizan prefijos de fórmulas de planilla.

La arquitectura utiliza React, TypeScript, Vite y Tailwind en el frontend; Node.js, Express y TypeScript en la API; PostgreSQL y Prisma para persistencia. La verificación combina Vitest, Supertest, pruebas de concurrencia y rollback con base real, y recorridos de navegador con Playwright. Distribuidora Nova es el escenario ficticio de una demo pública en Render Free y Neon Free, con setup local reproducible. Su verificación acotada no acredita capacidad productiva comercial.

## English

### Short

StockFlow is an inventory and purchasing application for small and medium businesses. It manages warehouse stock, transfers, suppliers and partial receipts with tenant isolation and atomic operations. A public demo uses entirely fictional business data.

### Medium

StockFlow connects inventory, suppliers and purchase orders in a multi-tenant application. Operators can inspect stock by warehouse, record movements, transfer goods and receive orders partially or in full. An operational dashboard, minimum-stock alerts and business audit make daily activity easier to follow.

Its technical focus is consistency under concurrency: exact quantities, nonnegative stock, atomic ledger/balance updates and idempotent command replay. Built with React, TypeScript, Express, PostgreSQL and Prisma, it also includes CSV preview with confirmation-time revalidation, operational reports and tests against real PostgreSQL and Playwright browser journeys. The public demo represents a completely fictional distributor and also has a reproducible local setup.

### Long

StockFlow is a portfolio project addressing an everyday business problem: keeping warehouse availability, recorded movements and pending supplier deliveries consistent. It brings products, categories, warehouses, suppliers, orders and receipts into separate organizations with OWNER, ADMIN and MEMBER permissions.

The core is designed for competing operations. A stock issue cannot consume inventory already used by another command; a transfer commits both warehouse effects together; receiving rechecks the order's pending quantities before updating counters, stock and history. Quantities use exact precision. Durable idempotency results let a repeated matching intention return its original outcome without duplicating effects.

The interface provides operational counts, product/location alerts, correlated audit and filtered reports. CSV import separates preview from confirmation: validation is read-only, and the current state is checked again before the entire batch commits. Exports are bounded projections with spreadsheet formula neutralization.

The architecture combines React, TypeScript, Vite and Tailwind in the frontend; Node.js, Express and TypeScript in the API; and PostgreSQL with Prisma for persistence. Verification uses Vitest, Supertest, real-database concurrency and rollback tests, and authenticated Playwright journeys. Distribuidora Nova is the fictional scenario for a public demo on Render Free and Neon Free, with a reproducible local setup. Its scoped verification does not establish commercial production capacity.

## Final portfolio fields and release status

- Title: StockFlow
- English subtitle: Inventory you can explain. Purchasing you can follow.
- Subtítulo: Inventario trazable y compras consistentes para pymes.
- Source: [H1r0waz/StockFlow](https://github.com/H1r0waz/StockFlow)
- Live demo: [Open StockFlow](https://stockflow-demo-qsb3.onrender.com)
- Case study: [CASE_STUDY.md](CASE_STUDY.md)
- Problem: warehouse quantities and supplier receipts can diverge under competing writes or retries.
- Solution: scoped inventory and purchasing with exact quantities, ledger, atomic transfers/receipts, durable idempotency and confirmation-time CSV revalidation.
- Stack: React, TypeScript, Vite, Tailwind, Node.js, Express, PostgreSQL, Prisma, Vitest, Supertest, Playwright.
- Evidence: see [Phase 11](PHASE11_VERIFICATION.md) for the accepted local portfolio demo and [Phase 12](PHASE12_VERIFICATION.md) for executed public checks and explicit remaining gaps.
- Deployment scope: one frontend/API origin on Render Free with a separate Neon Free database, verified within the recorded public acceptance scope, with free-tier sleep/quota limits. No commercial production-capacity claim.
