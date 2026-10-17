import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';

export function proxyHops(value = process.env.TRUST_PROXY_HOPS) {
  if (value === undefined || value === '0') return false;
  if (value === '1') return 1;
  throw Error('TRUST_PROXY_HOPS must be unset, 0 or 1');
}

export function observeRequests(app: Express, enabled: boolean) {
  app.use((request, response, next) => {
    const requestId = randomUUID();
    response.setHeader('X-Request-ID', requestId);
    const started = performance.now();
    if (enabled)
      response.once('finish', () => {
        const route = request.route?.path;
        console.info(
          JSON.stringify({
            event: 'http_request',
            requestId,
            method: request.method,
            route: typeof route === 'string' ? route : 'unmatched',
            status: response.statusCode,
            durationMs: Math.round(performance.now() - started),
            ...(response.locals.failure
              ? { failure: response.locals.failure }
              : {}),
          }),
        );
      });
    next();
  });
}

export function serveWeb(app: Express, directory?: string) {
  if (directory === undefined && process.env.SERVE_WEB !== 'true') return;
  const root =
    directory ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const index = resolve(root, 'index.html');
  if (!existsSync(index)) throw Error('SERVE_WEB requires a built frontend');
  const staticFiles = express.static(root, {
    index: false,
    dotfiles: 'deny',
    redirect: false,
  });
  const apiPath = (path: string) =>
    path.toLowerCase() === '/api' || path.toLowerCase().startsWith('/api/');
  const frontendHeaders = (
    _request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ) => {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  };
  app.use((request, response, next) => {
    if (apiPath(request.path)) return next();
    return frontendHeaders(request, response, next);
  });
  app.use((request, response, next) => {
    if (apiPath(request.path)) return next();
    return staticFiles(request, response, next);
  });
  app.get('/{*navigation}', (request, response, next) => {
    if (
      apiPath(request.path) ||
      request.path.startsWith('/assets/') ||
      request.path.includes('.') ||
      !request.accepts('html')
    )
      return next();
    response.sendFile(index);
  });
}
