import { App, GenericMessageEvent } from '@slack/bolt';
import { config } from '../config';
import { createSocketModeReceiver } from '../receivers/socketModeReceiver';
import { createLogger } from '../utils/logger';
import { parseSlackMessage, extractHashtags } from '../utils/messageParser';
import { issueService } from '../services/issue';
import { slackService } from '../services/slack';
import {
  parseSlackIntent,
  stripSlackMarkup,
  wantsCreateIssue,
  extractCreateIssueBody,
  extractDeveloperWorkloadQuery,
} from '../services/intent';
import { advisorService } from '../services/advisor';
import { adkService } from '../services/adkService';
import {
  buildGuidelinesBlocks,
  buildGuidelinesMrkdwn,
  formatBotPrompt,
  MRSOUL_PROMPTS,
} from '../content/mrsoulGuidelines';
import { buildIssueCreationErrorBlocks } from '../content/issueCreationErrors';
import { activityFeed } from '../services/activityFeed';
import { slackLiveOps } from '../services/slackLiveOps';
import { prdService } from '../services/prdService';
import { wantsPrd } from '../services/intent';
import { ticketFlowService } from '../services/ticketFlow';
import { groqAdvisorService } from '../services/groqAdvisor';
import { registerCreateTicketHandlers } from './createTicketHandlers';
import { enforceSlackAccess, requireSlackWriteAccess } from '../services/slackAccess';

const log = createLogger('slack-app');

function textAfterBotMention(text: string): string {
  if (!config.slack.botUserId) return stripSlackMarkup(text);
  return stripSlackMarkup(text.replace(new RegExp(`<@${config.slack.botUserId}>`, 'g'), '')).trim();
}

function isBareBotMention(text: string): boolean {
  const after = textAfterBotMention(text);
  return !after || /^(help|hi|hello|hey|guidelines|guide|\?)$/i.test(after);
}

function registerMrSoulUxHandlers(app: App): void {
  // Typing `/mrsoul` shows the guide (ephemeral — only you see it). Register command in Slack app settings.
  app.command('/mrsoul', async ({ command, ack, respond }) => {
    await ack();

    if (config.accessControl.enabled) {
      const gate = await enforceSlackAccess({
        slackUserId: command.user_id,
        channelId: command.channel_id,
        text: '/mrsoul',
        checkOnly: true,
      });
      if (!gate.proceed) {
        await respond({
          response_type: 'ephemeral',
          text: gate.access.reason ?? 'Access denied.',
        });
        return;
      }
    }

    await respond({
      response_type: 'ephemeral',
      text: buildGuidelinesMrkdwn(),
      blocks: buildGuidelinesBlocks() as never,
    });
    log.info('Slash /mrsoul', { user: command.user_id, channel: command.channel_id });
  });

  for (const prompt of MRSOUL_PROMPTS) {
    app.action(prompt.id, async ({ ack, body }) => {
      await ack();
      const userId = body.user.id;
      const channelId = (body as { channel?: { id?: string } }).channel?.id;
      if (!channelId) return;

      const threadTs = (body as { message?: { thread_ts?: string } }).message?.thread_ts;
      const value =
        (body as { actions?: Array<{ value?: string }> }).actions?.[0]?.value ?? prompt.message;
      const copyText = formatBotPrompt(config.slack.botUserId, value);

      await slackService.postEphemeral(
        channelId,
        userId,
        `*Suggested message — copy and send:*\n\`\`\`${copyText}\`\`\``,
        undefined,
        threadTs
      );
    });
  }
}

export function createSlackApp(): App {
  const useSocketMode = Boolean(config.slack.appToken);
  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    ...(useSocketMode
      ? {
          socketMode: true,
          appToken: config.slack.appToken,
          receiver: createSocketModeReceiver(),
        }
      : {}),
  });

  // ============================================================
  // Message Event Handler
  // ============================================================
  app.message(async ({ message }) => {
    try {
      const msg = message as GenericMessageEvent;

      // ---- Guard rails ----

      // Ignore bot messages (including our own)
      if (msg.subtype === 'bot_message' || msg.bot_id) return;

      // Ignore message edits
      if (msg.subtype === 'message_changed' || msg.subtype === 'message_deleted') return;

      // Ignore messages from our own bot
      if (config.slack.botUserId && msg.user === config.slack.botUserId) return;

      // Check if this channel is monitored
      const channelId = msg.channel;
      if (!isMonitoredChannel(channelId)) return;

      const text = (msg.text ?? '').trim();
      if (!text) return;

      const isThreadReply = Boolean(msg.thread_ts && msg.thread_ts !== msg.ts);
      const threadRootTs = msg.thread_ts ?? msg.ts;

      let accessGate: Awaited<ReturnType<typeof enforceSlackAccess>> | null = null;
      if (msg.user && config.accessControl.enabled) {
        accessGate = await enforceSlackAccess({
          slackUserId: msg.user,
          channelId,
          text,
          threadTs: isThreadReply ? threadRootTs : undefined,
        });
        if (!accessGate.proceed) return;
      }

      // /create-ticket thread: approve, reject, revise, or raise GitHub issue
      if (isThreadReply && msg.thread_ts && ticketFlowService.isEnabled()) {
        if (
          accessGate &&
          !(await requireSlackWriteAccess({
            channelId,
            slackUserId: msg.user ?? '',
            threadTs: threadRootTs,
            access: accessGate.access,
          }))
        ) {
          return;
        }
        const consumed = await ticketFlowService.handleThreadReply({
          channelId,
          threadTs: msg.thread_ts,
          userId: msg.user ?? '',
          text,
        });
        if (consumed) return;
      }

      const botMentioned =
        Boolean(config.slack.botUserId) &&
        text.includes(`<@${config.slack.botUserId}>`);

      const hashtags = extractHashtags(text);
      const createIssue = wantsCreateIssue(text, hashtags.length > 0);
      const developerWorkloadQuery = extractDeveloperWorkloadQuery(text);

      // Top-level: hashtags, @bot, workload questions, or thread follow-ups (create issue / continue chat).
      const continueThreadChat =
        isThreadReply &&
        botMentioned &&
        !createIssue &&
        !hashtags.length &&
        text.length >= 3;

      if (!botMentioned && hashtags.length === 0 && !developerWorkloadQuery) {
        if (!isThreadReply || !createIssue) {
          if (!continueThreadChat) return;
        }
      }

      log.info('Trigger message detected', {
        channel: channelId,
        hashtags,
        botMentioned,
        createIssue,
        isThreadReply,
        ts: msg.ts,
      });

      const channelName = await slackService.getChannelName(channelId);

      activityFeed.emitActivity({
        level: 'info',
        source: 'slack',
        title: 'Slack message received',
        detail: `${channelName}: ${text.slice(0, 140)}`,
        meta: {
          channelId,
          messageTs: msg.ts,
          threadRootTs,
          hashtags,
          botMentioned,
          createIssue,
        },
      });
      const userInfo = await slackService.getUserInfo(msg.user ?? '');
      const permalink = await slackService.getPermalink(channelId, msg.ts);
      const teamId = msg.team ?? config.slack.botToken.split('-')[0];
      let intent = parseSlackIntent(stripSlackMarkup(text), { hasHashtags: hashtags.length > 0 });

      // "what is Akriti working on" — always workload lookup, never task-suggestion fallback
      if (developerWorkloadQuery && !createIssue) {
        intent = { kind: 'developer_workload', developerQuery: developerWorkloadQuery };
      }

      // ADK intent classifier for @bot messages (regex stays primary for hashtags/workload)
      if (
        config.adk.useIntentClassifier &&
        adkService.isEnabled() &&
        botMentioned &&
        !createIssue &&
        !developerWorkloadQuery &&
        intent.kind === 'task_suggestion'
      ) {
        try {
          const adkIntent = await adkService.classifyIntent(text, {
            hasHashtags: hashtags.length > 0,
          });
          if (adkIntent && adkIntent.kind !== 'create_issue') {
            intent = adkIntent;
            log.info('ADK intent override', { kind: intent.kind });
          }
        } catch (err) {
          log.warn('ADK intent classification failed; using regex intent', {
            error: (err as Error).message,
          });
        }
      }

      // @MrSoul alone (or "help") → guidelines + suggestion buttons (ephemeral)
      if (botMentioned && isBareBotMention(text) && !createIssue) {
        await slackService.postEphemeral(
          channelId,
          msg.user ?? '',
          buildGuidelinesMrkdwn(),
          buildGuidelinesBlocks(),
          isThreadReply ? threadRootTs : undefined
        );
        return;
      }

      // PRD-only: @MrSoul #prd or "write a PRD" without filing an issue
      if (botMentioned && wantsPrd(text) && !createIssue && prdService.shouldGenerateStandalone(text)) {
        if (
          accessGate &&
          msg.user &&
          !(await requireSlackWriteAccess({
            channelId,
            slackUserId: msg.user,
            threadTs: threadRootTs,
            access: accessGate.access,
          }))
        ) {
          return;
        }
          await slackLiveOps.startPipeline(channelId, threadRootTs, msg.ts);
          const collabContext = await slackService.getCollaborationThreadContext(
            channelId,
            threadRootTs,
            { excludeTs: msg.ts }
          );
          const parsed = parseSlackMessage(
            text,
            msg.ts,
            channelId,
            channelName,
            msg.user ?? 'unknown',
            userInfo.realName,
            teamId,
            permalink,
            isThreadReply ? msg.thread_ts : undefined
          );
          slackService
            .postAdvisorReply(channelId, threadRootTs, '_Drafting PRD…_')
            .catch(() => undefined);
          prdService
            .generate(parsed, collabContext)
            .then(async prd => {
              if (!prd) {
                await slackService.postAdvisorReply(
                  channelId,
                  threadRootTs,
                  'Could not generate a PRD. Ensure ADK is enabled (`ADK_ENABLED` + `GEMINI_API_KEY`).'
                );
                return;
              }
              await slackService.postPrdDraft(channelId, threadRootTs, prd);
              activityFeed.emitActivity({
                level: 'success',
                source: 'issue',
                title: 'Issue pipeline complete',
                detail: 'PRD-only flow',
                meta: { channelId, messageTs: msg.ts, threadRootTs },
              });
            })
            .catch(err => {
              slackLiveOps.endPipeline(channelId, msg.ts, (err as Error).message);
            });
        return;
      }

      // Advisor: @bot questions, or "what is X working on" without @bot (members OK)
      if (
        intent.kind !== 'create_issue' &&
        intent.kind !== 'task_suggestion' &&
        (botMentioned || intent.kind === 'developer_workload' || intent.kind === 'team_roster')
      ) {
        log.info('Advisor query', { intent: intent.kind, ts: msg.ts, isThreadReply });
        activityFeed.emitActivity({
          level: 'info',
          source: 'slack',
          title: `Advisor: ${intent.kind}`,
          detail: text.slice(0, 160),
        });

        const threadAnchor = isThreadReply ? threadRootTs : msg.ts;

        const thinking = groqAdvisorService.isEnabled()
          ? '_Thinking with live GitHub context…_'
          : '_Looking up project board…_';
        slackService.postAdvisorReply(channelId, threadAnchor, thinking).catch(() => undefined);

        advisorService
          .handleIntent(intent, {
            channelId,
            channelName,
            messageTs: msg.ts,
            userId: msg.user ?? 'unknown',
            userName: userInfo.realName,
            teamId,
            rawText: text,
            threadTs: isThreadReply ? threadRootTs : undefined,
          })
          .then(reply => {
            activityFeed.emitActivity({
              level: 'success',
              source: 'slack',
              title: 'Advisor reply posted',
              detail: intent.kind,
            });
            return slackService.postAdvisorReply(channelId, threadAnchor, reply.text, reply.blocks);
          })
          .catch(err => {
            log.error('Advisor query failed', { error: (err as Error).message, messageTs: msg.ts });
            activityFeed.emitActivity({
              level: 'error',
              source: 'slack',
              title: 'Advisor query failed',
              detail: (err as Error).message,
            });
            slackService
              .postAdvisorReply(
                channelId,
                threadAnchor,
                'Sorry, I could not analyze that right now. Try again in a moment or check GitHub project connectivity.'
              )
              .catch(() => undefined);
          });
        return;
      }

      // Task assignment / ownership suggestions — admin & super admin only
      if (intent.kind === 'task_suggestion' && (botMentioned || createIssue)) {
        if (
          accessGate &&
          msg.user &&
          !(await requireSlackWriteAccess({
            channelId,
            slackUserId: msg.user,
            threadTs: threadRootTs,
            access: accessGate.access,
          }))
        ) {
          return;
        }
        log.info('Advisor task suggestion', { ts: msg.ts });
        const threadAnchor = isThreadReply ? threadRootTs : msg.ts;
        const userInfo = await slackService.getUserInfo(msg.user ?? '');
        advisorService
          .handleIntent(intent, {
            channelId,
            channelName,
            messageTs: msg.ts,
            userId: msg.user ?? 'unknown',
            userName: userInfo.realName,
            teamId: msg.team ?? config.slack.botToken.split('-')[0],
            rawText: text,
            threadTs: isThreadReply ? threadRootTs : undefined,
          })
          .then(reply => slackService.postAdvisorReply(channelId, threadAnchor, reply.text, reply.blocks))
          .catch(() => undefined);
        return;
      }

      if (
        config.accessControl.enabled &&
        msg.user &&
        !(await requireSlackWriteAccess({
          channelId,
          slackUserId: msg.user,
          threadTs: threadRootTs,
          access: accessGate?.access ?? { allowed: true, role: 'super_admin' },
        }))
      ) {
        return;
      }

      let issueText = text;
      const createBody = extractCreateIssueBody(text);
      if (createBody !== null) {
        issueText = createBody.length > 0 ? createBody : text;
      }

      if (isThreadReply && msg.thread_ts) {
        const threadContext = await slackService.getThreadContext(
          channelId,
          msg.thread_ts,
          msg.ts
        );
        if (threadContext) {
          const cleanedContext = stripSlackMarkup(threadContext);
          issueText =
            createBody !== null && createBody.length > 0
              ? `${issueText}\n\n_Context from thread:_\n${cleanedContext}`
              : cleanedContext || issueText;
        }
      }

      const parsedMessage = parseSlackMessage(
        issueText,
        msg.ts,
        channelId,
        channelName,
        msg.user ?? 'unknown',
        userInfo.realName,
        teamId,
        permalink,
        isThreadReply ? msg.thread_ts : undefined
      );

      activityFeed.emitActivity({
        level: 'info',
        source: 'issue',
        title: 'Creating GitHub issue from Slack',
        detail: parsedMessage.hashtags.join(' ') || 'no hashtags',
        meta: {
          channelId,
          messageTs: msg.ts,
          threadRootTs,
          priority: parsedMessage.priority,
        },
      });

      await slackLiveOps.startPipeline(channelId, threadRootTs, msg.ts);

      issueService.processSlackMessage(parsedMessage).catch(err => {
        log.error('Failed to process Slack message into issue', {
          error: err.message,
          messageTs: msg.ts,
        });
        const errText = (err as Error).message;
        activityFeed.emitActivity({
          level: 'error',
          source: 'issue',
          title: 'Issue creation failed',
          detail: errText,
          meta: { channelId, messageTs: msg.ts, threadRootTs },
        });
        slackLiveOps.endPipeline(channelId, msg.ts, errText);
        slackService
          .postAdvisorReply(
            channelId,
            threadRootTs,
            `Could not create the GitHub issue:\n${errText}`,
            buildIssueCreationErrorBlocks(errText)
          )
          .catch(() => undefined);
      });
    } catch (err) {
      log.error('Slack message handler error', { error: (err as Error).message });
    }
  });

  // ============================================================
  // App Home opened (optional — requires App Home + views:write in Slack app)
  // ============================================================
  const appHomeEnabled = ['1', 'true', 'yes', 'on'].includes(
    (process.env.SLACK_APP_HOME_ENABLED ?? '').toLowerCase()
  );

  if (appHomeEnabled) {
  app.event('app_home_opened', async ({ event, client }) => {
    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: 'home',
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '🎯 CE-Tech Automation Platform', emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Post with hashtags to create issues, or @mention me in a channel or *thread*: `what is Akriti working on?`, `who should work on …`, then `create issue …` in the same thread.',
              },
            },
            {
              type: 'divider',
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*Monitored Channels:*\n' +
                  config.slack.monitoredChannels.map(c => `• ${c}`).join('\n'),
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*Priority Tags:*\n• `#critical` or `#urgent` → High priority\n• `#high`, `#medium`, `#low` → Normal priority',
              },
            },
          ],
        },
      });
    } catch (err) {
      const e = err as Error & { code?: string; data?: { error?: string } };
      log.warn('App home publish skipped', {
        error: e.message,
        code: e.code,
        slackError: e.data?.error,
      });
    }
  });
  }

  // ============================================================
  // Error handler
  // ============================================================
  registerMrSoulUxHandlers(app);
  registerCreateTicketHandlers(app);

  app.error(async (error) => {
    log.error('Slack app error', { error: error.message, stack: error.stack });
  });

  return app;
}

/**
 * Check if a channel is in the monitored list.
 * Supports both channel IDs (C...) and channel names.
 */
function isMonitoredChannel(channelId: string): boolean {
  const monitored = config.slack.monitoredChannels;

  if (monitored.includes('*')) return true;
  if (monitored.includes(channelId)) return true;
  if (config.isDev && monitored.length === 0) return true;

  return false;
}
