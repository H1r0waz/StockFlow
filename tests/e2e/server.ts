import { createApp } from '../../apps/api/src/app.js';
import { disconnectDatabase } from '../../apps/api/src/database.js';

const target = process.env.DATABASE_URL;
if (
  !target ||
  target !== process.env.TEST_DATABASE_URL ||
  process.env.NODE_ENV === 'production'
)
  throw Error('E2E server requires the dedicated test database');
const url = new URL(target);
if (
  url.protocol !== 'postgresql:' ||
  url.hostname !== '127.0.0.1' ||
  url.port !== '55434' ||
  url.pathname !== '/stockflow_test' ||
  url.username !== 'stockflow'
)
  throw Error('E2E server refuses another database');

// Browser contexts share loopback IP; limiter behavior has separate real-DB tests.
const server = createApp({ rateLimit: { max: 1000 } }).listen(
  3001,
  '127.0.0.1',
);
server.on('error', () => {
  process.exitCode = 1;
});
const shutdown = () => {
  server.close(() => {
    void disconnectDatabase();
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
