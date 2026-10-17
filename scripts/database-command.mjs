import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const apiRequire = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const pg = apiRequire('pg');

if (existsSync('.env')) loadEnvFile('.env');
const action = process.argv[2];
const prismaCli = existsSync('node_modules/prisma/build/index.js')
  ? 'node_modules/prisma/build/index.js'
  : 'apps/api/node_modules/prisma/build/index.js';
function localUrl(value, expected) {
  if (!value) throw new Error(`${expected} database URL is required`);
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55434' ||
    url.pathname !== `/${expected}` ||
    url.username !== 'stockflow'
  ) {
    throw new Error(
      'Refusing database command outside the dedicated StockFlow local instance',
    );
  }
  return value;
}
const dev = localUrl(process.env.DATABASE_URL, 'stockflow_dev');
const test = localUrl(process.env.TEST_DATABASE_URL, 'stockflow_test');
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.error || result.status !== 0)
    throw new Error('Database command failed; inspect preceding diagnostics');
}
if (action === 'create') {
  const admin = new URL(dev);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    for (const name of ['stockflow_dev', 'stockflow_test']) {
      const found = await client.query(
        'SELECT 1 FROM pg_database WHERE datname=$1',
        [name],
      );
      if (!found.rowCount) await client.query(`CREATE DATABASE ${name}`);
    }
    console.log('Dedicated development and test databases ready.');
  } finally {
    await client.end();
  }
} else if (action === 'migrate') {
  for (const connection of [dev, test])
    run(
      [prismaCli, 'migrate', 'deploy', '--config', 'apps/api/prisma.config.ts'],
      { ...process.env, DATABASE_URL: connection },
    );
} else if (action === 'test') {
  run(
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--root',
      'apps/api',
      'test/phase2.test.ts',
      'test/phase3.test.ts',
      'test/phase4.test.ts',
      'test/phase5.test.ts',
      'test/phase6.test.ts',
      'test/phase7.test.ts',
      'test/phase8.test.ts',
      'test/phase9.test.ts',
      'test/phase10.test.ts',
      'test/phase10-roles.test.ts',
      'test/phase11.test.ts',
      'test/phase12-data.test.ts',
      '--no-file-parallelism',
    ],
    { ...process.env, DATABASE_URL: test, TEST_DATABASE_URL: test },
  );
} else if (action === 'verify-clean') {
  const admin = new URL(dev);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const name = `stockflow_verify_${Date.now()}`;
  if (!/^stockflow_verify_[0-9]+$/.test(name))
    throw new Error('Unsafe verification database name');
  let created = false;
  try {
    await client.query(`CREATE DATABASE ${name}`);
    created = true;
    const clean = new URL(dev);
    clean.pathname = `/${name}`;
    const environment = { ...process.env, DATABASE_URL: clean.toString() };
    run(
      [prismaCli, 'migrate', 'deploy', '--config', 'apps/api/prisma.config.ts'],
      environment,
    );
    run(
      [
        prismaCli,
        'migrate',
        'diff',
        '--config',
        'apps/api/prisma.config.ts',
        '--from-config-datasource',
        '--to-schema',
        'apps/api/prisma/schema.prisma',
        '--exit-code',
      ],
      environment,
    );
    console.log(
      'All migrations applied from a fresh database with no Prisma schema drift.',
    );
  } finally {
    if (created) await client.query(`DROP DATABASE ${name}`);
    await client.end();
  }
} else if (action === 'e2e') {
  run(['node_modules/@playwright/test/cli.js', 'test'], {
    ...process.env,
    DATABASE_URL: test,
  });
} else throw new Error('Use create, migrate, verify-clean, test or e2e');
