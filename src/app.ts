import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { createLogger } from './utils/logger';
import { requestIdMiddleware, accessLogMiddleware } from './middleware/requestId';
import { apiKeyAuth } from './middleware/auth';
import { notFoundHandler, globalErrorHandler } from './middleware/errorHandler';
import {
  healthRouter,
  issuesRouter,
  routingRouter,
  workloadRouter,
  webhookRouter,
} from './routes';
import { dashboardRouter } from './routes/dashboard';
import { adminPortalRouter } from './routes/adminPortal';
import { storeOutreachRouter } from './routes/storeOutreach';

const log = createLogger('app');

export function createExpressApp(): Application {
  const app = express();

  if (config.isProd) {
    app.set('trust proxy', 1);
  }

  // Request ID + access logging (first)
  app.use(requestIdMiddleware);
  app.use(accessLogMiddleware);

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: config.isProd,
    crossOriginEmbedderPolicy: false,
  }));

  // CORS
  app.use(cors({
    origin: config.isProd ? (process.env.ALLOWED_ORIGINS?.split(',') ?? false) : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  }));

  // Webhooks need raw body for signature verification
  app.use('/webhooks', express.json({
    limit: '1mb',
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Rate limiting
  const standardLimiter = rateLimit({
    windowMs: config.rateLimiting.windowMs,
    max: config.rateLimiting.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded. Please slow down.',
      });
    },
  });

  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Public routes
  app.use('/', healthRouter);
  app.use('/', dashboardRouter);
  app.use('/', adminPortalRouter);
  app.use('/', storeOutreachRouter);
  app.use('/webhooks', webhookRouter);

  // Protected API routes
  app.use('/api/', standardLimiter);
  app.use('/api/', apiKeyAuth);
  app.use('/api/issues', issuesRouter);
  app.use('/api/routing', writeLimiter, routingRouter);
  app.use('/api/workload', workloadRouter);

  // Error handlers (must be last)
  app.use(notFoundHandler);
  app.use(globalErrorHandler);

  log.info('Express app configured', { env: config.env });
  return app;
}
