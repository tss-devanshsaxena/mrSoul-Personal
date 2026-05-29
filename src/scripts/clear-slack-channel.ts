/**
 * Delete messages posted by MrSoul / this bot.
 *
 * Cannot delete:
 * - "set the channel topic/description" system log lines (Slack: cant_delete_message)
 * - Other people's messages or DMs (unless you archive channels / clear DMs in Slack UI)
 *
 * Usage:
 *   npm run slack:clear -- --dry-run
 *   npm run slack:clear -- --yes
 *   npm run slack:clear -- --channel mrsoul --yes
 *   npm run slack:clear -- --all --yes    # every channel/DM the bot is in (users.conversations)
 */
import dotenv from 'dotenv';
dotenv.config();

import { WebClient } from '@slack/web-api';
import { config } from '../config';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || !args.includes('--yes');
const clearAll = args.includes('--all');
const channelArg = args.find((_, i, a) => a[i - 1] === '--channel') ?? args.find(a => a.startsWith('#'));

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function envChannelIds(): string[] {
  return [...new Set([...config.slack.monitoredChannels, ...config.slack.guidelinesChannels])].filter(
    id => /^[CDG][A-Z0-9]+$/i.test(id)
  );
}

/** Channels/DMs the bot user is actually in — not every public channel in the workspace. */
async function listBotMemberConversations(client: WebClient): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const res = await client.users.conversations({
        types: 'public_channel,private_channel,im,mpim',
        limit: 200,
        cursor,
        exclude_archived: true,
      });
      for (const c of res.channels ?? []) {
        if (c.id) ids.push(c.id);
      }
      cursor = res.response_metadata?.next_cursor;
      await sleep(200);
    } while (cursor);
  } catch (err) {
    const data = (err as { data?: { error?: string; needed?: string } })?.data;
    if (data?.error === 'missing_scope') {
      console.warn(`  users.conversations unavailable: add ${data.needed ?? 'groups:read, im:read'}`);
      return [];
    }
    throw err;
  }
  return ids;
}

async function resolveChannelByName(client: WebClient, name: string): Promise<string> {
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
      cursor,
      exclude_archived: true,
    });
    const hit = res.channels?.find(c => c.name?.toLowerCase() === name);
    if (hit?.id) return hit.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  // Private #mrsoul: list needs groups:read — resolve via .env channel IDs + conversations.info
  for (const id of envChannelIds()) {
    try {
      const info = await client.conversations.info({ channel: id });
      if (info.channel?.name?.toLowerCase() === name) return id;
    } catch {
      /* not accessible */
    }
  }

  throw new Error(
    `Channel not found: #${name}. Set SLACK_MONITORED_CHANNELS to the channel ID, or add groups:read to the Slack app.`
  );
}

async function resolveChannelIds(client: WebClient): Promise<string[]> {
  if (clearAll) {
    const fromEnv = envChannelIds();
    const fromApi = await listBotMemberConversations(client);
    const merged = [...new Set([...fromEnv, ...fromApi])];
    if (fromApi.length === 0) {
      console.warn(
        'Falling back to SLACK_MONITORED_CHANNELS only. For all bot DMs/channels, reinstall app with: groups:read, groups:history, im:read, im:history\n'
      );
    }
    return merged;
  }

  if (channelArg) {
    const raw = channelArg.replace(/^#/, '');
    if (/^[CDG][A-Z0-9]+$/i.test(raw)) return [raw.toUpperCase()];
    return [await resolveChannelByName(client, raw.toLowerCase())];
  }

  return config.slack.guidelinesChannels.length
    ? config.slack.guidelinesChannels
    : config.slack.monitoredChannels;
}

const SYSTEM_LOG_SUBTYPES = new Set([
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_join',
  'channel_leave',
  'channel_archive',
  'group_join',
]);

async function deleteBotMessages(
  client: WebClient,
  botId: string,
  channelId: string,
  label: string,
  dryRunMode: boolean
): Promise<{
  found: number;
  deleted: number;
  failed: number;
  systemLogs: number;
  humanMessages: number;
}> {
  let cursor: string | undefined;
  const toDelete: Array<{ ts: string; preview: string }> = [];
  let systemLogs = 0;
  let humanMessages = 0;

  do {
    const hist = await client.conversations.history({
      channel: channelId,
      limit: 200,
      cursor,
    });

    for (const m of hist.messages ?? []) {
      if (!m.ts) continue;

      if (m.subtype && SYSTEM_LOG_SUBTYPES.has(m.subtype)) {
        systemLogs += 1;
        continue;
      }

      const isBot = m.user === botId || Boolean(m.bot_id) || m.subtype === 'bot_message';
      if (isBot) {
        toDelete.push({
          ts: m.ts,
          preview: (m.text ?? m.subtype ?? '').slice(0, 80),
        });
        continue;
      }

      if (m.user || m.subtype === 'file_share') humanMessages += 1;
    }

    cursor = hist.response_metadata?.next_cursor;
    await sleep(250);
  } while (cursor);

  const extra =
    systemLogs > 0 || humanMessages > 0
      ? ` (${systemLogs} gray system log, ${humanMessages} human — not deletable by bot)`
      : '';
  console.log(`${label}: ${toDelete.length} deletable bot message(s)${extra}`);

  let deleted = 0;
  let failed = 0;

  for (const msg of toDelete) {
    if (dryRunMode) {
      console.log(`  [dry-run] ${msg.ts}: ${msg.preview}`);
      continue;
    }
    try {
      await client.chat.delete({ channel: channelId, ts: msg.ts });
      deleted += 1;
      await sleep(350);
    } catch (err) {
      failed += 1;
      const code = (err as { data?: { error?: string } })?.data?.error;
      if (failed <= 5) console.warn(`  failed ${msg.ts}: ${code}`);
    }
  }

  return { found: toDelete.length, deleted, failed, systemLogs, humanMessages };
}

async function main(): Promise<void> {
  const client = new WebClient(config.slack.botToken);
  const auth = await client.auth.test();
  const botId = auth.user_id;
  if (!botId) throw new Error('Could not resolve bot user id');

  const channelIds = await resolveChannelIds(client);

  console.log(`Bot: ${auth.user} (${botId})`);
  console.log(`Targets: ${channelIds.length} conversation(s)`);
  console.log(
    dryRun
      ? 'DRY RUN — pass --yes to delete\n'
      : 'DELETING deletable bot messages only…\n'
  );

  let totalDeleted = 0;
  let totalFound = 0;
  let totalSystemLogs = 0;
  let totalHuman = 0;

  for (const channelId of channelIds) {
    let label = channelId;
    try {
      const info = await client.conversations.info({ channel: channelId });
      const c = info.channel as { name?: string; is_im?: boolean; user?: string };
      label = c?.is_im ? `DM:${c.user ?? channelId}` : `#${c?.name ?? channelId}`;
    } catch {
      /* ignore */
    }

    try {
      const r = await deleteBotMessages(client, botId, channelId, label, dryRun);
      totalFound += r.found;
      totalDeleted += r.deleted;
      totalSystemLogs += r.systemLogs;
      totalHuman += r.humanMessages;
    } catch (err) {
      const code = (err as { data?: { error?: string } })?.data?.error;
      if (code === 'not_in_channel' || code === 'channel_not_found') {
        continue;
      }
      throw err;
    }
  }

  console.log(
    dryRun
      ? `\nDry run: ${totalFound} bot message(s) across ${channelIds.length} conversation(s).`
      : `\nDeleted ${totalDeleted} bot message(s).`
  );

  if (totalSystemLogs > 0 || totalHuman > 0) {
    console.log(
      `\nStill in channel (API cannot delete): ~${totalSystemLogs} gray system log line(s), ~${totalHuman} human message(s).`
    );
  }

  if (totalDeleted === 0 && totalSystemLogs > 0) {
    console.log(`
>>> To remove the gray "set the channel description" spam:
    1. Slack → #mrsoul → ⋮ → Archive channel
    2. Create a new #mrsoul (or #mrsoul-intake), invite @MrSoul
    3. Copy new channel ID → SLACK_MONITORED_CHANNELS=... in .env
    4. npm run slack:guidelines   (once; keep SLACK_SET_CHANNEL_META=false)
`);
  }

  if (clearAll && totalFound === 0) {
    console.log(`
>>> --all only cleared monitored channel(s) because the app lacks scopes.
    Add at api.slack.com/apps → OAuth & Permissions → Bot Token Scopes:
      groups:read, groups:history, im:read, im:history
    Reinstall app → copy new SLACK_BOT_TOKEN to .env → run again.

    Human DM history (Rahul, Akriti, etc.) is never bulk-deleted by bots:
    open each DM → ⋮ → Delete conversation.
`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
