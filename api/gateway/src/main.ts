import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Server } from 'http';
import { assertProductionConfig, envInt } from '@ethiopialearn/common';
import { createGatewayApp } from './app';

async function bootstrap() {
  assertProductionConfig({ service: 'gateway', secrets: ['JWT_SECRET'] });
  const app = await createGatewayApp();

  // Graceful shutdown (P2-15). On SIGTERM Nest closes the server: it stops
  // accepting connections, drops idle keep-alive sockets and waits for the
  // requests in flight. One still running after SHUTDOWN_GRACE_MS is cut so a
  // deploy isn't held up.
  app.enableShutdownHooks();
  const server = app.getHttpServer() as Server;
  process.once('SIGTERM', () => {
    setTimeout(() => server.closeAllConnections(), envInt('SHUTDOWN_GRACE_MS', 10_000)).unref();
  });

  const port = envInt('PORT', 4000);
  await app.listen(port);
  Logger.log(`gateway listening on :${port}`, 'Bootstrap');
}

void bootstrap();
