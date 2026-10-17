-- Apply as the migration/database owner AFTER migrations. The administrator
-- creates stockflow_runtime as LOGIN with a secret supplied outside this file.
-- This role must own no object and inherit no privileged role membership.
-- New tables deliberately require a reviewed explicit grant, not default grants.
BEGIN;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO stockflow_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM stockflow_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM stockflow_runtime;
GRANT SELECT, INSERT ON TABLE
  "Organization", "User", "Membership", "Session", "Category", "Product",
  "Warehouse", "InventoryBalance", "InventoryMovement", "InventoryCommand",
  "InventoryTransfer", "Supplier", "PurchaseOrder", "PurchaseOrderLine",
  "PurchasingCommand", "PurchaseReceipt", "PurchaseReceiptLine",
  "InventoryThreshold", "AuditEvent", "ImportJob"
TO stockflow_runtime;
GRANT UPDATE ON TABLE
  "Organization", "User", "Membership", "Session", "Category", "Product",
  "Warehouse", "InventoryBalance", "InventoryCommand", "Supplier",
  "PurchaseOrder", "PurchaseOrderLine", "InventoryThreshold"
TO stockflow_runtime;
GRANT DELETE ON TABLE "Session", "PurchaseOrderLine", "Membership" TO stockflow_runtime;
-- Invoker trigger functions enforce ledger, purchasing and audit invariants;
-- they require the explicit business-table privileges above. UUID keys need no
-- sequence grants. Runtime has no migration-table, DDL or history-edit grants.
COMMIT;
