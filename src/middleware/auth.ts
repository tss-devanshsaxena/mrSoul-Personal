import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';

const log = createLogger('middleware:auth');

/**
 * Simple API key authentication for internal API routes.
 * 
 * Set API_KEY in your .env. All /api/* routes require:
 *   Authorization: Bearer <API_KEY>
 *   OR
 *   X-Api-Key: <API_KEY>
 * 
 * Disabled automatically if API_KEY is not set (dev mode).
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.API_KEY;

  // If no API key configured, skip auth (useful for local dev)
  if (!apiKey) {
    next();
    return;
  }

  const provided =
    extractBearerToken(req.headers.authorization) ??
    (req.headers['x-api-key'] as string | undefined);

  if (!provided || provided !== apiKey) {
    log.warn('Unauthorized API request', {
      requestId: req.requestId,
      path: req.path,
      ip: req.ip,
    });
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Valid API key required. Provide via Authorization: Bearer <key> or X-Api-Key header.',
    });
    return;
  }

  next();
}

function extractBearerToken(authHeader?: string): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  return authHeader.slice(7).trim() || undefined;
}
