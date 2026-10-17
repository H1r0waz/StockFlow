-- CreateEnum
CREATE TYPE "InventoryCommandType" AS ENUM ('RECEIPT', 'ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryMovementType" ADD VALUE 'TRANSFER_IN';
ALTER TYPE "InventoryMovementType" ADD VALUE 'TRANSFER_OUT';

-- DropIndex
DROP INDEX "InventoryMovement_commandId_key";

-- DropIndex
DROP INDEX "InventoryMovement_organizationId_commandId_key";

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "transferId" UUID;

-- AlterTable
DROP INDEX "InventoryCommand_organizationId_type_key_key";
ALTER TABLE "InventoryCommand" ALTER COLUMN "type" TYPE "InventoryCommandType" USING ("type"::text::"InventoryCommandType");

-- CreateTable
CREATE TABLE "InventoryTransfer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sourceWarehouseId" UUID NOT NULL,
    "destinationWarehouseId" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "actorId" UUID NOT NULL,
    "commandId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "reason" VARCHAR(500),
    "referenceType" VARCHAR(64),
    "referenceId" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryTransfer_organizationId_createdAt_id_idx" ON "InventoryTransfer"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransfer_organizationId_id_key" ON "InventoryTransfer"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransfer_commandId_key" ON "InventoryTransfer"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransfer_organizationId_commandId_key" ON "InventoryTransfer"("organizationId", "commandId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_commandId_type_key" ON "InventoryMovement"("commandId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCommand_organizationId_type_key_key" ON "InventoryCommand"("organizationId", "type", "key");

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_transferId_fkey" FOREIGN KEY ("organizationId", "transferId") REFERENCES "InventoryTransfer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_organizationId_sourceWarehouseId_fkey" FOREIGN KEY ("organizationId", "sourceWarehouseId") REFERENCES "Warehouse"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_organizationId_destinationWarehouseId_fkey" FOREIGN KEY ("organizationId", "destinationWarehouseId") REFERENCES "Warehouse"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_organizationId_commandId_fkey" FOREIGN KEY ("organizationId", "commandId") REFERENCES "InventoryCommand"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-row protections extend, rather than replace, the Phase 4 ledger guarantees.
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT transfer_structure CHECK (
 quantity>0 AND "sourceWarehouseId"<>"destinationWarehouseId"
);
ALTER TABLE "InventoryMovement" DROP CONSTRAINT movement_structure;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT movement_structure CHECK (
 quantity>0 AND "previousBalance">=0 AND "resultingBalance">=0 AND "balanceVersion">0 AND
 ((type::text IN ('RECEIPT','ADJUSTMENT_IN','TRANSFER_IN') AND "resultingBalance"="previousBalance"+quantity) OR
 (type::text IN ('ISSUE','ADJUSTMENT_OUT','TRANSFER_OUT') AND "resultingBalance"="previousBalance"-quantity)) AND
 (type::text NOT IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT') OR reason IS NOT NULL AND length(btrim(reason))>0) AND
 ((type::text IN ('TRANSFER_IN','TRANSFER_OUT'))=("transferId" IS NOT NULL))
);
CREATE TRIGGER inventory_transfer_immutable BEFORE UPDATE OR DELETE ON "InventoryTransfer" FOR EACH ROW EXECUTE FUNCTION stockflow_immutable_movement();

CREATE OR REPLACE FUNCTION stockflow_movement_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior numeric(20,6); c "InventoryCommand"%ROWTYPE; scale integer;
BEGIN
 SELECT "quantityScale" INTO scale FROM "Product" WHERE id=NEW."productId" AND "organizationId"=NEW."organizationId";
 IF NEW.quantity<>trunc(NEW.quantity,scale) THEN RAISE EXCEPTION 'Product precision exceeded' USING ERRCODE='23514'; END IF;
 IF NEW."balanceVersion"=1 THEN prior:=0; ELSE
  SELECT "resultingBalance" INTO prior FROM "InventoryMovement" WHERE "organizationId"=NEW."organizationId" AND "productId"=NEW."productId" AND "warehouseId"=NEW."warehouseId" AND "balanceVersion"=NEW."balanceVersion"-1;
 END IF;
 IF prior IS NULL OR prior<>NEW."previousBalance" THEN RAISE EXCEPTION 'Broken inventory chain' USING ERRCODE='23514'; END IF;
 SELECT * INTO c FROM "InventoryCommand" WHERE id=NEW."commandId" AND "organizationId"=NEW."organizationId";
 IF c.id IS NULL OR c."actorId"<>NEW."actorId" OR c.key<>NEW."idempotencyKey" OR
  (c.type::text='TRANSFER' AND NEW.type::text NOT IN ('TRANSFER_IN','TRANSFER_OUT')) OR
  (c.type::text<>'TRANSFER' AND c.type::text<>NEW.type::text) THEN
  RAISE EXCEPTION 'Command mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION stockflow_command_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "InventoryCommand"%ROWTYPE; movement_count integer;
BEGIN
 SELECT * INTO c FROM "InventoryCommand" WHERE id=NEW.id;
 SELECT count(*) INTO movement_count FROM "InventoryMovement" WHERE "commandId"=c.id;
 IF c.response IS NULL OR jsonb_typeof(c.response)<>'object' OR
  (c.type::text='TRANSFER' AND (movement_count<>2 OR NOT EXISTS (SELECT 1 FROM "InventoryTransfer" WHERE "commandId"=c.id))) OR
  (c.type::text<>'TRANSFER' AND (movement_count<>1 OR EXISTS (SELECT 1 FROM "InventoryTransfer" WHERE "commandId"=c.id))) THEN
  RAISE EXCEPTION 'An inventory command must commit its complete result and ledger' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION stockflow_transfer_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer_id uuid; t "InventoryTransfer"%ROWTYPE; c "InventoryCommand"%ROWTYPE; movement_count integer; valid_count integer;
BEGIN
 IF TG_TABLE_NAME='InventoryTransfer' THEN transfer_id:=NEW.id; ELSE transfer_id:=NEW."transferId"; END IF;
 IF transfer_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO t FROM "InventoryTransfer" WHERE id=transfer_id;
 SELECT * INTO c FROM "InventoryCommand" WHERE id=t."commandId";
 SELECT count(*), count(*) FILTER (WHERE
   "organizationId"=t."organizationId" AND "productId"=t."productId" AND quantity=t.quantity AND
   "actorId"=t."actorId" AND "commandId"=t."commandId" AND "idempotencyKey"=t."idempotencyKey" AND "correlationKey"=t.id::text AND
   reason IS NOT DISTINCT FROM t.reason AND "referenceType" IS NOT DISTINCT FROM t."referenceType" AND "referenceId" IS NOT DISTINCT FROM t."referenceId" AND
   ((type::text='TRANSFER_OUT' AND "warehouseId"=t."sourceWarehouseId") OR (type::text='TRANSFER_IN' AND "warehouseId"=t."destinationWarehouseId"))
 ) INTO movement_count,valid_count FROM "InventoryMovement" WHERE "transferId"=transfer_id;
 IF t.id IS NULL OR c.id IS NULL OR c.type::text<>'TRANSFER' OR c."organizationId"<>t."organizationId" OR c."actorId"<>t."actorId" OR c.key<>t."idempotencyKey" OR movement_count<>2 OR valid_count<>2 THEN
  RAISE EXCEPTION 'A transfer must commit its matching out and in ledger pair' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_transfer_complete AFTER INSERT ON "InventoryTransfer" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockflow_transfer_complete();
CREATE CONSTRAINT TRIGGER inventory_transfer_movement_complete AFTER INSERT ON "InventoryMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockflow_transfer_complete();
