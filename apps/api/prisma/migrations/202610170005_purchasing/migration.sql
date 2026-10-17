-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchasingCommandType" AS ENUM ('CREATE', 'SEND', 'CANCEL');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "legalName" VARCHAR(200),
    "taxId" VARCHAR(100),
    "email" VARCHAR(254),
    "phone" VARCHAR(100),
    "notes" VARCHAR(2000),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" VARCHAR(2000),
    "version" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancellationReason" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "orderedQuantity" DECIMAL(20,6) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasingCommand" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" "PurchasingCommandType" NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "actorId" UUID NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasingCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_organizationId_id_key" ON "Supplier"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_organizationId_taxId_key" ON "Supplier"("organizationId", "taxId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_organizationId_createdAt_id_idx" ON "PurchaseOrder"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_id_key" ON "PurchaseOrder"("organizationId", "id");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_organizationId_productId_idx" ON "PurchaseOrderLine"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_organizationId_purchaseOrderId_productId_key" ON "PurchaseOrderLine"("organizationId", "purchaseOrderId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchasingCommand_organizationId_type_key_key" ON "PurchasingCommand"("organizationId", "type", "key");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_organizationId_purchaseOrderId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasingCommand" ADD CONSTRAINT "PurchasingCommand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasingCommand" ADD CONSTRAINT "PurchasingCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_state_fields" CHECK (
  "version" >= 0 AND
  (("status" = 'DRAFT' AND "sentAt" IS NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
  OR ("status" = 'SENT' AND "sentAt" IS NOT NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(trim("cancellationReason")) > 0))
);
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_positive" CHECK ("orderedQuantity" > 0);
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_name_nonempty" CHECK (length(trim("name")) > 0);
ALTER TABLE "PurchasingCommand" ADD CONSTRAINT "PurchasingCommand_response_object" CHECK (jsonb_typeof("response") = 'object');

CREATE FUNCTION purchasing_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Purchase order history cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Orders must start as drafts' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW."id" <> OLD."id" OR NEW."organizationId" <> OLD."organizationId" OR NEW."creatorId" <> OLD."creatorId" OR NEW."createdAt" <> OLD."createdAt" THEN
      RAISE EXCEPTION 'Order identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" = 'CANCELLED' OR (OLD."status" = 'SENT' AND NEW."status" <> 'CANCELLED') THEN
      RAISE EXCEPTION 'Invalid order transition or frozen order' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" = 'SENT' AND (NEW."supplierId" IS DISTINCT FROM OLD."supplierId" OR NEW."notes" IS DISTINCT FROM OLD."notes" OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt") THEN
      RAISE EXCEPTION 'Sent order content is frozen' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT','SENT','CANCELLED') THEN RAISE EXCEPTION 'Invalid state' USING ERRCODE = '23514'; END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'CANCELLED' AND NEW."sentAt" IS NOT NULL THEN RAISE EXCEPTION 'Draft was never sent' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW."status" <> 'CANCELLED' AND NOT EXISTS (SELECT 1 FROM "Supplier" WHERE "id"=NEW."supplierId" AND "organizationId"=NEW."organizationId" AND "active" FOR SHARE) THEN
    RAISE EXCEPTION 'Active supplier required' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'SENT' AND EXISTS (SELECT 1 FROM "PurchaseOrderLine" l JOIN "Product" p ON p."id"=l."productId" AND p."organizationId"=l."organizationId" WHERE l."purchaseOrderId"=NEW."id" AND NOT p."active") THEN RAISE EXCEPTION 'Active products required' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PurchaseOrder_header_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION purchasing_header_guard();

CREATE FUNCTION purchasing_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "PurchaseOrderStatus"; line_org uuid; line_order uuid; product_scale integer; product_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN line_org := OLD."organizationId"; line_order := OLD."purchaseOrderId";
  ELSE line_org := NEW."organizationId"; line_order := NEW."purchaseOrderId"; END IF;
  SELECT "status" INTO parent_status FROM "PurchaseOrder" WHERE "id"=line_order AND "organizationId"=line_org FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'Only draft lines can change' USING ERRCODE='55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW."organizationId"<>OLD."organizationId" OR NEW."purchaseOrderId"<>OLD."purchaseOrderId" OR NEW."id"<>OLD."id" OR NEW."createdAt"<>OLD."createdAt") THEN RAISE EXCEPTION 'Line identity is immutable' USING ERRCODE='55000'; END IF;
  SELECT "quantityScale","active" INTO product_scale,product_active FROM "Product" WHERE "id"=NEW."productId" AND "organizationId"=NEW."organizationId" FOR SHARE;
  IF product_scale IS NULL OR NOT product_active OR NEW."orderedQuantity" <> trunc(NEW."orderedQuantity",product_scale) THEN RAISE EXCEPTION 'Invalid line product or precision' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PurchaseOrderLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrderLine" FOR EACH ROW EXECUTE FUNCTION purchasing_line_guard();

CREATE FUNCTION purchasing_lines_required() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_id uuid; org_id uuid; line_count integer;
BEGIN
  IF TG_TABLE_NAME = 'PurchaseOrder' THEN order_id:=NEW."id"; org_id:=NEW."organizationId";
  ELSIF TG_OP = 'DELETE' THEN order_id:=OLD."purchaseOrderId";org_id:=OLD."organizationId";
  ELSE order_id:=NEW."purchaseOrderId";org_id:=NEW."organizationId"; END IF;
  SELECT count(*) INTO line_count FROM "PurchaseOrderLine" WHERE "organizationId"=org_id AND "purchaseOrderId"=order_id;
  IF line_count < 1 OR line_count > 100 THEN RAISE EXCEPTION 'Orders require 1-100 lines' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "PurchaseOrder_lines_required" AFTER INSERT OR UPDATE ON "PurchaseOrder" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purchasing_lines_required();
CREATE CONSTRAINT TRIGGER "PurchaseOrderLine_count" AFTER INSERT OR UPDATE OR DELETE ON "PurchaseOrderLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purchasing_lines_required();

CREATE FUNCTION purchasing_command_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Purchasing commands are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER "PurchasingCommand_immutable" BEFORE UPDATE OR DELETE ON "PurchasingCommand" FOR EACH ROW EXECUTE FUNCTION purchasing_command_immutable();

CREATE FUNCTION purchasing_catalog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='Supplier' THEN
   IF NOT NEW."active" AND EXISTS (SELECT 1 FROM "PurchaseOrder" WHERE "organizationId"=OLD."organizationId" AND "supplierId"=OLD."id" AND "status" IN ('DRAFT','SENT')) THEN RAISE EXCEPTION 'Supplier has open orders' USING ERRCODE='23514'; END IF;
 ELSE
   IF (NEW."unitOfMeasure"<>OLD."unitOfMeasure" OR NEW."quantityScale"<>OLD."quantityScale") AND EXISTS (SELECT 1 FROM "PurchaseOrderLine" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD."id") THEN RAISE EXCEPTION 'Product order history freezes units' USING ERRCODE='23514'; END IF;
   IF NOT NEW."active" AND EXISTS (SELECT 1 FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" p ON p."id"=l."purchaseOrderId" AND p."organizationId"=l."organizationId" WHERE l."organizationId"=OLD."organizationId" AND l."productId"=OLD."id" AND p."status" IN ('DRAFT','SENT')) THEN RAISE EXCEPTION 'Product has open orders' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Supplier_open_orders_guard" BEFORE UPDATE ON "Supplier" FOR EACH ROW EXECUTE FUNCTION purchasing_catalog_guard();
CREATE TRIGGER "Product_purchasing_guard" BEFORE UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION purchasing_catalog_guard();
