import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

let database: PrismaClient | undefined;

// The installed adapter serializes/parses timestamptz in UTC. Match its session
// timezone explicitly so PostgreSQL never interprets bound dates in local time.
export function createDatabase(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      options: '-c timezone=UTC',
      connectionTimeoutMillis: 2_000,
    }),
  });
}

export function getDatabase(): PrismaClient {
  if (!database) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    database = createDatabase(connectionString);
  }
  return database;
}

export async function disconnectDatabase() {
  await database?.$disconnect();
  database = undefined;
}
