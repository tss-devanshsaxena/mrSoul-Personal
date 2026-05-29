import express, { Router, Request, Response } from 'express';
import path from 'path';
import { z } from 'zod';
import { requireAdminAuth } from '../middleware/dashboardAuth';
import { dashboardAuthService } from '../services/dashboardAuth';
import { storeOwnerService } from '../services/storeOwner';
import { storeOutreachService } from '../services/storeOutreach';
import { storeOutreachScheduler } from '../services/storeOutreachScheduler';
import { config } from '../config';
import { accessControlService } from '../services/accessControl';
import type { AccessRole } from '../types/access';
import { createLogger } from '../utils/logger';

const log = createLogger('adminPortal');
const adminRoot = path.join(process.cwd(), 'public', 'admin');

export const adminPortalRouter = Router();

adminPortalRouter.get('/dashboard/store-owners', (_req, res) => {
  res.redirect(302, '/admin/stores.html');
});
adminPortalRouter.get('/admin', (_req, res) => {
  res.redirect(302, '/admin/index.html');
});

const ownerSchema = z.object({
  storeId: z.string().min(1).max(64),
  storeLocation: z.string().min(1).max(256),
  userName: z.string().max(128).optional(),
  name: z.string().min(1).max(128),
  phone: z.string().max(32).optional(),
  email: z.string().email(),
  active: z.boolean().optional(),
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  timezone: z.string().min(1).max(64).optional(),
  messageTemplate: z.string().min(1).max(4000).optional(),
  pinMessages: z.boolean().optional(),
  oncePerDay: z.boolean().optional(),
});

function registerStoreOutreachApi(router: Router, base: string): void {
  router.get(`${base}/owners`, async (_req, res) => {
    try {
      const owners = await storeOwnerService.list();
      res.json({ success: true, data: owners });
    } catch {
      res.status(500).json({ success: false, error: 'LIST_FAILED' });
    }
  });

  router.post(`${base}/owners`, async (req, res) => {
    const parsed = ownerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'VALIDATION', details: parsed.error.flatten() });
      return;
    }
    try {
      const owner = await storeOwnerService.create(parsed.data);
      res.status(201).json({ success: true, data: owner });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  });

  router.put(`${base}/owners/:storeId`, async (req, res) => {
    const parsed = ownerSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'VALIDATION', details: parsed.error.flatten() });
      return;
    }
    try {
      const owner = await storeOwnerService.update(req.params.storeId, parsed.data);
      res.json({ success: true, data: owner });
    } catch (err) {
      res.status(404).json({ success: false, error: (err as Error).message });
    }
  });

  router.delete(`${base}/owners/:storeId`, async (req, res) => {
    const removed = await storeOwnerService.remove(req.params.storeId);
    if (!removed) {
      res.status(404).json({ success: false, error: 'NOT_FOUND' });
      return;
    }
    res.json({ success: true });
  });

  router.post(`${base}/import`, async (req, res) => {
    const parsed = z
      .object({
        rows: z.array(ownerSchema),
        updateExisting: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'VALIDATION', details: parsed.error.flatten() });
      return;
    }

    try {
      const result = await storeOwnerService.bulkImport(parsed.data.rows, {
        updateExisting: parsed.data.updateExisting ?? true,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.get(`${base}/config`, async (_req, res) => {
    try {
      const data = await storeOutreachService.getConfig();
      res.json({ success: true, data });
    } catch {
      res.status(500).json({ success: false, error: 'CONFIG_FAILED' });
    }
  });

  router.put(`${base}/config`, async (req, res) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'VALIDATION', details: parsed.error.flatten() });
      return;
    }
    try {
      const data = await storeOutreachService.updateConfig(parsed.data);
      await storeOutreachScheduler.reschedule();
      res.json({ success: true, data });
    } catch {
      res.status(500).json({ success: false, error: 'UPDATE_FAILED' });
    }
  });

  router.post(`${base}/run-now`, async (req, res) => {
    const force = req.body?.force === true;
    try {
      const result = await storeOutreachService.runDailyOutreach({ force });
      res.json({ success: true, data: result });
    } catch {
      res.status(500).json({ success: false, error: 'RUN_FAILED' });
    }
  });
}

adminPortalRouter.post('/admin/api/auth/login', (req, res) => {
  const body = z
    .object({ username: z.string().min(1), password: z.string().min(1) })
    .safeParse(req.body);

  if (!body.success) {
    res.status(400).json({ success: false, error: 'VALIDATION' });
    return;
  }

  if (!dashboardAuthService.validateCredentials(body.data.username, body.data.password)) {
    res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS' });
    return;
  }

  const token = dashboardAuthService.createSessionToken(body.data.username);
  res.cookie(dashboardAuthService.cookieName, token, dashboardAuthService.cookieOptions());
  res.json({ success: true, data: { user: body.data.username } });
});

adminPortalRouter.post('/admin/api/auth/logout', (_req, res) => {
  res.clearCookie(dashboardAuthService.cookieName, { path: '/' });
  res.json({ success: true });
});

adminPortalRouter.get('/admin/api/auth/me', (req: Request, res: Response) => {
  const raw = req.headers.cookie ?? '';
  const name = dashboardAuthService.cookieName;
  const part = raw.split(';').find(c => c.trim().startsWith(`${name}=`));
  const token = part ? decodeURIComponent(part.trim().slice(name.length + 1)) : undefined;
  const session = dashboardAuthService.parseSessionToken(token);

  if (!session) {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    return;
  }
  res.json({ success: true, data: { user: session.user } });
});

adminPortalRouter.use('/admin/api', requireAdminAuth);

adminPortalRouter.get('/admin/api/overview', async (_req, res) => {
  try {
    const [stores, outreach] = await Promise.all([
      storeOwnerService.getStats(),
      storeOutreachService.getConfig(),
    ]);
    res.json({
      success: true,
      data: {
        stores,
        outreach,
        platform: {
          env: config.env,
          storeOutreachEnabled: config.storeOutreach.enabled,
          githubRepo: `${config.github.owner}/${config.github.repo}`,
          uptimeSec: Math.floor(process.uptime()),
        },
      },
    });
  } catch (err) {
    log.error('Overview failed', { error: (err as Error).message });
    res.status(500).json({ success: false, error: 'OVERVIEW_FAILED' });
  }
});

const accessRoleSchema = z.enum(['super_admin', 'admin', 'member']);

adminPortalRouter.get('/admin/api/access/users', async (_req, res) => {
  try {
    if (!config.accessControl.enabled) {
      res.json({
        success: true,
        data: [],
        accessControlEnabled: false,
        message: 'Set ACCESS_CONTROL_ENABLED=true to use Slack role permissions.',
      });
      return;
    }
    const users = await accessControlService.listActiveUsers();
    res.json({ success: true, data: users, accessControlEnabled: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

adminPortalRouter.put('/admin/api/access/users', async (req, res) => {
  const parsed = z
    .object({ email: z.string().email(), role: accessRoleSchema })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'VALIDATION' });
    return;
  }
  if (!config.accessControl.enabled) {
    res.status(400).json({ success: false, error: 'ACCESS_CONTROL_DISABLED' });
    return;
  }
  try {
    const adminUser = (req as Request & { adminUser?: string }).adminUser ?? 'admin-portal';
    const data = await accessControlService.setUserRole(
      parsed.data.email,
      parsed.data.role as AccessRole,
      adminUser
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

adminPortalRouter.delete('/admin/api/access/users/:email', async (req, res) => {
  if (!config.accessControl.enabled) {
    res.status(400).json({ success: false, error: 'ACCESS_CONTROL_DISABLED' });
    return;
  }
  try {
    const adminUser = (req as Request & { adminUser?: string }).adminUser ?? 'admin-portal';
    const ok = await accessControlService.revokeUser(req.params.email, adminUser);
    if (!ok) {
      res.status(404).json({ success: false, error: 'NOT_FOUND' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

registerStoreOutreachApi(adminPortalRouter, '/admin/api/store-outreach');

const legacyStoreApi = Router();
legacyStoreApi.use(requireAdminAuth);
registerStoreOutreachApi(legacyStoreApi, '');
adminPortalRouter.use('/dashboard/api/store-outreach', legacyStoreApi);

adminPortalRouter.use('/admin', express.static(adminRoot, { index: 'index.html' }));
