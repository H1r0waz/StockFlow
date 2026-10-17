CREATE TABLE "ImportJob" (
 "id" UUID NOT NULL PRIMARY KEY,
 "organizationId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "actorId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "type" VARCHAR(32) NOT NULL CHECK ("type" IN ('products','suppliers')),
 "status" VARCHAR(32) NOT NULL CHECK ("status" = 'CONFIRMED'),
 "csvHash" CHAR(64) NOT NULL,
 "totalRows" INTEGER NOT NULL CHECK ("totalRows" BETWEEN 1 AND 2000),
 "validRows" INTEGER NOT NULL,
 "invalidRows" INTEGER NOT NULL CHECK ("invalidRows" = 0),
 "createdRows" INTEGER NOT NULL CHECK ("createdRows" >= 0),
 "updatedRows" INTEGER NOT NULL CHECK ("updatedRows" >= 0),
 "skippedRows" INTEGER NOT NULL CHECK ("skippedRows" >= 0),
 "failedRows" INTEGER NOT NULL CHECK ("failedRows" = 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "confirmedAt" TIMESTAMPTZ(3) NOT NULL,
 CHECK ("validRows" = "totalRows" AND "createdRows" + "updatedRows" + "skippedRows" = "totalRows")
);
CREATE UNIQUE INDEX "ImportJob_organizationId_id_key" ON "ImportJob"("organizationId","id");
CREATE INDEX "ImportJob_organizationId_createdAt_id_idx" ON "ImportJob"("organizationId","createdAt","id");
CREATE FUNCTION stockflow_import_job_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Import jobs are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER import_job_immutable BEFORE UPDATE OR DELETE ON "ImportJob" FOR EACH ROW EXECUTE FUNCTION stockflow_import_job_immutable();
