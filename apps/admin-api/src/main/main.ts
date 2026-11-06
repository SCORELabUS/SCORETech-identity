import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/app-config.js';
import { createLogger } from './shared/logging/logger.js';
import { CatalogueService } from './modules/catalogue/catalogue-service.js';

const config = loadConfig();
const logger = createLogger(config.APP_LOG_LEVEL);
const catalogue = new CatalogueService(config);
const app = createApp(config, { logger, catalogue });
if (catalogue.github.configured) {
  try {
    await catalogue.current();
  } catch {
    // Keep unrelated endpoints available; catalogue reads retry and fail closed.
    logger.error('catalogue warmup failed');
  }
}
const server = app.listen(config.APP_PORT, '0.0.0.0', () => {
  logger.info('http server listening', {
    port: config.APP_PORT,
    version: config.APP_SERVICE_VERSION,
  });
});

const shutdown = (): void => {
  logger.info('application shutdown started');
  server.close(() => logger.info('application shutdown completed'));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
