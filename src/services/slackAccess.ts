import { config } from '../config';
import { accessControlService } from './accessControl';
import { slackService } from './slack';
import { parseAccessAdminCommand } from '../utils/accessCommands';
import { stripSlackMarkup } from './intent';
import type { AccessCheckResult, AccessRole } from '../types/access';
import { MEMBER_WRITE_DENIED_MESSAGE } from '../permissions/accessPermissions';

export type SlackActor = {
  slackUserId: string;
  name: string;
  realName: string;
  email?: string;
};

/**
 * Resolve Slack user + run access-control gate and admin commands.
 */
export async function resolveSlackActor(slackUserId: string): Promise<SlackActor> {
  const info = await slackService.getUserInfo(slackUserId);
  return {
    slackUserId,
    name: info.name,
    realName: info.realName,
    email: info.email,
  };
}

/**
 * Returns true if the event was fully handled (admin command or denial).
 */
export async function enforceSlackAccess(params: {
  slackUserId: string;
  channelId: string;
  text: string;
  threadTs?: string;
  /** Process grant/revoke/list even when checking normal access */
  allowAdminCommands?: boolean;
  /** Only check allowlist — do not run admin command handlers */
  checkOnly?: boolean;
}): Promise<{ proceed: boolean; access: AccessCheckResult }> {
  const actor = await resolveSlackActor(params.slackUserId);
  const cleaned = stripSlackMarkup(params.text);

  if (!params.checkOnly && params.allowAdminCommands !== false) {
    const afterBot =
      config.slack.botUserId ?
        cleaned.replace(new RegExp(`<@${config.slack.botUserId}>`, 'g'), '').trim()
      : cleaned;
    const cmd = parseAccessAdminCommand(afterBot) ?? parseAccessAdminCommand(cleaned);
    const isAdminPhrase =
      cmd &&
      (cmd.kind === 'my_access' ||
        /\b(grant|revoke|remove|delete)\s+access\b/i.test(cleaned) ||
        /\blist\s+access\b/i.test(cleaned));

    if (isAdminPhrase && cmd) {
      if (!actor.email && cmd.kind !== 'my_access') {
        await slackService.postEphemeral(
          params.channelId,
          params.slackUserId,
          'Add your work email to your Slack profile to manage MrSoul access.',
          undefined,
          params.threadTs
        );
        return { proceed: false, access: { allowed: false, reason: 'No email on Slack profile' } };
      }

      const result = await accessControlService.handleAdminCommand(cmd, {
        email: actor.email ?? '',
        slackUserId: actor.slackUserId,
        name: actor.realName,
      });

      if (result.handled) {
        if (result.ephemeral) {
          await slackService.postEphemeral(
            params.channelId,
            params.slackUserId,
            result.message,
            undefined,
            params.threadTs
          );
        } else {
          await slackService.postMessageWithThreadFallback(
            params.channelId,
            result.message,
            params.threadTs
          );
        }
        return { proceed: false, access: { allowed: true } };
      }
    }
  }

  const access = await accessControlService.checkAccess(actor.email);
  if (!access.allowed) {
    await slackService.postEphemeral(
      params.channelId,
      params.slackUserId,
      access.reason ?? 'You do not have access to MrSoul.',
      undefined,
      params.threadTs
    );
    return { proceed: false, access };
  }

  if (actor.email && access.email) {
    await accessControlService
      .getUserByEmail(access.email)
      .then(doc => {
        if (doc && !doc.slackUserId) {
          doc.slackUserId = actor.slackUserId;
          return doc.save();
        }
        return undefined;
      })
      .catch(() => undefined);
  }

  return { proceed: true, access };
}

/**
 * Block *member* role from creating issues, PRDs, tickets, or assignments.
 * Call after enforceSlackAccess when the action is a write.
 */
export async function requireSlackWriteAccess(params: {
  channelId: string;
  slackUserId: string;
  threadTs?: string;
  access: AccessCheckResult;
}): Promise<boolean> {
  if (!config.accessControl.enabled) return true;
  if (accessControlService.canPerformWrites(params.access.role)) return true;

  await slackService.postEphemeral(
    params.channelId,
    params.slackUserId,
    MEMBER_WRITE_DENIED_MESSAGE,
    undefined,
    params.threadTs
  );
  return false;
}

export function getAccessRole(access: AccessCheckResult): AccessRole | undefined {
  return access.role;
}
