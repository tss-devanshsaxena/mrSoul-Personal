import { WebClient } from '@slack/web-api';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { withRetry, RateLimiter } from '../utils/retry';
import {
  ParsedSlackMessage,
  IssueAssignment,
  GitHubIssueRef,
  SlackThreadRef,
  IssueStatus,
} from '../types';
import { formatPriority, formatStatus } from '../utils/messageParser';
import type { TriageDecision } from './triage';
import type { DerivedIssueGuidelines } from './issueGuidelines';
import { TSS_PROJECT_URL } from '../content/tssIssueGuidelines';
import { buildPrdBlocks } from '../content/prdBlocks';
import type { AdkPrd } from '../agents/schemas';

const log = createLogger('slack');

/** Human-readable Slack Web API errors (includes missing_scope → which scopes to add). */
export function formatSlackApiError(err: unknown): string {
  const data = (err as { data?: { error?: string; needed?: string } })?.data;
  const base = (err as Error)?.message ?? String(err);

  if (data?.error === 'missing_scope') {
    const needed = data.needed ?? 'users:read.email, im:write, chat:write, pins:write';
    return (
      `Slack bot is missing OAuth scope(s): ${needed}. ` +
      'In api.slack.com → your app → OAuth & Permissions → Bot Token Scopes → add them, ' +
      'then Reinstall to Workspace. Store outreach needs at least users:read.email and im:write.'
    );
  }

  if (data?.error) {
    return `Slack API: ${data.error}${data.needed ? ` (add scope: ${data.needed})` : ''}`;
  }

  return base;
}

// Slack Web API: Tier 3 = 50+ req/min
const rateLimiter = new RateLimiter(0.8); // 0.8 req/sec to stay safe

export class SlackService {
  private static instance: SlackService;
  private client: WebClient;

  private constructor() {
    this.client = new WebClient(config.slack.botToken);
  }

  static getInstance(): SlackService {
    if (!SlackService.instance) {
      SlackService.instance = new SlackService();
    }
    return SlackService.instance;
  }

  /**
   * Create a tracking thread in reply to the original Slack message.
   */
  async createTrackingThread(
    message: ParsedSlackMessage,
    assignment: IssueAssignment,
    issueId: string,
    githubIssue?: GitHubIssueRef,
    triage?: TriageDecision,
    guidelines?: DerivedIssueGuidelines,
    validationWarnings: string[] = []
  ): Promise<SlackThreadRef> {
    await rateLimiter.acquire();

    const blocks = this.buildTrackingThreadBlocks(
      message,
      assignment,
      issueId,
      githubIssue,
      triage,
      guidelines,
      validationWarnings
    );

    return withRetry(async () => {
      log.info('Creating Slack tracking thread', {
        channel: message.channelId,
        ts: message.messageTs,
      });

      const threadRoot = message.threadTs ?? message.messageTs;
      const posted = await this.postMessageWithThreadFallback(
        message.channelId,
        `CE-Tech Tracking Thread — ${issueId}`,
        threadRoot,
        blocks
      );

      log.info('Slack tracking thread created', {
        channel: message.channelId,
        threadTs: posted.ts,
        threaded: posted.threaded,
      });

      return {
        channelId: message.channelId,
        threadTs: posted.ts,
      };
    });
  }

  /**
   * Update an existing tracking thread with status changes.
   */
  async postThreadUpdate(
    channelId: string,
    threadTs: string,
    updateType: string,
    details: Record<string, unknown>,
    currentStatus: IssueStatus
  ): Promise<void> {
    await rateLimiter.acquire();

    const blocks = this.buildStatusUpdateBlocks(updateType, details, currentStatus);

    await withRetry(() =>
      this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Status Update: ${formatStatus(currentStatus)}`,
        blocks,
        unfurl_links: false,
      })
    );

    log.info('Posted thread status update', { channelId, threadTs, updateType });
  }

  /**
   * Mention a user in a thread to notify them.
   */
  async notifyDeveloper(
    channelId: string,
    threadTs: string,
    userId: string,
    message: string
  ): Promise<void> {
    await rateLimiter.acquire();

    await withRetry(() =>
      this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `<@${userId}> ${message}`,
      })
    );
  }

  /**
   * Get channel info (name) by ID.
   */
  async getChannelName(channelId: string): Promise<string> {
    try {
      await rateLimiter.acquire();
      const result = await this.client.conversations.info({ channel: channelId });
      return (result.channel as { name?: string })?.name ?? channelId;
    } catch {
      return channelId;
    }
  }

  /**
   * Get user info (name) by ID.
   */
  async getUserInfo(
    userId: string
  ): Promise<{ name: string; realName: string; email?: string }> {
    try {
      await rateLimiter.acquire();
      const result = await this.client.users.info({ user: userId });
      const user = result.user as {
        name?: string;
        real_name?: string;
        profile?: { display_name?: string; email?: string };
      };
      const email = user?.profile?.email?.trim().toLowerCase() || undefined;
      return {
        name: user?.name ?? userId,
        realName: user?.real_name ?? user?.profile?.display_name ?? userId,
        email,
      };
    } catch {
      return { name: userId, realName: userId };
    }
  }

  /**
   * Human messages in a thread (for context when filing issues from a thread reply).
   */
  async getThreadContext(
    channelId: string,
    threadTs: string,
    excludeTs?: string
  ): Promise<string> {
    return this.getCollaborationThreadContext(channelId, threadTs, {
      excludeTs,
      humanOnly: true,
    });
  }

  /**
   * Thread context for PRD / issue — includes Claude (or other) bot replies when configured.
   */
  async getCollaborationThreadContext(
    channelId: string,
    threadTs: string,
    opts?: { excludeTs?: string; humanOnly?: boolean }
  ): Promise<string> {
    try {
      await rateLimiter.acquire();
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 40,
      });

      const claudeId = config.slack.claudeBotUserId;
      const claudeLabel = config.slack.claudeBotName;
      const ownBotId = config.slack.botUserId;

      const lines: string[] = [];

      for (const m of result.messages ?? []) {
        if (m.ts === opts?.excludeTs) continue;
        const subtype = (m as { subtype?: string }).subtype;
        if (subtype && subtype !== 'bot_message') continue;

        const text = (m.text ?? '').trim();
        if (!text) continue;

        const userId = m.user ?? (m as { bot_id?: string }).bot_id;
        const isOwnBot = ownBotId && userId === ownBotId;
        if (isOwnBot) continue;

        if (opts?.humanOnly) {
          if (m.bot_id) continue;
          lines.push(text);
          continue;
        }

        if (claudeId && m.user === claudeId) {
          lines.push(`[${claudeLabel}]: ${text}`);
        } else if (m.bot_id) {
          lines.push(`[bot ${userId ?? 'unknown'}]: ${text.slice(0, 500)}`);
        } else {
          lines.push(text);
        }
      }

      return lines.join('\n');
    } catch (err) {
      log.warn('Failed to load thread context', { error: (err as Error).message, channelId, threadTs });
      return '';
    }
  }

  async updateMessage(
    channelId: string,
    messageTs: string,
    text: string,
    blocks?: Record<string, unknown>[]
  ): Promise<void> {
    await rateLimiter.acquire();
    await withRetry(() =>
      this.client.chat.update({
        channel: channelId,
        ts: messageTs,
        text,
        blocks: blocks as never,
      })
    );
  }

  /**
   * Post PRD blocks in the tracking thread and optionally ping Claude.
   */
  async postPrdDraft(
    channelId: string,
    threadTs: string,
    prd: AdkPrd,
    opts?: { githubUrl?: string }
  ): Promise<void> {
    const claudeMention = config.slack.claudeBotUserId
      ? `<@${config.slack.claudeBotUserId}>`
      : undefined;

    const blocks = buildPrdBlocks(prd, {
      githubUrl: opts?.githubUrl,
      claudeMention,
    });

    await this.postMessageWithThreadFallback(
      channelId,
      `PRD: ${prd.title}`,
      threadTs,
      blocks
    );

    if (config.slack.claudeBotUserId) {
      const handoff = `${claudeMention} ${prd.claudeHandoffPrompt}`.slice(0, 3900);
      await rateLimiter.acquire();
      await withRetry(() =>
        this.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: handoff,
          unfurl_links: false,
        })
      );
      log.info('Posted Claude handoff in thread', { channelId, threadTs });
    }
  }

  async postPrdOnlyReply(
    channelId: string,
    threadTs: string | undefined,
    prd: AdkPrd
  ): Promise<void> {
    await this.postPrdDraft(channelId, threadTs ?? '', prd);
    log.info('Posted standalone PRD', { channelId });
  }

  private isCannotReplyError(err: unknown): boolean {
    const code = (err as { data?: { error?: string } })?.data?.error;
    return code === 'cannot_reply_to_message';
  }

  /**
   * Post a message; threads under threadTs when allowed, otherwise posts to channel.
   * Slack returns cannot_reply_to_message for some top-level messages — we fall back.
   */
  async postMessageWithThreadFallback(
    channelId: string,
    text: string,
    threadTs?: string,
    blocks?: Record<string, unknown>[]
  ): Promise<{ ts: string; threaded: boolean }> {
    const payload = {
      channel: channelId,
      text,
      blocks: blocks as never,
      unfurl_links: false,
    };

    if (threadTs) {
      try {
        await rateLimiter.acquire();
        const res = await this.client.chat.postMessage({
          ...payload,
          thread_ts: threadTs,
        });
        if (!res.ts) throw new Error('postMessage missing ts');
        log.info('Posted message in thread', { channelId, threadTs });
        return { ts: res.ts, threaded: true };
      } catch (err) {
        if (!this.isCannotReplyError(err)) throw err;
        log.warn('Thread reply not allowed; posting to channel instead', { channelId, threadTs });
      }
    }

    await rateLimiter.acquire();
    const res = await withRetry(() => this.client.chat.postMessage(payload));
    if (!res.ts) throw new Error('postMessage missing ts');
    log.info('Posted message to channel', { channelId });
    return { ts: res.ts, threaded: false };
  }

  /**
   * Reply to an @bot question (advisor). Prefers a thread under the user's message when possible.
   */
  async postAdvisorReply(
    channelId: string,
    threadTs: string | undefined,
    text: string,
    blocks?: Record<string, unknown>[]
  ): Promise<void> {
    await withRetry(() =>
      this.postMessageWithThreadFallback(channelId, text, threadTs, blocks)
    );
  }

  async setChannelTopic(channelId: string, topic: string): Promise<void> {
    if (!config.slack.setChannelMetaOnSetup) {
      log.debug('Skipped setChannelTopic (SLACK_SET_CHANNEL_META is not enabled)', { channelId });
      return;
    }
    await rateLimiter.acquire();
    await this.client.conversations.setTopic({ channel: channelId, topic });
    log.info('Set channel topic', { channelId });
  }

  async setChannelPurpose(channelId: string, purpose: string): Promise<void> {
    if (!config.slack.setChannelMetaOnSetup) {
      log.debug('Skipped setChannelPurpose (SLACK_SET_CHANNEL_META is not enabled)', { channelId });
      return;
    }
    await rateLimiter.acquire();
    await this.client.conversations.setPurpose({ channel: channelId, purpose });
    log.info('Set channel purpose', { channelId });
  }

  async postChannelMessage(
    channelId: string,
    text: string,
    blocks?: Record<string, unknown>[],
    threadTs?: string
  ): Promise<{ ts: string }> {
    if (threadTs) {
      const posted = await this.postMessageWithThreadFallback(channelId, text, threadTs, blocks);
      return { ts: posted.ts };
    }
    await rateLimiter.acquire();
    const res = await withRetry(() =>
      this.client.chat.postMessage({
        channel: channelId,
        text,
        blocks: blocks as never,
        unfurl_links: false,
      })
    );
    if (!res.ts) throw new Error('postMessage missing ts');
    return { ts: res.ts };
  }

  async postThreadReply(channelId: string, threadTs: string, text: string): Promise<void> {
    await this.postMessageWithThreadFallback(channelId, text, threadTs);
  }

  async uploadFile(params: {
    channelId: string;
    threadTs?: string;
    filename: string;
    buffer: Buffer;
    title?: string;
    initialComment?: string;
  }): Promise<void> {
    await rateLimiter.acquire();
    await withRetry(() =>
      this.client.files.uploadV2({
        channel_id: params.channelId,
        thread_ts: params.threadTs,
        filename: params.filename,
        file: params.buffer,
        title: params.title ?? params.filename,
        initial_comment: params.initialComment,
      })
    );
    log.info('Uploaded file to Slack', {
      channelId: params.channelId,
      filename: params.filename,
      threadTs: params.threadTs,
    });
  }

  async postEphemeral(
    channelId: string,
    userId: string,
    text: string,
    blocks?: Record<string, unknown>[],
    threadTs?: string
  ): Promise<void> {
    await rateLimiter.acquire();
    try {
      await this.client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text,
        blocks: blocks as never,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (err) {
      if (threadTs && this.isCannotReplyError(err)) {
        await this.client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text,
          blocks: blocks as never,
        });
        return;
      }
      throw err;
    }
  }

  async pinMessage(channelId: string, messageTs: string): Promise<void> {
    await rateLimiter.acquire();
    await this.client.pins.add({ channel: channelId, timestamp: messageTs });
    log.info('Pinned message', { channelId, messageTs });
  }

  /**
   * Resolve Slack user by workspace email (requires users:read.email).
   */
  async lookupUserByEmail(
    email: string
  ): Promise<{ id: string; name: string } | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;

    try {
      await rateLimiter.acquire();
      const result = await withRetry(() =>
        this.client.users.lookupByEmail({ email: normalized })
      );
      const user = result.user as { id?: string; real_name?: string; name?: string };
      if (!user?.id) return null;
      return {
        id: user.id,
        name: user.real_name ?? user.name ?? normalized,
      };
    } catch (err) {
      const code = (err as { data?: { error?: string } })?.data?.error;
      if (code === 'users_not_found') {
        log.warn('Slack user not found for email', { email: normalized });
        return null;
      }
      throw new Error(formatSlackApiError(err));
    }
  }

  /**
   * Open (or reuse) a DM channel with a user.
   */
  async openDirectMessageChannel(userId: string): Promise<string> {
    await rateLimiter.acquire();
    const result = await withRetry(() =>
      this.client.conversations.open({ users: userId })
    );
    const channelId = (result.channel as { id?: string })?.id;
    if (!channelId) {
      throw new Error('conversations.open did not return a channel id');
    }
    return channelId;
  }

  /**
   * Post a direct message to a user; returns channel + message ts for pinning.
   */
  async sendDirectMessage(
    userId: string,
    text: string,
    blocks?: Record<string, unknown>[]
  ): Promise<{ channelId: string; ts: string }> {
    const channelId = await this.openDirectMessageChannel(userId);
    await rateLimiter.acquire();
    const res = await withRetry(() =>
      this.client.chat.postMessage({
        channel: channelId,
        text,
        blocks: blocks as never,
        unfurl_links: false,
      })
    );
    if (!res.ts) throw new Error('postMessage missing ts');
    log.info('Sent direct message', { userId, channelId });
    return { channelId, ts: res.ts };
  }

  async findPinnedMessageByMarker(
    channelId: string,
    marker: string
  ): Promise<string | null> {
    try {
      await rateLimiter.acquire();
      const res = await this.client.pins.list({ channel: channelId });
      for (const item of res.items ?? []) {
        const message = (item as { message?: { text?: string; ts?: string } }).message;
        const text = message?.text ?? '';
        if (text.includes(marker)) {
          return message?.ts ?? null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get a permalink for a message.
   */
  async getPermalink(channelId: string, messageTs: string): Promise<string | undefined> {
    try {
      await rateLimiter.acquire();
      const result = await this.client.chat.getPermalink({
        channel: channelId,
        message_ts: messageTs,
      });
      return result.permalink ?? undefined;
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------
  // Block builders
  // -----------------------------------------------

  private buildTrackingThreadBlocks(
    message: ParsedSlackMessage,
    assignment: IssueAssignment,
    issueId: string,
    githubIssue?: GitHubIssueRef,
    triage?: TriageDecision,
    guidelines?: DerivedIssueGuidelines,
    validationWarnings: string[] = []
  ) {
    const githubSection = githubIssue
      ? {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*GitHub Issue:*\n<${githubIssue.issueUrl}|#${githubIssue.issueNumber} — ${githubIssue.issueTitle}>`,
          },
        }
      : {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*GitHub Issue:* _Creating..._',
          },
        };

    const triageSummary =
      triage
        ? `Chosen \`${assignment.githubUsername}\` (score ${triage.chosen.score}; ${triage.chosen.signals.map(s => s.kind).join(', ') || 'no signals'})`
        : undefined;

    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🎯 CE-Tech Tracking Thread Created',
          emoji: true,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Issue Type:*\n${message.hashtags.join(', ')}`,
          },
          {
            type: 'mrkdwn',
            text: `*Priority:*\n${formatPriority(message.priority)}`,
          },
          {
            type: 'mrkdwn',
            text: assignment.primaryOwnerId && /^U[A-Z0-9]+$/.test(assignment.primaryOwnerId)
              ? `*Assigned To:*\n<@${assignment.primaryOwnerId}> (${assignment.primaryOwnerName}) • GitHub @${assignment.githubUsername}`
              : `*Assigned To:*\n${assignment.primaryOwnerName} • GitHub @${assignment.githubUsername}`,
          },
          {
            type: 'mrkdwn',
            text: `*Status:*\n${formatStatus('open')}`,
          },
        ],
      },
      githubSection,
      ...(guidelines
        ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `*TSS project fields set*\n` +
                guidelines.appliedFields.map(f => `• *${f.field}:* ${f.value}`).join('\n') +
                (guidelines.parentIssueNumber
                  ? `\n• *Parent:* #${guidelines.parentIssueNumber}`
                  : '') +
                `\n• <${TSS_PROJECT_URL}|View on ${guidelines.projectName}>`,
            },
          }]
        : []),
      ...(triageSummary
        ? [{
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `*Triage:* ${triageSummary}` }],
          }]
        : []),
      ...(validationWarnings.length > 0
        ? [{
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `⚠️ ${validationWarnings.join(' · ')}`,
              },
            ],
          }]
        : []),
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*CE-Tech Issue ID:*\n\`${issueId}\``,
          },
          {
            type: 'mrkdwn',
            text: `*Created At:*\n${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
          },
        ],
      },
      {
        type: 'divider',
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🤖 Auto-created by CE-Tech Automation • ID: \`${issueId}\`${
              assignment.secondaryOwnerIds.length
                ? ` • CC: ${assignment.secondaryOwnerIds.map(id => `<@${id}>`).join(', ')}`
                : ''
            }`,
          },
        ],
      },
    ];
  }

  private buildStatusUpdateBlocks(
    updateType: string,
    details: Record<string, unknown>,
    currentStatus: IssueStatus
  ) {
    const updateMessages: Record<string, string> = {
      pr_opened: `🔃 *PR Opened*\n<${details.prUrl as string}|#${details.prNumber} — ${details.prTitle}>`,
      pr_merged: `✅ *PR Merged*\nPull request has been merged.`,
      issue_closed: `🔒 *Issue Closed*\nThe GitHub issue has been closed.`,
      status_change: `🔄 *Status Updated* → ${formatStatus(currentStatus)}`,
    };

    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: updateMessages[updateType] ?? `Status: ${formatStatus(currentStatus)}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Updated at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
          },
        ],
      },
    ];
  }
}

export const slackService = SlackService.getInstance();
