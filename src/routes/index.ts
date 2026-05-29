import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { issueService } from '../services/issue';
import { routingService } from '../services/routing';
import { workloadTracker } from '../services/tracker';
import { githubService } from '../services/github';
import { createLogger } from '../utils/logger';
import { ApiResponse, IssueStatus } from '../types';

const log = createLogger('routes');

const UpdateStatusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'pr_opened', 'pr_merged', 'closed', 'resolved']),
});

const ListIssuesSchema = z.object({
  status: z.enum(['open', 'in_progress', 'pr_opened', 'pr_merged', 'closed', 'resolved']).optional(),
  assignee: z.string().optional(),
  priority: z.enum(['critical', 'urgent', 'high', 'medium', 'low']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const RoutingMappingSchema = z.object({
  tag: z.string().min(1),
  primaryOwner: z.string().min(1),
  primaryOwnerName: z.string().min(1),
  secondaryOwners: z.array(z.string()).default([]),
  githubUsername: z.string().min(1),
  notionUserId: z.string().optional(),
  active: z.boolean().default(true),
});

// ============================================================
// Health Routes
// ============================================================
export const healthRouter = Router();

healthRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'ce-tech-automation',
    version: process.env.npm_package_version ?? '1.0.0',
    uptime: Math.floor(process.uptime()),
  });
});

healthRouter.get('/health/detailed', async (_req: Request, res: Response) => {
  const mongoose = await import('mongoose');
  const mem = process.memoryUsage();
  const mongoState = mongoose.connection?.readyState;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    services: {
      mongodb: mongoState === 1 ? 'connected' : 'disconnected',
    },
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    node: process.version,
  });
});

// ============================================================
// Issues Routes
// ============================================================
export const issuesRouter = Router();

issuesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const params = ListIssuesSchema.parse(req.query);
    const result = await issueService.listIssues(params);
    return res.json({ success: true, data: { ...result, limit: params.limit, offset: params.offset } });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', details: err.errors });
    log.error('List issues', { error: (err as Error).message });
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

issuesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const issue = await issueService.getIssue(req.params.id);
    if (!issue) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    return res.json({ success: true, data: issue });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

issuesRouter.patch('/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = UpdateStatusSchema.parse(req.body);
    await issueService.updateIssueStatus(req.params.id, status as IssueStatus, { manualUpdate: true });
    return res.json({ success: true, message: `Status updated to ${status}` });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', details: err.errors });
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

issuesRouter.get('/:id/audit', async (req: Request, res: Response) => {
  try {
    const issue = await issueService.getIssue(req.params.id);
    if (!issue) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    return res.json({ success: true, data: issue.auditLog });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

// ============================================================
// Routing Routes
// ============================================================
export const routingRouter = Router();

routingRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const mappings = await routingService.getAllMappings();
    res.json({ success: true, data: Array.from(mappings.values()) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

routingRouter.put('/', async (req: Request, res: Response) => {
  try {
    const mapping = RoutingMappingSchema.parse(req.body);
    await routingService.upsertMapping(mapping);
    return res.json({ success: true, message: `Mapping for ${mapping.tag} updated` });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', details: err.errors });
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

routingRouter.delete('/:tag', async (req: Request, res: Response) => {
  try {
    const tag = decodeURIComponent(req.params.tag);
    await routingService.upsertMapping({ tag, primaryOwner: '', primaryOwnerName: '', secondaryOwners: [], githubUsername: '', active: false });
    routingService.invalidateCache();
    res.json({ success: true, message: `Mapping for ${tag} deactivated` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

// ============================================================
// Workload Routes
// ============================================================
export const workloadRouter = Router();

workloadRouter.get('/summary', async (_req: Request, res: Response) => {
  try {
    const summary = await workloadTracker.getWorkloadSummary();
    res.json({ success: true, data: summary } as ApiResponse);
  } catch (err) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' } as ApiResponse);
  }
});

// ============================================================
// GitHub Webhook Handler
// ============================================================
export const webhookRouter = Router();

webhookRouter.post('/github', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    if (signature && rawBody) {
      if (!githubService.verifyWebhookSignature(rawBody.toString(), signature)) {
        log.warn('GitHub webhook signature mismatch', { ip: req.ip });
        return res.status(401).json({ error: 'INVALID_SIGNATURE' });
      }
    }

    const event = req.headers['x-github-event'] as string;
    const delivery = req.headers['x-github-delivery'] as string;
    const body = req.body;

    log.info('GitHub webhook received', { event, action: body.action, delivery });

    res.status(202).json({ received: true, delivery });
    setImmediate(async () => {
      try {
        if (event === 'pull_request') {
          const pr = body.pull_request;
          await issueService.handleGitHubPREvent(body.action, pr.number, pr.title, pr.html_url, pr.merged === true);
        } else if (event === 'issues' && body.action === 'closed') {
          await issueService.handleGitHubIssueClosed(body.issue.number);
        }
      } catch (err) {
        log.error('Webhook processing error', { delivery, event, error: (err as Error).message });
      }
    });
    return;
  } catch (err) {
    log.error('Webhook handler error', { error: (err as Error).message });
    if (!res.headersSent) return res.status(500).json({ error: 'INTERNAL_ERROR' });
    return;
  }
});
