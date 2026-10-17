-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'PARTIALLY_RECEIVED';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'RECEIVED';

-- AlterEnum
ALTER TYPE "PurchasingCommandType" ADD VALUE 'RECEIVE';

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "purchaseReceiptLineId" UUID;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "receivedQuantity" DECIMAL(20,6) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PurchaseReceipt" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "commandId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReceiptLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "purchaseOrderLineId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "receivedQuantity" DECIMAL(20,6) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReceipt_commandId_key" ON "PurchaseReceipt"("commandId");

-- CreateIndex
CREATE INDEX "PurchaseReceipt_organizationId_purchaseOrderId_createdAt_id_idx" ON "PurchaseReceipt"("organizationId", "purchaseOrderId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReceipt_organizationId_id_key" ON "PurchaseReceipt"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReceipt_organizationId_commandId_key" ON "PurchaseReceipt"("organizationId", "commandId");

-- CreateIndex
CREATE INDEX "PurchaseReceiptLine_organizationId_purchaseOrderLineId_idx" ON "PurchaseReceiptLine"("organizationId", "purchaseOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReceiptLine_organizationId_id_key" ON "PurchaseReceiptLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReceiptLine_organizationId_receiptId_purchaseOrderL_key" ON "PurchaseReceiptLine"("organizationId", "receiptId", "purchaseOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_purchaseReceiptLineId_key" ON "InventoryMovement"("purchaseReceiptLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_organizationId_purchaseReceiptLineId_key" ON "InventoryMovement"("organizationId", "purchaseReceiptLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_organizationId_id_key" ON "PurchaseOrderLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchasingCommand_organizationId_id_key" ON "PurchasingCommand"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_purchaseReceiptLineId_fkey" FOREIGN KEY ("organizationId", "purchaseReceiptLineId") REFERENCES "PurchaseReceiptLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_organizationId_purchaseOrderId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_organizationId_warehouseId_fkey" FOREIGN KEY ("organizationId", "warehouseId") REFERENCES "Warehouse"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_organizationId_commandId_fkey" FOREIGN KEY ("organizationId", "commandId") REFERENCES "PurchasingCommand"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceiptLine" ADD CONSTRAINT "PurchaseReceiptLine_organizationId_receiptId_fkey" FOREIGN KEY ("organizationId", "receiptId") REFERENCES "PurchaseReceipt"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceiptLine" ADD CONSTRAINT "PurchaseReceiptLine_organizationId_purchaseOrderLineId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceiptLine" ADD CONSTRAINT "PurchaseReceiptLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceipt" ALTER CONSTRAINT "PurchaseReceipt_organizationId_commandId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_received_bounds" CHECK ("receivedQuantity">=0 AND "receivedQuantity"<="orderedQuantity");
ALTER TABLE "PurchaseReceiptLine" ADD CONSTRAINT "PurchaseReceiptLine_positive" CHECK ("receivedQuantity">0);
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT "PurchaseOrder_state_fields";
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_state_fields" CHECK (
 "version">=0 AND
 ((status::text='DRAFT' AND "sentAt" IS NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
 OR (status::text IN ('SENT','PARTIALLY_RECEIVED','RECEIVED') AND "sentAt" IS NOT NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
 OR (status::text='CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(trim("cancellationReason"))>0))
);
CREATE OR REPLACE FUNCTION purchasing_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Purchase order history cannot be deleted' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status::text<>'DRAFT' THEN RAISE EXCEPTION 'Orders must start as drafts' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.id<>OLD.id OR NEW."organizationId"<>OLD."organizationId" OR NEW."creatorId"<>OLD."creatorId" OR NEW."createdAt"<>OLD."createdAt" THEN RAISE EXCEPTION 'Order identity is immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status::text IN ('CANCELLED','RECEIVED') OR
   (OLD.status::text='DRAFT' AND NEW.status::text NOT IN ('DRAFT','SENT','CANCELLED')) OR
   (OLD.status::text='SENT' AND NEW.status::text NOT IN ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED')) OR
   (OLD.status::text='PARTIALLY_RECEIVED' AND NEW.status::text NOT IN ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED')) THEN RAISE EXCEPTION 'Invalid order transition or terminal order' USING ERRCODE='55000'; END IF;
  IF OLD.status::text<>'DRAFT' AND (NEW."supplierId" IS DISTINCT FROM OLD."supplierId" OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt") THEN RAISE EXCEPTION 'Sent order content is frozen' USING ERRCODE='55000'; END IF;
  IF OLD.status::text='DRAFT' AND NEW.status::text='CANCELLED' AND NEW."sentAt" IS NOT NULL THEN RAISE EXCEPTION 'Draft was never sent' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.status::text<>'CANCELLED' AND NOT EXISTS (SELECT 1 FROM "Supplier" WHERE id=NEW."supplierId" AND "organizationId"=NEW."organizationId" AND active FOR SHARE) THEN RAISE EXCEPTION 'Active supplier required' USING ERRCODE='23514'; END IF;
 IF NEW.status::text IN ('SENT','PARTIALLY_RECEIVED','RECEIVED') AND EXISTS (SELECT 1 FROM "PurchaseOrderLine" l JOIN "Product" p ON p.id=l."productId" AND p."organizationId"=l."organizationId" WHERE l."purchaseOrderId"=NEW.id AND NOT p.active) THEN RAISE EXCEPTION 'Active products required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION purchasing_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text; line_org uuid; line_order uuid; product_scale integer; product_active boolean;
BEGIN
 IF TG_OP='DELETE' THEN line_org:=OLD."organizationId";line_order:=OLD."purchaseOrderId";
 ELSE line_org:=NEW."organizationId";line_order:=NEW."purchaseOrderId";END IF;
 SELECT status::text INTO parent_status FROM "PurchaseOrder" WHERE id=line_order AND "organizationId"=line_org FOR UPDATE;
 IF parent_status IS DISTINCT FROM 'DRAFT' THEN
  IF TG_OP<>'UPDATE' OR parent_status NOT IN ('SENT','PARTIALLY_RECEIVED') THEN RAISE EXCEPTION 'Only draft content can change' USING ERRCODE='55000';END IF;
  IF (to_jsonb(NEW)-'receivedQuantity'-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'receivedQuantity'-'updatedAt') OR NEW."receivedQuantity"<=OLD."receivedQuantity" THEN RAISE EXCEPTION 'Only received quantity may increase on open sent lines' USING ERRCODE='55000';END IF;
 ELSE
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  IF NEW."receivedQuantity"<>0 THEN RAISE EXCEPTION 'Draft cannot have receipts' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP='UPDATE' AND (NEW."organizationId"<>OLD."organizationId" OR NEW."purchaseOrderId"<>OLD."purchaseOrderId" OR NEW.id<>OLD.id OR NEW."createdAt"<>OLD."createdAt") THEN RAISE EXCEPTION 'Line identity is immutable' USING ERRCODE='55000';END IF;
 SELECT "quantityScale",active INTO product_scale,product_active FROM "Product" WHERE id=NEW."productId" AND "organizationId"=NEW."organizationId" FOR SHARE;
 IF product_scale IS NULL OR NOT product_active OR NEW."orderedQuantity"<>trunc(NEW."orderedQuantity",product_scale) OR NEW."receivedQuantity"<>trunc(NEW."receivedQuantity",product_scale) THEN RAISE EXCEPTION 'Invalid line product or precision' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION purchasing_catalog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='Supplier' THEN
  IF NOT NEW.active AND EXISTS (SELECT 1 FROM "PurchaseOrder" WHERE "organizationId"=OLD."organizationId" AND "supplierId"=OLD.id AND status::text IN ('DRAFT','SENT','PARTIALLY_RECEIVED')) THEN RAISE EXCEPTION 'Supplier has open orders' USING ERRCODE='23514';END IF;
 ELSE
  IF (NEW."unitOfMeasure"<>OLD."unitOfMeasure" OR NEW."quantityScale"<>OLD."quantityScale") AND EXISTS (SELECT 1 FROM "PurchaseOrderLine" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD.id) THEN RAISE EXCEPTION 'Product order history freezes units' USING ERRCODE='23514';END IF;
  IF NOT NEW.active AND EXISTS (SELECT 1 FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" p ON p.id=l."purchaseOrderId" AND p."organizationId"=l."organizationId" WHERE l."organizationId"=OLD."organizationId" AND l."productId"=OLD.id AND p.status::text IN ('DRAFT','SENT','PARTIALLY_RECEIVED')) THEN RAISE EXCEPTION 'Product has open orders' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION purchasing_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "PurchaseReceipt"%ROWTYPE; l "PurchaseOrderLine"%ROWTYPE; parent_status text; product_scale integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Purchase receipt history is immutable' USING ERRCODE='55000';END IF;
 IF TG_TABLE_NAME='PurchaseReceipt' THEN r:=NEW;
 ELSE SELECT * INTO r FROM "PurchaseReceipt" WHERE id=NEW."receiptId" AND "organizationId"=NEW."organizationId";END IF;
 SELECT status::text INTO parent_status FROM "PurchaseOrder" WHERE id=r."purchaseOrderId" AND "organizationId"=r."organizationId" FOR UPDATE;
 IF parent_status IS NULL OR parent_status NOT IN ('SENT','PARTIALLY_RECEIVED') THEN RAISE EXCEPTION 'Order is not receivable' USING ERRCODE='23514';END IF;
 IF NOT EXISTS (SELECT 1 FROM "Warehouse" WHERE id=r."warehouseId" AND "organizationId"=r."organizationId" AND active FOR SHARE) THEN RAISE EXCEPTION 'Active same-tenant warehouse required' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='PurchaseReceiptLine' THEN
  SELECT * INTO l FROM "PurchaseOrderLine" WHERE id=NEW."purchaseOrderLineId" AND "organizationId"=NEW."organizationId" FOR UPDATE;
  SELECT "quantityScale" INTO product_scale FROM "Product" WHERE id=NEW."productId" AND "organizationId"=NEW."organizationId" AND active FOR SHARE;
  IF l.id IS NULL OR l."purchaseOrderId"<>r."purchaseOrderId" OR l."productId"<>NEW."productId" OR product_scale IS NULL OR NEW."receivedQuantity"<>trunc(NEW."receivedQuantity",product_scale) OR NEW."receivedQuantity">l."orderedQuantity"-l."receivedQuantity" THEN RAISE EXCEPTION 'Invalid receipt line or over-receipt' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PurchaseReceipt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseReceipt" FOR EACH ROW EXECUTE FUNCTION purchasing_receipt_guard();
CREATE TRIGGER "PurchaseReceiptLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseReceiptLine" FOR EACH ROW EXECUTE FUNCTION purchasing_receipt_guard();
CREATE FUNCTION purchasing_receiving_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_id uuid; org_id uuid; line_count integer; has_received boolean; has_pending boolean; order_status text;
BEGIN
 IF TG_TABLE_NAME='PurchaseOrder' THEN order_id:=NEW.id;org_id:=NEW."organizationId";
 ELSIF TG_OP='DELETE' THEN order_id:=OLD."purchaseOrderId";org_id:=OLD."organizationId";
 ELSE order_id:=NEW."purchaseOrderId";org_id:=NEW."organizationId";END IF;
 SELECT status::text INTO order_status FROM "PurchaseOrder" WHERE id=order_id AND "organizationId"=org_id;
 SELECT count(*),bool_or("receivedQuantity">0),bool_or("receivedQuantity"<"orderedQuantity") INTO line_count,has_received,has_pending FROM "PurchaseOrderLine" WHERE "purchaseOrderId"=order_id AND "organizationId"=org_id;
 IF line_count<1 OR line_count>100 OR
  (order_status IN ('DRAFT','SENT') AND has_received) OR
  (order_status='PARTIALLY_RECEIVED' AND (NOT has_received OR NOT has_pending)) OR
  (order_status='RECEIVED' AND has_pending) OR EXISTS (
   SELECT 1 FROM "PurchaseOrderLine" l WHERE l."organizationId"=org_id AND l."purchaseOrderId"=order_id AND l."receivedQuantity"<>(SELECT COALESCE(sum(r."receivedQuantity"),0) FROM "PurchaseReceiptLine" r WHERE r."organizationId"=l."organizationId" AND r."purchaseOrderLineId"=l.id)
  ) THEN RAISE EXCEPTION 'Received counters, receipt history and order state must agree' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "PurchaseOrder_receiving_consistency" AFTER INSERT OR UPDATE ON "PurchaseOrder" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purchasing_receiving_consistency();
CREATE CONSTRAINT TRIGGER "PurchaseOrderLine_receiving_consistency" AFTER INSERT OR UPDATE OR DELETE ON "PurchaseOrderLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purchasing_receiving_consistency();
CREATE FUNCTION purchasing_receipt_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_id uuid; r "PurchaseReceipt"%ROWTYPE; c "PurchasingCommand"%ROWTYPE; total integer; valid integer;
BEGIN
 IF TG_TABLE_NAME='PurchaseReceipt' THEN receipt_id:=NEW.id;
 ELSIF TG_TABLE_NAME='PurchaseReceiptLine' THEN receipt_id:=NEW."receiptId";
 ELSIF TG_TABLE_NAME='PurchasingCommand' THEN
  IF NEW.type::text<>'RECEIVE' THEN RETURN NULL;END IF;
  SELECT id INTO receipt_id FROM "PurchaseReceipt" WHERE "commandId"=NEW.id;
 ELSE
  IF (NEW."purchaseReceiptLineId" IS NOT NULL) IS DISTINCT FROM (NEW."referenceType" IS NOT DISTINCT FROM 'PURCHASE_RECEIPT') THEN RAISE EXCEPTION 'Purchase receipt reference requires its receipt line' USING ERRCODE='23514';END IF;
  IF NEW."purchaseReceiptLineId" IS NULL THEN RETURN NULL;END IF;
  SELECT "receiptId" INTO receipt_id FROM "PurchaseReceiptLine" WHERE id=NEW."purchaseReceiptLineId";
 END IF;
 SELECT * INTO r FROM "PurchaseReceipt" WHERE id=receipt_id;
 SELECT * INTO c FROM "PurchasingCommand" WHERE id=r."commandId";
 SELECT count(*),count(*) FILTER (WHERE EXISTS (
  SELECT 1 FROM "InventoryMovement" m WHERE m."purchaseReceiptLineId"=l.id AND m."organizationId"=l."organizationId" AND m.type::text='RECEIPT' AND m."transferId" IS NULL AND m."productId"=l."productId" AND m."warehouseId"=r."warehouseId" AND m.quantity=l."receivedQuantity" AND m."actorId"=r."actorId" AND m."referenceType"='PURCHASE_RECEIPT' AND m."referenceId"=r.id::text AND m."correlationKey"=r.id::text
 )) INTO total,valid FROM "PurchaseReceiptLine" l WHERE l."receiptId"=r.id AND l."organizationId"=r."organizationId";
 IF r.id IS NULL OR c.id IS NULL OR c.type::text<>'RECEIVE' OR c."organizationId"<>r."organizationId" OR c."actorId"<>r."actorId" OR c.key<>r."idempotencyKey" OR c.response->'receipt'->>'id' IS DISTINCT FROM r.id::text OR c.response->'purchaseOrder'->>'id' IS DISTINCT FROM r."purchaseOrderId"::text OR total<1 OR total>100 OR valid<>total THEN RAISE EXCEPTION 'Receipt must commit its complete command, lines and stock ledger' USING ERRCODE='23514';END IF;
 IF EXISTS (SELECT 1 FROM "PurchaseOrderLine" l WHERE l."organizationId"=r."organizationId" AND l."purchaseOrderId"=r."purchaseOrderId" AND l."receivedQuantity"<>(SELECT COALESCE(sum(x."receivedQuantity"),0) FROM "PurchaseReceiptLine" x WHERE x."organizationId"=l."organizationId" AND x."purchaseOrderLineId"=l.id)) THEN RAISE EXCEPTION 'Receipt must update received counters' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "PurchaseReceipt_complete" AFTER INSERT ON "PurchaseReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purchasing_receipt_complete();
CREATE CONSTRAINT TRIGGER "PurchaseReceiptLine_complete" AFTER INSERT ON "PurchaseReceiptLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purchasing_receipt_complete();
CREATE CONSTRAINT TRIGGER "PurchaseReceiptMovement_complete" AFTER INSERT ON "InventoryMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purchasing_receipt_complete();
CREATE CONSTRAINT TRIGGER "PurchasingReceiveCommand_complete" AFTER INSERT ON "PurchasingCommand" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purchasing_receipt_complete();
