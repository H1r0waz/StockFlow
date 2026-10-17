-- CreateTable
CREATE TABLE "InventoryThreshold" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "minimumQuantity" DECIMAL(20,6) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" UUID NOT NULL,
    "previousState" JSONB,
    "newState" JSONB,
    "metadata" JSONB NOT NULL,
    "correlationKey" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryThreshold_organizationId_productId_warehouseId_key" ON "InventoryThreshold"("organizationId", "productId", "warehouseId");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_createdAt_id_idx" ON "AuditEvent"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_entityType_entityId_createdAt_id_idx" ON "AuditEvent"("organizationId", "entityType", "entityId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "InventoryThreshold" ADD CONSTRAINT "InventoryThreshold_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryThreshold" ADD CONSTRAINT "InventoryThreshold_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryThreshold" ADD CONSTRAINT "InventoryThreshold_organizationId_warehouseId_fkey" FOREIGN KEY ("organizationId", "warehouseId") REFERENCES "Warehouse"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exact per-product/warehouse thresholds, enforced for direct SQL too.
ALTER TABLE "InventoryThreshold" ADD CONSTRAINT "InventoryThreshold_nonnegative" CHECK ("minimumQuantity">=0);
CREATE FUNCTION stockflow_threshold_precision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."minimumQuantity"<>round(NEW."minimumQuantity",(SELECT "quantityScale" FROM "Product" WHERE id=NEW."productId")) THEN RAISE EXCEPTION 'Threshold exceeds product precision' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER inventory_threshold_precision BEFORE INSERT OR UPDATE ON "InventoryThreshold" FOR EACH ROW EXECUTE FUNCTION stockflow_threshold_precision();
CREATE FUNCTION stockflow_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit events are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION stockflow_audit_immutable();
-- Only verified API transaction context emits audit: no historical backfill or fixture attribution.
CREATE FUNCTION stockflow_business_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb; o jsonb; a uuid; org uuid; act text; before_safe jsonb; after_safe jsonb; corr text; meta jsonb; keys text[]; k text;
BEGIN
 a:=nullif(current_setting('stockflow.actor_id',true),'')::uuid;
 IF a IS NULL THEN RETURN NULL; END IF;
 n:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 o:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 org:=(n->>'organizationId')::uuid;
 corr:=nullif(current_setting('stockflow.correlation_key',true),'');
 act:=CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'DELETE' THEN 'DELETE' ELSE 'UPDATE' END;
 before_safe:=NULL;after_safe:=NULL;meta:='{}'::jsonb;
 keys:=ARRAY['active','role','status','categoryId','unitOfMeasure','quantityScale','supplierId','minimumQuantity','productId','warehouseId'];
 IF TG_TABLE_NAME='InventoryMovement' THEN
  IF n->>'transferId' IS NOT NULL OR n->>'purchaseReceiptLineId' IS NOT NULL THEN RETURN NULL; END IF;
  act:=n->>'type';corr:=n->>'correlationKey';meta:=jsonb_build_object('productId',n->>'productId','warehouseId',n->>'warehouseId','commandId',n->>'commandId');
 ELSIF TG_TABLE_NAME='InventoryTransfer' THEN
  act:='TRANSFER';corr:=n->>'id';meta:=jsonb_build_object('productId',n->>'productId','sourceWarehouseId',n->>'sourceWarehouseId','destinationWarehouseId',n->>'destinationWarehouseId','commandId',n->>'commandId');
 ELSIF TG_TABLE_NAME='PurchaseReceipt' THEN
  act:='PURCHASE_RECEIPT';corr:=n->>'id';meta:=jsonb_build_object('purchaseOrderId',n->>'purchaseOrderId','warehouseId',n->>'warehouseId','commandId',n->>'commandId');
 ELSIF TG_TABLE_NAME='PurchaseOrder' AND TG_OP='UPDATE' AND o->>'status' IS DISTINCT FROM n->>'status' THEN
  IF n->>'status' IN ('PARTIALLY_RECEIVED','RECEIVED') THEN RETURN NULL; END IF;
  act:=CASE n->>'status' WHEN 'SENT' THEN 'SEND' WHEN 'CANCELLED' THEN 'CANCEL' ELSE 'UPDATE' END;
 ELSIF TG_OP='UPDATE' AND o->>'active' IS DISTINCT FROM n->>'active' THEN
  act:=CASE WHEN (n->>'active')::boolean THEN 'ACTIVATE' ELSE 'DEACTIVATE' END;
 END IF;
 IF TG_TABLE_NAME NOT IN ('InventoryMovement','InventoryTransfer','PurchaseReceipt') THEN
  after_safe:='{}'::jsonb;IF o IS NOT NULL THEN before_safe:='{}'::jsonb;END IF;
  FOREACH k IN ARRAY keys LOOP
   IF n ? k THEN after_safe:=after_safe||jsonb_build_object(k,n->k);END IF;
   IF o ? k THEN before_safe:=before_safe||jsonb_build_object(k,o->k);END IF;
  END LOOP;
  IF TG_OP='UPDATE' THEN SELECT jsonb_build_object('changedFields',COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb)) INTO meta FROM jsonb_each(n) WHERE key NOT IN ('updatedAt') AND value IS DISTINCT FROM o->key; END IF;
 END IF;
 INSERT INTO "AuditEvent"(id,"organizationId","actorId",action,"entityType","entityId","previousState","newState",metadata,"correlationKey") VALUES(gen_random_uuid(),org,a,act,TG_TABLE_NAME,(n->>'id')::uuid,before_safe,after_safe,meta,COALESCE(corr,n->>'id'));
 RETURN NULL;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['Category','Product','Warehouse','Supplier','Membership','PurchaseOrder','InventoryThreshold'] LOOP
  EXECUTE format('CREATE TRIGGER business_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION stockflow_business_audit()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['InventoryMovement','InventoryTransfer','PurchaseReceipt'] LOOP
  EXECUTE format('CREATE TRIGGER business_audit AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION stockflow_business_audit()',tab);
 END LOOP;
END $$;
CREATE FUNCTION stockflow_product_threshold_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD."quantityScale" IS DISTINCT FROM NEW."quantityScale" OR OLD."unitOfMeasure" IS DISTINCT FROM NEW."unitOfMeasure") AND EXISTS(SELECT 1 FROM "InventoryThreshold" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD.id) THEN RAISE EXCEPTION 'Product precision and unit are fixed by threshold configuration' USING ERRCODE='23514'; END IF;RETURN NEW;END $$;
CREATE TRIGGER product_threshold_guard BEFORE UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION stockflow_product_threshold_guard();
