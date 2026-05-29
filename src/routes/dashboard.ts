import { Router, Request, Response } from 'express';
import path from 'path';
import { activityFeed } from '../services/activityFeed';
import { config } from '../config';
import { issueService } from '../services/issue';
import { routingService } from '../services/routing';
import { createLogger } from '../utils/logger';

const log = createLogger('dashboard');

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'dashboard.html'));
});

dashboardRouter.get('/dashboard/api/snapshot', async (_req: Request, res: Response) => {
  try {
    const [issues, mappings] = await Promise.all([
      issueService.listIssues({ limit: 15, offset: 0 }),
      routingService.getAllMappings(),
    ]);

    const routing = [...mappings.values()].map(m => ({
      tag: m.tag,
      owner: m.primaryOwnerName,
      github: m.githubUsername,
    }));

    res.json({
      success: true,
      data: {
        env: config.env,
        adkEnabled: config.adk.enabled && Boolean(config.adk.apiKey),
        githubRepo: `${config.github.owner}/${config.github.repo}`,
        project: config.github.project.org
          ? `${config.github.project.org} #${config.github.project.number}`
          : null,
        monitoredChannels: config.slack.monitoredChannels,
        activity: activityFeed.getSnapshot(),
        recentIssues: issues.issues.map(i => ({
          id: i.id,
          status: i.status,
          priority: i.priority,
          assignee: i.assignment?.githubUsername,
          github: i.githubIssue?.issueUrl,
          channel: i.slackChannelName,
          createdAt: i.createdAt,
          preview: (i.originalMessage ?? '').slice(0, 120),
        })),
        routing,
        uptimeSec: Math.floor(process.uptime()),
      },
    });
  } catch (err) {
    log.error('Dashboard snapshot failed', { error: (err as Error).message });
    res.status(500).json({ success: false, error: 'SNAPSHOT_FAILED' });
  }
});

dashboardRouter.get('/dashboard/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { ts: new Date().toISOString(), message: 'MrSoul activity stream connected' });

  const unsubscribe = activityFeed.subscribe(evt => {
    send('activity', evt);
  });

  const heartbeat = setInterval(() => {
    send('ping', { ts: new Date().toISOString() });
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
