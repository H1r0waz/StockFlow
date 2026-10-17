import { app } from './app.js';
import { disconnectDatabase } from './database.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
const server = app.listen(port, host, () => {
  console.info(JSON.stringify({ event: 'server_listening', port, host }));
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

server.on('error', () => {
  console.error('Unable to start StockFlow API');
  process.exitCode = 1;
});

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error('Unable to close StockFlow API');
      process.exitCode = 1;
    }
    void disconnectDatabase().catch(() => {
      console.error('Unable to close database connections');
      process.exitCode = 1;
    });
  });
  // Bound HTTP shutdown if a connection remains open.
  setTimeout(() => {
    server.closeAllConnections();
  }, 5_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
