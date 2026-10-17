-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('RECEIPT', 'ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

-- CreateTable
CREATE TABLE "InventoryBalance" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "previousBalance" DECIMAL(20,6) NOT NULL,
    "resultingBalance" DECIMAL(20,6) NOT NULL,
    "balanceVersion" BIGINT NOT NULL,
    "actorId" UUID NOT NULL,
    "commandId" UUID NOT NULL,
    "reason" VARCHAR(500),
    "referenceType" VARCHAR(64),
    "referenceId" VARCHAR(128),
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "correlationKey" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCommand" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "actorId" UUID NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBalance_organizationId_productId_warehouseId_key" ON "InventoryBalance"("organizationId", "productId", "warehouseId");

-- CreateIndex
CREATE INDEX "InventoryMovement_organizationId_createdAt_id_idx" ON "InventoryMovement"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_organizationId_productId_warehouseId_bala_key" ON "InventoryMovement"("organizationId", "productId", "warehouseId", "balanceVersion");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_commandId_key" ON "InventoryMovement"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_organizationId_commandId_key" ON "InventoryMovement"("organizationId", "commandId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCommand_organizationId_type_key_key" ON "InventoryCommand"("organizationId", "type", "key");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCommand_organizationId_id_key" ON "InventoryCommand"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_warehouseId_fkey" FOREIGN KEY ("organizationId", "warehouseId") REFERENCES "Warehouse"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_warehouseId_fkey" FOREIGN KEY ("organizationId", "warehouseId") REFERENCES "Warehouse"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_productId_warehouseId_fkey" FOREIGN KEY ("organizationId", "productId", "warehouseId") REFERENCES "InventoryBalance"("organizationId", "productId", "warehouseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_commandId_fkey" FOREIGN KEY ("organizationId", "commandId") REFERENCES "InventoryCommand"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCommand" ADD CONSTRAINT "InventoryCommand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCommand" ADD CONSTRAINT "InventoryCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryBalance" ADD CONSTRAINT "balance_nonnegative" CHECK (quantity >= 0 AND version >= 0);
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "movement_structure" CHECK (
 quantity > 0 AND "previousBalance" >= 0 AND "resultingBalance" >= 0 AND "balanceVersion" > 0 AND
 ((type IN ('RECEIPT','ADJUSTMENT_IN') AND "resultingBalance"="previousBalance"+quantity) OR
  (type IN ('ISSUE','ADJUSTMENT_OUT') AND "resultingBalance"="previousBalance"-quantity)) AND
 (type NOT IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT') OR length(btrim(reason))>0 AND reason IS NOT NULL)
);
CREATE FUNCTION stockflow_immutable_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Inventory history is append only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER inventory_movement_immutable BEFORE UPDATE OR DELETE ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION stockflow_immutable_movement();

CREATE FUNCTION stockflow_balance_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b "InventoryBalance"%ROWTYPE; m "InventoryMovement"%ROWTYPE;
BEGIN
 SELECT * INTO b FROM "InventoryBalance" WHERE "organizationId"=NEW."organizationId" AND "productId"=NEW."productId" AND "warehouseId"=NEW."warehouseId";
 SELECT * INTO m FROM "InventoryMovement" WHERE "organizationId"=NEW."organizationId" AND "productId"=NEW."productId" AND "warehouseId"=NEW."warehouseId" ORDER BY "balanceVersion" DESC LIMIT 1;
 IF b.id IS NULL OR (m.id IS NULL AND (b.quantity<>0 OR b.version<>0)) OR (m.id IS NOT NULL AND (b.version<>m."balanceVersion" OR b.quantity<>m."resultingBalance")) THEN
  RAISE EXCEPTION 'Balance and ledger must commit together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_balance_consistency AFTER INSERT OR UPDATE ON "InventoryBalance" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockflow_balance_consistency();
CREATE CONSTRAINT TRIGGER inventory_movement_balance_consistency AFTER INSERT ON "InventoryMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockflow_balance_consistency();

CREATE FUNCTION stockflow_movement_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior numeric(20,6); c "InventoryCommand"%ROWTYPE; scale integer;
BEGIN
 SELECT "quantityScale" INTO scale FROM "Product" WHERE id=NEW."productId" AND "organizationId"=NEW."organizationId";
 IF NEW.quantity<>trunc(NEW.quantity,scale) THEN RAISE EXCEPTION 'Product precision exceeded' USING ERRCODE='23514'; END IF;
 IF NEW."balanceVersion"=1 THEN prior:=0; ELSE
  SELECT "resultingBalance" INTO prior FROM "InventoryMovement" WHERE "organizationId"=NEW."organizationId" AND "productId"=NEW."productId" AND "warehouseId"=NEW."warehouseId" AND "balanceVersion"=NEW."balanceVersion"-1;
 END IF;
 IF prior IS NULL OR prior<>NEW."previousBalance" THEN RAISE EXCEPTION 'Broken inventory chain' USING ERRCODE='23514'; END IF;
 SELECT * INTO c FROM "InventoryCommand" WHERE id=NEW."commandId" AND "organizationId"=NEW."organizationId";
 IF c.id IS NULL OR c.type<>NEW.type OR c."actorId"<>NEW."actorId" OR c.key<>NEW."idempotencyKey" THEN RAISE EXCEPTION 'Command mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_movement_chain BEFORE INSERT ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION stockflow_movement_chain();

CREATE FUNCTION stockflow_command_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "InventoryCommand"%ROWTYPE;
BEGIN
 SELECT * INTO c FROM "InventoryCommand" WHERE id=NEW.id;
 IF c.response IS NULL OR jsonb_typeof(c.response)<>'object' OR NOT EXISTS (SELECT 1 FROM "InventoryMovement" WHERE "commandId"=c.id) THEN
 RAISE EXCEPTION 'An inventory command must commit its result and movement' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_command_complete AFTER INSERT OR UPDATE ON "InventoryCommand" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockflow_command_complete();
CREATE FUNCTION stockflow_command_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.response IS NOT NULL OR NEW.id<>OLD.id OR NEW."organizationId"<>OLD."organizationId" OR NEW.type<>OLD.type OR NEW.key<>OLD.key OR NEW."payloadHash"<>OLD."payloadHash" OR NEW."actorId"<>OLD."actorId" OR NEW."createdAt"<>OLD."createdAt" THEN
 RAISE EXCEPTION 'Committed inventory command is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_command_immutable BEFORE UPDATE OR DELETE ON "InventoryCommand" FOR EACH ROW EXECUTE FUNCTION stockflow_command_immutable();
