import { pagination, page } from '../../pagination.js';
import type { Express, Request, Response } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { body, email, fail, role, text, validId } from '../../http.js';
import type { TenantContext } from '../../tenant.js';

export function registerOrganizationRoutes(
  app: Express,
  { db, tenant, writeTenant }: TenantContext & { db: () => PrismaClient },
) {
  app.get('/api/organizations/:organizationId', async (request, response) => {
    const context = await tenant(request);
    response.json({
      organization: {
        id: context.session.organization.id,
        name: context.session.organization.name,
      },
    });
  });
  app.patch('/api/organizations/:organizationId', async (request, response) => {
    const input = body(request, ['name']);
    const name = text(input, 'name');
    const organization = await writeTenant(request, async (tx, actor) => {
      if (actor.role === 'MEMBER')
        return fail(403, 'FORBIDDEN', 'Insufficient permission');
      return tx.organization.update({
        where: { id: actor.organizationId },
        data: { name },
        select: { id: true, name: true },
      });
    });
    response.json({ organization });
  });
  app.get(
    '/api/organizations/:organizationId/memberships',
    async (request, response) => {
      const context = await tenant(request);
      const { limit, offset } = pagination(request);
      const memberships = await db().membership.findMany({
        take: limit + 1,
        skip: offset,
        where: { organizationId: context.session.organizationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          role: true,
          user: { select: { id: true, email: true, displayName: true } },
        },
      });
      response.json({
        memberships: memberships.slice(0, limit),
        ...page(memberships, limit, offset),
      });
    },
  );
  app.post(
    '/api/organizations/:organizationId/memberships',
    async (request, response) => {
      const input = body(request, ['email', 'role']);
      const normalizedEmail = email(input);
      const nextRole = role(input);
      const membership = await writeTenant(request, async (tx, actor) => {
        if (
          actor.role === 'MEMBER' ||
          (actor.role === 'ADMIN' && nextRole !== 'MEMBER')
        )
          return fail(403, 'FORBIDDEN', 'Insufficient permission');
        const user = await tx.user.findUnique({
          where: { email: normalizedEmail },
        });
        if (!user) return fail(404, 'NOT_FOUND', 'Account unavailable');
        return tx.membership.create({
          data: {
            organizationId: actor.organizationId,
            userId: user.id,
            role: nextRole,
          },
          select: {
            id: true,
            role: true,
            user: { select: { id: true, email: true, displayName: true } },
          },
        });
      });
      response.status(201).json({ membership });
    },
  );

  async function changeMembership(
    request: Request,
    response: Response,
    remove: boolean,
  ) {
    const nextRole = remove ? undefined : role(body(request, ['role']));
    const targetId = request.params.membershipId;
    const result = await writeTenant(request, async (tx, actor) => {
      if (typeof targetId !== 'string' || !validId(targetId))
        return fail(404, 'NOT_FOUND', 'Resource not found');
      const target = await tx.membership.findFirst({
        where: { id: targetId, organizationId: actor.organizationId },
      });
      if (!target) return fail(404, 'NOT_FOUND', 'Resource not found');
      if (
        actor.role === 'MEMBER' ||
        (actor.role === 'ADMIN' &&
          (target.role !== 'MEMBER' || (!remove && nextRole !== 'MEMBER')))
      ) {
        return fail(403, 'FORBIDDEN', 'Insufficient permission');
      }
      if (target.role === 'OWNER' && (remove || nextRole !== 'OWNER')) {
        const owners = await tx.membership.count({
          where: { organizationId: actor.organizationId, role: 'OWNER' },
        });
        if (owners <= 1)
          return fail(
            409,
            'LAST_OWNER',
            'An organization must retain an owner',
          );
      }
      if (remove) await tx.membership.delete({ where: { id: target.id } });
      else
        await tx.membership.update({
          where: { id: target.id },
          data: { role: nextRole! },
        });
      if (remove || target.role !== nextRole)
        await tx.session.deleteMany({
          where: {
            organizationId: actor.organizationId,
            userId: target.userId,
          },
        });
      return { id: target.id, role: nextRole };
    });
    if (remove) response.status(204).end();
    else response.json({ membership: result });
  }
  app.patch(
    '/api/organizations/:organizationId/memberships/:membershipId',
    (request, response) => changeMembership(request, response, false),
  );
  app.delete(
    '/api/organizations/:organizationId/memberships/:membershipId',
    (request, response) => changeMembership(request, response, true),
  );
}
