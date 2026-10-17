import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { fail } from '../../http.js';
import { decimal, maxQuantity } from './decimal.js';

// The caller owns the transaction, ledger entry and command completion.
export async function creditBalance(
  tx: Prisma.TransactionClient,
  organizationId: string,
  productId: string,
  warehouseId: string,
  amount: bigint,
) {
  await tx.$executeRaw`INSERT INTO "InventoryBalance" (id,"organizationId","productId","warehouseId",quantity,version,"updatedAt") VALUES (${randomUUID()}::uuid,${organizationId}::uuid,${productId}::uuid,${warehouseId}::uuid,0,0,NOW()) ON CONFLICT ("organizationId","productId","warehouseId") DO NOTHING`;
  const rows = await tx.$queryRaw<
    { quantity: Prisma.Decimal; version: bigint }[]
  >`UPDATE "InventoryBalance" SET quantity=quantity+${decimal(amount)}::numeric,version=version+1,"updatedAt"=NOW() WHERE "organizationId"=${organizationId}::uuid AND "productId"=${productId}::uuid AND "warehouseId"=${warehouseId}::uuid AND quantity+${decimal(amount)}::numeric<=${decimal(maxQuantity)}::numeric RETURNING quantity,version`;
  return (
    rows[0] ?? fail(409, 'QUANTITY_OVERFLOW', 'Balance exceeds supported range')
  );
}
