export const publicDemoMarker = 'StockFlow public fictional demo v1';
export type PublicDemoTarget = {
  host?: string;
  database?: string;
  confirmation?: string;
};

export function assertPublicDemoMarker(marker: string | null | undefined) {
  if (marker !== publicDemoMarker)
    throw new Error(
      'Public demo database marker is absent or incorrect; refusing initialization.',
    );
}

/** No fallback to DATABASE_URL or local targets: callers pin the new database. */
export function assertPublicDemoTarget(
  value: string,
  target: PublicDemoTarget,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid public demo target.');
  }
  const keys = [...url.searchParams.keys()];
  if (
    target.confirmation !== 'SC-PROJ-STOCKFLOW' ||
    !target.host ||
    !target.database ||
    !/^[a-zA-Z0-9_-]+$/.test(target.database) ||
    [
      'stockflow_dev',
      'stockflow_test',
      'stockflow_demo',
      'postgres',
      'template0',
      'template1',
    ].includes(target.database) ||
    url.protocol !== 'postgresql:' ||
    !url.hostname.includes('.') ||
    isIP(url.hostname) !== 0 ||
    url.hostname.endsWith('.local') ||
    url.hostname.endsWith('.localhost') ||
    url.hostname !== target.host ||
    decodeURIComponent(url.pathname) !== `/${target.database}` ||
    !url.username ||
    !url.password ||
    decodeURIComponent(url.username) === 'stockflow_runtime' ||
    (url.port !== '' && url.port !== '5432') ||
    url.hash ||
    !['require', 'verify-full'].includes(
      url.searchParams.get('sslmode') ?? '',
    ) ||
    keys.some((key) => !['sslmode', 'channel_binding'].includes(key)) ||
    keys.length !== new Set(keys).size ||
    (url.searchParams.has('channel_binding') &&
      url.searchParams.get('channel_binding') !== 'require')
  )
    throw new Error(
      'Public demo requires explicit consent, an exact cloud host/database and TLS.',
    );
}
import { isIP } from 'node:net';
