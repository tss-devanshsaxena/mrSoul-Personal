import { config } from '../config';
import { activityFeed, type ActivityEvent } from './activityFeed';
import { slackService } from './slack';
import { createLogger } from '../utils/logger';

const log = createLogger('slack-live-ops');

type StepState = 'pending' | 'running' | 'done' | 'error';

type PipelineStep = {
  id: string;
  label: string;
  state: StepState;
};

type PipelineSession = {
  channelId: string;
  threadRootTs: string;
  messageTs: string;
  pipelineMessageTs: string;
  steps: PipelineStep[];
  lastError?: string;
};

const DEFAULT_STEPS: Omit<PipelineStep, 'state'>[] = [
  { id: 'received', label: 'Slack message received' },
  { id: 'triage', label: 'Triage & TSS validation' },
  { id: 'github', label: 'GitHub issue + project board' },
  { id: 'prd', label: 'PRD draft (+ Claude handoff)' },
  { id: 'thread', label: 'Tracking thread posted' },
];

function pipelineKey(channelId: string, messageTs: string): string {
  return `${channelId}:${messageTs}`;
}

function stepIcon(state: StepState): string {
  switch (state) {
    case 'done':
      return ':white_check_mark:';
    case 'running':
      return ':hourglass_flowing_sand:';
    case 'error':
      return ':x:';
    default:
      return ':white_circle:';
  }
}

function buildPipelineBlocks(session: PipelineSession): Record<string, unknown>[] {
  const lines = session.steps.map(s => `${stepIcon(s.state)} *${s.label}*`).join('\n');
  const errLine = session.lastError
    ? `\n\n:warning: *${session.lastError}*`
    : '';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'MrSoul — live pipeline', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${lines}${errLine}\n\n_Updates in real time in this thread._`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: config.slack.claudeBotUserId
            ? 'PRD can hand off to <@' + config.slack.claudeBotUserId + '> in this thread'
            : 'Add `SLACK_CLAUDE_BOT_USER_ID` to enable @Claude handoff',
        },
      ],
    },
  ];
}

function applyActivityToSession(session: PipelineSession, evt: ActivityEvent): void {
  const title = evt.title.toLowerCase();

  const set = (id: string, state: StepState) => {
    const step = session.steps.find(s => s.id === id);
    if (step) step.state = state;
  };

  if (title.includes('slack message received')) {
    set('received', 'done');
    set('triage', 'running');
  } else if (title.includes('creating github issue')) {
    set('triage', 'running');
  } else if (title.includes('assignee:')) {
    set('triage', 'done');
    set('github', 'running');
    if (config.prd.enabled) set('prd', 'running');
  } else if (title.includes('tss validation failed') || title.includes('issue creation failed')) {
    set('triage', 'error');
    session.lastError = evt.detail ?? evt.title;
  } else if (title.includes('github issue #')) {
    set('github', 'done');
  } else if (title.includes('github') && evt.level === 'error') {
    set('github', 'error');
    session.lastError = evt.detail ?? 'GitHub step failed';
  } else if (title.includes('prd draft generating') || title.includes('mrsoul_prd')) {
    set('prd', 'running');
  } else if (title.includes('prd draft ready')) {
    set('prd', 'done');
  } else if (title.includes('prd draft failed')) {
    set('prd', 'error');
  } else if (title.includes('pipeline complete') || title.includes('tracking thread')) {
    set('thread', 'done');
    set('prd', session.steps.find(s => s.id === 'prd')?.state === 'running' ? 'done' : session.steps.find(s => s.id === 'prd')?.state ?? 'pending');
  }
}

export class SlackLiveOpsService {
  private static instance: SlackLiveOpsService;
  private sessions = new Map<string, PipelineSession>();
  private subscribed = false;

  static getInstance(): SlackLiveOpsService {
    if (!SlackLiveOpsService.instance) {
      SlackLiveOpsService.instance = new SlackLiveOpsService();
    }
    return SlackLiveOpsService.instance;
  }

  init(): void {
    if (!config.slack.liveOpsEnabled || this.subscribed) return;
    this.subscribed = true;
    activityFeed.subscribe(evt => this.onActivity(evt));
    log.info('Slack live ops subscribed to activity feed');
  }

  async startPipeline(
    channelId: string,
    threadRootTs: string,
    messageTs: string
  ): Promise<void> {
    if (!config.slack.liveOpsEnabled) return;

    const key = pipelineKey(channelId, messageTs);
    if (this.sessions.has(key)) return;

    const steps: PipelineStep[] = DEFAULT_STEPS.map(s => ({
      ...s,
      state: s.id === 'received' ? 'done' : s.id === 'triage' ? 'running' : 'pending',
    }));

    if (!config.prd.enabled) {
      const prdStep = steps.find(s => s.id === 'prd');
      if (prdStep) prdStep.state = 'done';
    }

    try {
      const posted = await slackService.postMessageWithThreadFallback(
        channelId,
        'MrSoul pipeline started',
        threadRootTs,
        buildPipelineBlocks({ channelId, threadRootTs, messageTs, pipelineMessageTs: '', steps })
      );

      const session: PipelineSession = {
        channelId,
        threadRootTs,
        messageTs,
        pipelineMessageTs: posted.ts,
        steps,
      };
      this.sessions.set(key, session);

      activityFeed.emitActivity({
        level: 'info',
        source: 'slack',
        title: 'Live pipeline posted in Slack',
        detail: threadRootTs,
        meta: { channelId, messageTs, threadRootTs },
      });
    } catch (err) {
      log.warn('Failed to post live pipeline', { error: (err as Error).message });
    }
  }

  private async onActivity(evt: ActivityEvent): Promise<void> {
    const meta = evt.meta ?? {};
    const channelId = meta.channelId as string | undefined;
    const messageTs = meta.messageTs as string | undefined;
    if (!channelId || !messageTs) return;

    const key = pipelineKey(channelId, messageTs);
    const session = this.sessions.get(key);
    if (!session) return;

    applyActivityToSession(session, evt);

    try {
      await slackService.updateMessage(
        session.channelId,
        session.pipelineMessageTs,
        'MrSoul pipeline',
        buildPipelineBlocks(session)
      );
    } catch (err) {
      log.debug('Pipeline update skipped', { error: (err as Error).message });
    }

    if (evt.title.toLowerCase().includes('pipeline complete')) {
      this.sessions.delete(key);
    }
  }

  endPipeline(channelId: string, messageTs: string, error?: string): void {
    const key = pipelineKey(channelId, messageTs);
    const session = this.sessions.get(key);
    if (!session) return;
    if (error) session.lastError = error;
    const triage = session.steps.find(s => s.id === 'triage');
    if (triage && triage.state === 'running') triage.state = 'error';
    slackService
      .updateMessage(
        session.channelId,
        session.pipelineMessageTs,
        'MrSoul pipeline',
        buildPipelineBlocks(session)
      )
      .catch(() => undefined);
    this.sessions.delete(key);
  }
}

export const slackLiveOps = SlackLiveOpsService.getInstance();
