import { Request, Response, NextFunction } from 'express';
import { dashboardAuthService } from '../services/dashboardAuth';
import { createLogger } from '../utils/logger';

const log = createLogger('middleware:dashboardAuth');

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    if (key === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return undefined;
}

function extractApiKey(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7).trim() || undefined;
  }
  return req.headers['x-api-key'] as string | undefined;
}

/**
 * Protects admin portal APIs. Accepts session cookie or API_KEY (backward compatible).
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const sessionToken = readCookie(req, dashboardAuthService.cookieName);
  const session = dashboardAuthService.parseSessionToken(sessionToken);
  if (session) {
    (req as Request & { adminUser?: string }).adminUser = session.user;
    next();
    return;
  }

  const apiKey = process.env.API_KEY;
  const provided = extractApiKey(req);
  if (apiKey && provided === apiKey) {
    (req as Request & { adminUser?: string }).adminUser = 'api-key';
    next();
    return;
  }

  log.warn('Unauthorized admin API request', { path: req.path });
  res.status(401).json({
    success: false,
    error: 'UNAUTHORIZED',
    message: 'Sign in at /admin/login.html',
  });
}
