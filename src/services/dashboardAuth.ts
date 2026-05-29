import crypto from 'crypto';
import { config } from '../config';

const COOKIE_NAME = 'mrsoul_admin_session';

export interface DashboardSessionPayload {
  user: string;
  exp: number;
}

function sign(payload: DashboardSessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.dashboard.sessionSecret)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verify(token: string): DashboardSessionPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expected = crypto
    .createHmac('sha256', config.dashboard.sessionSecret)
    .update(body)
    .digest('base64url');

  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DashboardSessionPayload;
    if (!payload.user || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export class DashboardAuthService {
  readonly cookieName = COOKIE_NAME;

  isConfigured(): boolean {
    return Boolean(config.dashboard.password);
  }

  validateCredentials(username: string, password: string): boolean {
    const expectedUser = config.dashboard.username;
    const expectedPass = config.dashboard.password;

    if (!expectedPass) {
      const apiKey = process.env.API_KEY;
      return Boolean(apiKey) && password === apiKey && username === expectedUser;
    }

    return username === expectedUser && password === expectedPass;
  }

  createSessionToken(username: string): string {
    const ttlMs = config.dashboard.sessionTtlHours * 60 * 60 * 1000;
    return sign({ user: username, exp: Date.now() + ttlMs });
  }

  parseSessionToken(token: string | undefined): DashboardSessionPayload | null {
    if (!token) return null;
    return verify(token);
  }

  cookieOptions(): {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax';
    maxAge: number;
    path: string;
  } {
    return {
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'lax',
      maxAge: config.dashboard.sessionTtlHours * 60 * 60 * 1000,
      path: '/',
    };
  }
}

export const dashboardAuthService = new DashboardAuthService();
