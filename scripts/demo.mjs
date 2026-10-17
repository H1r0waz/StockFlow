import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  seedDemo,
  assertDemoTarget,
  DemoError,
} from '../apps/api/src/demo/seed.ts';

const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const pg = requireApi('pg');
const marker = 'StockFlow fictional demo v1';
if (existsSync('.env')) loadEnvFile('.env');

export function demoUrl(value) {
  const source = new URL(value);
  if (
    process.env.NODE_ENV === 'production' ||
    source.protocol !== 'postgresql:' ||
    source.hostname !== '127.0.0.1' ||
    source.port !== '55434' ||
    source.username !== 'stockflow' ||
    source.pathname !== '/stockflow_dev' ||
    source.search ||
    source.hash
  )
    throw new DemoError(
      'Demo requires this project dedicated local development connection.',
    );
  source.pathname = '/stockflow_demo';
  assertDemoTarget(source.toString());
  return source.toString();
}

async function main() {
  const action = process.argv[2];
  if (!['seed', 'reset', 'serve'].includes(action))
    throw new DemoError('Use demo:seed, demo:reset or demo:api.');
  const connection = demoUrl(process.env.DATABASE_URL);
  const adminUrl = new URL(connection);
  adminUrl.pathname = '/postgres';
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    // Serialize demo creation/reset across CLI processes on this local instance.
    await client.query('SELECT pg_advisory_lock(481111)');
    const found = await client.query(
      "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=$1",
      ['stockflow_demo'],
    );
    if (found.rowCount && found.rows[0].marker !== marker)
      throw new DemoError(
        'Existing stockflow_demo database is not marked as ours; refusing to modify it.',
      );
    if (action === 'serve') {
      if (!found.rowCount) throw new DemoError('Run demo:seed first.');
      await client.query('SELECT pg_advisory_unlock(481111)');
      console.log(
        'Starting local demo API with its isolated fictional database.',
      );
      const server = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/api/src/server.ts'],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            NODE_ENV: 'development',
            DATABASE_URL: connection,
            STOCKFLOW_DEMO: '1',
          },
        },
      );
      if (server.status !== 0)
        throw new DemoError('Demo API exited unsuccessfully.');
      return;
    }
    if (action === 'reset' && found.rowCount) {
      const active = await client.query(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        ['stockflow_demo'],
      );
      if (active.rows[0].count)
        throw new DemoError(
          'Stop the demo API and close demo database connections before reset.',
        );
      await client.query('DROP DATABASE stockflow_demo');
    }
    if (!found.rowCount || action === 'reset') {
      await client.query('CREATE DATABASE stockflow_demo');
      await client.query(
        "COMMENT ON DATABASE stockflow_demo IS 'StockFlow fictional demo v1'",
      );
    }
    const prismaCli = existsSync('node_modules/prisma/build/index.js')
      ? 'node_modules/prisma/build/index.js'
      : 'apps/api/node_modules/prisma/build/index.js';
    const migration = spawnSync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', 'apps/api/prisma.config.ts'],
      { stdio: 'inherit', env: { ...process.env, DATABASE_URL: connection } },
    );
    if (migration.status !== 0) throw new DemoError('Demo migration failed.');
    console.log(JSON.stringify(await seedDemo(connection), null, 2));
    console.log(
      'Fictional demo ready. Public demo accounts are documented in docs/DEMO.md.',
    );
  } finally {
    await client.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof DemoError
      ? error.message
      : 'Demo command failed. Verify that the dedicated local PostgreSQL instance is running. Database diagnostics are suppressed to protect credentials.',
  );
  process.exitCode = 1;
});
