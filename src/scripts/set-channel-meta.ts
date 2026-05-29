/**
 * One-time channel topic + description (creates gray log lines in Slack).
 * Prefer setting these in the Slack UI instead.
 *
 * Usage: SLACK_SET_CHANNEL_META=true npm run slack:set-meta
 */
import dotenv from 'dotenv';
dotenv.config();

import { config } from '../config';
import { slackService } from '../services/slack';
import { MRSOUL_CHANNEL_TOPIC, MRSOUL_CHANNEL_PURPOSE } from '../content/mrsoulGuidelines';

async function main(): Promise<void> {
  if (!config.slack.setChannelMetaOnSetup) {
    console.error(
      'Refusing to set topic/description. Set SLACK_SET_CHANNEL_META=true in .env for this one command only.'
    );
    process.exit(1);
  }

  const channels = config.slack.guidelinesChannels;
  for (const channelId of channels) {
    await slackService.setChannelTopic(channelId, MRSOUL_CHANNEL_TOPIC);
    await slackService.setChannelPurpose(channelId, MRSOUL_CHANNEL_PURPOSE);
    console.log(`Set topic + description on ${channelId}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
