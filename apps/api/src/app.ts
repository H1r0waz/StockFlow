import { registerOperationsRoutes } from './modules/operations/routes.js';
import {
  registerImportRoutes,
  type ImportHooks,
} from './modules/imports/routes.js';
import { registerReportRoutes } from './modules/reports/routes.js';
import express, { type ErrorRequestHandler, type Request } from 'express';
import type { PrismaClient, Prisma } from './generated/prisma/client.js';
import { getDatabase } from './database.js';
import { observeRequests, proxyHops, serveWeb } from './deployment.js';
import { hashPassword, verifyPassword } from './modules/auth/passwords.js';
import {
  AuthLimiter,
  clearSessionCookie,
  digestToken,
  equalToken,
  opaqueToken,
  presentedToken,
  sessionDurationMs,
  setSessionCookie,
} from './modules/auth/security.js';

import {
  body,
  email,
  fail,
  HttpError,
  password,
  text,
  validId,
} from './http.js';
import { registerOrganizationRoutes } from './modules/organizations/routes.js';
import { createTenantContext } from './tenant.js';
import { page, pagination } from './pagination.js';
import {
  configuredOrigin,
  operationLimiter,
  RateLimitError,
  securityHeaders,
  type OperationRateLimits,
} from './http-security.js';
import { registerCatalogRoutes } from './modules/catalog/routes.js';
import {
  registerInventoryRoutes,
  type InventoryHooks,
} from './modules/inventory/routes.js';
import {
  registerPurchasingRoutes,
  type PurchasingHooks,
} from './modules/purchasing/routes.js';
type Database = Prisma.TransactionClient;
export interface AppOptions {
  prisma?: PrismaClient;
  now?: () => Date;
  rateLimit?: { windowMs?: number; max?: number };
  operationRateLimits?: OperationRateLimits;
  allowedOrigin?: string;
  secureCookies?: boolean;
  inventoryHooks?: InventoryHooks;
  purchasingHooks?: PurchasingHooks;
  importHooks?: ImportHooks;
  webDirectory?: string;
  publicDemo?: boolean;
}

const publicUser = (user: {
  id: string;
  email: string;
  displayName: string;
}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
});

export function createApp(options: AppOptions = {}) {
  const app = express();
  const now = options.now ?? (() => new Date());
  const db = () => options.prisma ?? getDatabase();
  const production = process.env.NODE_ENV === 'production';
  const allowedOrigin = configuredOrigin(
    options.allowedOrigin ?? process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173',
    production,
  );
  if (production && options.secureCookies === false)
    throw Error('Production session cookies must be Secure');
  const secure = production || options.secureCookies === true;
  const limitOperation = operationLimiter(options.operationRateLimits);
  const limiter = new AuthLimiter(
    options.rateLimit?.windowMs ?? 15 * 60 * 1000,
    options.rateLimit?.max ?? 20,
  );
  app.disable('x-powered-by');
  app.set('trust proxy', proxyHops());
  observeRequests(app, production);
  app.use((_request, response, next) => {
    securityHeaders(_request, response, production);
    next();
  });
  app.use(
    '/api/organizations/:organizationId/imports',
    express.json({ limit: '1mb' }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use((request, _response, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin !== allowedOrigin
    ) {
      return next(
        new HttpError(403, 'ORIGIN_REJECTED', 'Request origin rejected'),
      );
    }
    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'stockflow-api' });
  });
  app.get('/api/ready', async (_request, response) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        db().$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
            await tx.$queryRaw`SELECT 1`;
          },
          { maxWait: 1000, timeout: 2500 },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error('Readiness deadline')), 3000);
          timer.unref();
        }),
      ]);
      response.json({ status: 'ready' });
    } catch {
      response.locals.failure = 'database_unavailable';
      response.status(503).json({ status: 'unavailable' });
    } finally {
      clearTimeout(timer);
    }
  });

  async function auth(request: Request, mutation = false) {
    const token = presentedToken(request);
    if (!token) return fail(401, 'UNAUTHENTICATED', 'Authentication required');
    const session = await db().session.findUnique({
      where: { tokenHash: digestToken(token) },
      include: { user: true, organization: true },
    });
    if (!session || session.expiresAt <= now()) {
      if (session) await db().session.deleteMany({ where: { id: session.id } });
      return fail(401, 'UNAUTHENTICATED', 'Authentication required');
    }
    const membership = await db().membership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: session.organizationId,
          userId: session.userId,
        },
      },
    });
    if (!membership)
      return fail(401, 'UNAUTHENTICATED', 'Authentication required');
    if (
      mutation &&
      !equalToken(request.get('X-CSRF-Token'), session.csrfToken)
    ) {
      return fail(403, 'CSRF_REJECTED', 'CSRF token rejected');
    }
    if (request.method)
      limitOperation(
        request,
        session.userId,
        session.organizationId,
        mutation,
        now().getTime(),
      );
    return { session, membership };
  }

  const sessionDto = (context: Awaited<ReturnType<typeof auth>>) => ({
    user: publicUser(context.session.user),
    organization: {
      id: context.session.organization.id,
      name: context.session.organization.name,
    },
    membership: { id: context.membership.id, role: context.membership.role },
    csrfToken: context.session.csrfToken,
  });

  async function createSession(
    tx: Database,
    request: Request,
    userId: string,
    organizationId: string,
  ) {
    const previous = presentedToken(request);
    if (previous)
      await tx.session.deleteMany({
        where: { tokenHash: digestToken(previous) },
      });
    const token = opaqueToken();
    const session = await tx.session.create({
      data: {
        tokenHash: digestToken(token),
        csrfToken: opaqueToken(),
        userId,
        organizationId,
        expiresAt: new Date(now().getTime() + sessionDurationMs),
      },
    });
    return { token, session };
  }

  function limit(request: Request, identity: string) {
    if (
      !limiter.allow(
        [`ip:${request.ip ?? 'unknown'}`, `identity:${digestToken(identity)}`],
        now().getTime(),
      )
    ) {
      throw new RateLimitError(
        Math.ceil((options.rateLimit?.windowMs ?? 900_000) / 1000),
        'Too many authentication attempts',
      );
    }
  }

  app.post('/api/auth/register', async (request, response) => {
    if (options.publicDemo ?? process.env.PUBLIC_DEMO === 'true')
      return fail(
        403,
        'REGISTRATION_DISABLED',
        'Registration is disabled for this public demo',
      );
    const input = body(request, [
      'email',
      'password',
      'displayName',
      'organizationName',
    ]);
    const normalizedEmail = email(input);
    limit(request, normalizedEmail);
    const secret = password(input, true);
    const displayName = text(input, 'displayName');
    const name = text(input, 'organizationName');
    const passwordHash = await hashPassword(secret);
    const result = await db().$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: normalizedEmail, displayName, passwordHash },
      });
      const organization = await tx.organization.create({ data: { name } });
      const membership = await tx.membership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: 'OWNER',
        },
      });
      const issued = await createSession(tx, request, user.id, organization.id);
      return { user, organization, membership, ...issued };
    });
    setSessionCookie(response, result.token, secure);
    response.status(201).json({
      user: publicUser(result.user),
      organization: {
        id: result.organization.id,
        name: result.organization.name,
      },
      membership: { id: result.membership.id, role: result.membership.role },
      csrfToken: result.session.csrfToken,
    });
  });

  app.post('/api/auth/login', async (request, response) => {
    const input = body(request, ['email', 'password', 'organizationId']);
    const normalizedEmail = email(input);
    limit(request, normalizedEmail);
    const secret = password(input, false);
    const user = await db().user.findUnique({
      where: { email: normalizedEmail },
    });
    const verified = await verifyPassword(secret, user?.passwordHash);
    if (!user || !verified)
      return fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    const selectedOrganization = input.organizationId;
    if (
      selectedOrganization !== undefined &&
      (typeof selectedOrganization !== 'string' ||
        !validId(selectedOrganization))
    ) {
      return fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    const membership = await db().membership.findFirst({
      where: {
        userId: user.id,
        ...(typeof selectedOrganization === 'string'
          ? { organizationId: selectedOrganization }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!membership)
      return fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    const issued = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${membership.organizationId}::uuid FOR UPDATE`;
      const current = await tx.membership.findUnique({
        where: { id: membership.id },
      });
      if (!current)
        return fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      return createSession(tx, request, user.id, membership.organizationId);
    });
    setSessionCookie(response, issued.token, secure);
    response.json(sessionDto(await authWithToken(issued.token)));
  });

  // Reuse the same session/membership resolution for issued session responses.
  async function authWithToken(token: string) {
    return auth({
      headers: { cookie: `stockflow_session=${token}` },
    } as Request);
  }

  app.get('/api/auth/session', async (request, response) => {
    response.json(sessionDto(await auth(request)));
  });
  app.get('/api/auth/organizations', async (request, response) => {
    const context = await auth(request);
    const { limit, offset } = pagination(request);
    const memberships = await db().membership.findMany({
      where: { userId: context.session.userId },
      select: {
        role: true,
        organization: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      skip: offset,
    });
    response.json({
      organizations: memberships
        .slice(0, limit)
        .map(({ role, organization }) => ({
          ...organization,
          role,
        })),
      ...page(memberships, limit, offset),
    });
  });
  app.post('/api/auth/logout', async (request, response) => {
    const context = await auth(request, true);
    await db().session.deleteMany({ where: { id: context.session.id } });
    clearSessionCookie(response, secure);
    response.status(204).end();
  });

  const tenantContext = createTenantContext({ db, now, auth });
  registerOrganizationRoutes(app, { db, ...tenantContext });
  registerPurchasingRoutes(app, {
    db,
    ...tenantContext,
    hooks: options.purchasingHooks ?? {},
  });
  registerCatalogRoutes(app, { db, ...tenantContext });
  registerOperationsRoutes(app, { db, now, ...tenantContext });
  registerImportRoutes(app, {
    db,
    now,
    ...tenantContext,
    hooks: options.importHooks ?? {},
  });
  registerReportRoutes(app, { db, ...tenantContext });
  registerInventoryRoutes(app, {
    db,
    now,
    ...tenantContext,
    ...(options.inventoryHooks ? { hooks: options.inventoryHooks } : {}),
  });

  serveWeb(app, options.webDirectory);
  app.use((_request, response) =>
    response
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof HttpError) {
      if (error instanceof RateLimitError)
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
      response
        .status(error.status)
        .json({ error: { code: error.code, message: error.message } });
      return;
    }
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? error.status
        : undefined;
    if (status === 400 || status === 413) {
      response.status(status).json({
        error: {
          code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
          message: 'Invalid request body',
        },
      });
      return;
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      response.status(409).json({
        error: { code: 'CONFLICT', message: 'Unable to complete request' },
      });
      return;
    }
    response.locals.failure = 'internal_error';
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' },
    });
  };
  app.use(handleError);
  return app;
}

export const app = createApp();
