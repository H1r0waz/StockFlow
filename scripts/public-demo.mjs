import { createDatabase } from '../apps/api/src/database.ts';
import {
  demoOrganization,
  seedPublicDemo,
  verifyDemo,
} from '../apps/api/src/demo/seed.ts';
import {
  assertPublicDemoTarget,
  publicDemoMarker,
} from '../apps/api/src/demo/public-target.ts';

// Intentionally does not load .env or fall back to the application's runtime URL.
async function main() {
  const action = process.argv[2];
  if (!['seed', 'verify'].includes(action))
    throw new Error('Use public-demo seed or verify.');
  const connection = process.env.PUBLIC_DEMO_ADMIN_URL;
  const target = {
    host: process.env.PUBLIC_DEMO_HOST,
    database: process.env.PUBLIC_DEMO_DATABASE,
    confirmation: process.env.STOCKFLOW_PUBLIC_DEMO_CONFIRM,
  };
  assertPublicDemoTarget(connection, target);
  if (action === 'seed') {
    const summary = await seedPublicDemo(connection, target);
    console.log(JSON.stringify({ action, ...summary }));
    return;
  }
  const db = createDatabase(connection);
  try {
    const [database] =
      await db.$queryRaw`SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`;
    if (database?.marker !== publicDemoMarker)
      throw new Error('Public demo marker mismatch.');
    const organization = await db.organization.findFirst({
      where: { name: demoOrganization },
    });
    if (!organization)
      throw new Error('Public fictional organization is absent.');
    console.log(
      JSON.stringify({ action, ...(await verifyDemo(db, organization.id)) }),
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  // Provider errors can contain connection details. No raw diagnostics here.
  console.error(
    'Public demo command refused or failed. Check the pinned target, consent, marker, migrations and database health using administrative tooling.',
  );
  process.exitCode = 1;
});
