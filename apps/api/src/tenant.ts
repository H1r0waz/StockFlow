import type { Request } from 'express';
import type {
  Prisma,
  PrismaClient,
  Membership,
} from './generated/prisma/client.js';
import { fail, type Role } from './http.js';
type Database = Prisma.TransactionClient;
export type AuthContext = {
  session: Prisma.SessionGetPayload<{
    include: { user: true; organization: true };
  }>;
  membership: Membership;
};
interface Dependencies {
  db: () => PrismaClient;
  now: () => Date;
  auth: (request: Request, mutation?: boolean) => Promise<AuthContext>;
}

export function createTenantContext({ db, now, auth }: Dependencies) {
  async function tenant(request: Request, mutation = false) {
    const context = await auth(request, mutation);
    const organizationId = request.params.organizationId;
    if (
      typeof organizationId !== 'string' ||
      organizationId !== context.session.organizationId
    ) {
      return fail(404, 'NOT_FOUND', 'Resource not found');
    }
    return context;
  }

  async function writeTenant<T>(
    request: Request,
    action: (
      tx: Database,
      actor: { id: string; userId: string; organizationId: string; role: Role },
    ) => Promise<T>,
    options: { timeout?: number } = {},
  ) {
    const context = await tenant(request, true);
    return db().$transaction(async (tx) => {
      // One organization row serializes membership changes and last-owner checks.
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${context.session.organizationId}::uuid FOR UPDATE`;
      const session = await tx.session.findUnique({
        where: { id: context.session.id },
      });
      const actor = await tx.membership.findUnique({
        where: { id: context.membership.id },
      });
      if (!actor || !session || session.expiresAt <= now())
        return fail(401, 'UNAUTHENTICATED', 'Authentication required');
      await tx.$queryRaw`SELECT set_config('stockflow.actor_id', ${actor.userId}, true)`;
      const correlation = request.get('Idempotency-Key');
      if (correlation && /^[A-Za-z0-9._:-]{1,128}$/.test(correlation))
        await tx.$queryRaw`SELECT set_config('stockflow.correlation_key',${correlation},true)`;
      return action(tx, actor);
    }, options);
  }

  return { tenant, writeTenant };
}
export type TenantContext = ReturnType<typeof createTenantContext>;
