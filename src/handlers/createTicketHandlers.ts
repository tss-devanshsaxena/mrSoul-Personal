import { App } from '@slack/bolt';
import { CREATE_TICKET_MODAL_CALLBACK } from '../content/ticketFlowBlocks';
import {
  TICKET_FLOW_ACTION_APPROVE,
  TICKET_FLOW_ACTION_REJECT,
} from '../content/ticketFlowBlocks';
import { ticketFlowService } from '../services/ticketFlow';
import { slackService } from '../services/slack';
import { enforceSlackAccess, requireSlackWriteAccess } from '../services/slackAccess';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('create-ticket');

const MODAL_BLOCK_ID = 'ticket_details_block';
const MODAL_ACTION_ID = 'ticket_details_input';

export function registerCreateTicketHandlers(app: App): void {
  app.command('/create-ticket', async ({ command, ack, client, respond }) => {
    await ack();

    if (config.accessControl.enabled) {
      const gate = await enforceSlackAccess({
        slackUserId: command.user_id,
        channelId: command.channel_id,
        text: command.text ?? '/create-ticket',
        allowAdminCommands: false,
      });
      if (!gate.proceed) {
        await respond({
          response_type: 'ephemeral',
          text: gate.access.reason ?? 'Access denied.',
        });
        return;
      }
      if (
        !(await requireSlackWriteAccess({
          channelId: command.channel_id,
          slackUserId: command.user_id,
          access: gate.access,
        }))
      ) {
        return;
      }
    }

    if (!ticketFlowService.isEnabled()) {
      await respond({
        response_type: 'ephemeral',
        text:
          '`/create-ticket` needs Groq. Add `GROQ_API_KEY` to `.env` and restart the bot.',
      });
      return;
    }

    const inlineText = command.text?.trim() ?? '';
    const userInfo = await slackService.getUserInfo(command.user_id);

    if (inlineText.length >= 12) {
      const result = await ticketFlowService.startFlow({
        channelId: command.channel_id,
        userId: command.user_id,
        userName: userInfo.realName,
        rawInput: inlineText,
        teamId: command.team_id ?? '',
      });

      if (!result.ok) {
        await respond({ response_type: 'ephemeral', text: result.error });
        return;
      }

      await respond({
        response_type: 'ephemeral',
        text:
          'Ticket flow started in this channel. Review the problem summary in the thread, then *Approve*, comment, or *Reject*.',
      });
      return;
    }

    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: {
          type: 'modal',
          callback_id: CREATE_TICKET_MODAL_CALLBACK,
          title: { type: 'plain_text', text: 'Create ticket' },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Cancel' },
          private_metadata: JSON.stringify({
            channelId: command.channel_id,
            userId: command.user_id,
          }),
          blocks: [
            {
              type: 'input',
              block_id: MODAL_BLOCK_ID,
              label: {
                type: 'plain_text',
                text: 'Describe the problem or request',
              },
              element: {
                type: 'plain_text_input',
                action_id: MODAL_ACTION_ID,
                multiline: true,
                placeholder: {
                  type: 'plain_text',
                  text:
                    'Example: We need affiliate trackable links for influencers sending product links in DMs…',
                },
              },
            },
          ],
        },
      });
    } catch (err) {
      log.error('Failed to open create-ticket modal', { error: (err as Error).message });
      await respond({
        response_type: 'ephemeral',
        text: 'Could not open the form. Add `views:write` scope to the Slack app and reinstall.',
      });
    }
  });

  app.view(CREATE_TICKET_MODAL_CALLBACK, async ({ ack, view, body }) => {
    const meta = JSON.parse(view.private_metadata || '{}') as {
      channelId?: string;
      userId?: string;
    };
    const channelId = meta.channelId;
    const userId = meta.userId ?? body.user.id;

    if (!channelId) {
      await ack();
      return;
    }

    if (config.accessControl.enabled) {
      const gate = await enforceSlackAccess({
        slackUserId: userId,
        channelId,
        text: '/create-ticket',
        allowAdminCommands: false,
      });
      if (!gate.proceed) {
        await ack();
        await slackService.postEphemeral(channelId, userId, gate.access.reason ?? 'Access denied.');
        return;
      }
      if (
        !(await requireSlackWriteAccess({
          channelId,
          slackUserId: userId,
          access: gate.access,
        }))
      ) {
        await ack();
        return;
      }
    }

    await ack();

    const rawInput =
      view.state.values[MODAL_BLOCK_ID]?.[MODAL_ACTION_ID]?.value?.trim() ?? '';

    const userInfo = await slackService.getUserInfo(userId);
    const result = await ticketFlowService.startFlow({
      channelId,
      userId,
      userName: userInfo.realName,
      rawInput,
      teamId: body.team?.id ?? '',
    });

    if (!result.ok) {
      await slackService.postEphemeral(channelId, userId, result.error);
    }
  });

  app.action(TICKET_FLOW_ACTION_APPROVE, async ({ ack, body, action }) => {
    await ack();
    const channelId = (body as { channel?: { id?: string } }).channel?.id;
    if (channelId && config.accessControl.enabled) {
      const gate = await enforceSlackAccess({
        slackUserId: body.user.id,
        channelId,
        text: 'approve',
        allowAdminCommands: false,
      });
      if (!gate.proceed) return;
      if (
        !(await requireSlackWriteAccess({
          channelId,
          slackUserId: body.user.id,
          access: gate.access,
        }))
      ) {
        return;
      }
    }
    const sessionId = (action as { value?: string }).value;
    if (!sessionId) return;
    await ticketFlowService.handleApprove(sessionId, body.user.id);
  });

  app.action(TICKET_FLOW_ACTION_REJECT, async ({ ack, body, action }) => {
    await ack();
    const channelId = (body as { channel?: { id?: string } }).channel?.id;
    if (channelId && config.accessControl.enabled) {
      const gate = await enforceSlackAccess({
        slackUserId: body.user.id,
        channelId,
        text: 'reject',
        allowAdminCommands: false,
      });
      if (!gate.proceed) return;
      if (
        !(await requireSlackWriteAccess({
          channelId,
          slackUserId: body.user.id,
          access: gate.access,
        }))
      ) {
        return;
      }
    }
    const sessionId = (action as { value?: string }).value;
    if (!sessionId) return;
    await ticketFlowService.handleReject(sessionId, body.user.id);
  });
}
