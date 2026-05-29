import { config } from '../config';
import { createLogger } from '../utils/logger';
import { slackService } from './slack';
import {
  buildGuidelinesBlocks,
  buildGuidelinesMrkdwn,
  MRSOUL_PIN_MARKER,
} from '../content/mrsoulGuidelines';

const log = createLogger('channel-setup');

export class ChannelSetupService {
  private static instance: ChannelSetupService;

  static getInstance(): ChannelSetupService {
    if (!ChannelSetupService.instance) {
      ChannelSetupService.instance = new ChannelSetupService();
    }
    return ChannelSetupService.instance;
  }

  /**
   * Post + pin guidelines when missing. Does not change channel topic/description
   * (Slack logs each change as gray spam; set those once in the Slack UI).
   */
  async ensureChannelGuidelines(channelIds?: string[]): Promise<void> {
    const channels = channelIds ?? config.slack.guidelinesChannels;
    if (channels.length === 0) {
      log.debug('No guidelines channels configured; skipping channel setup');
      return;
    }

    const marker = MRSOUL_PIN_MARKER;
    const text = buildGuidelinesMrkdwn();
    const blocks = buildGuidelinesBlocks();

    for (const channelId of channels) {
      try {
        const existingPin = await slackService.findPinnedMessageByMarker(channelId, marker);
        if (existingPin) {
          log.info('Guidelines already pinned', { channelId, ts: existingPin });
          continue;
        }

        const posted = await slackService.postChannelMessage(channelId, text, blocks);
        await slackService.pinMessage(channelId, posted.ts);
        log.info('Posted and pinned MrSoul guidelines', { channelId, ts: posted.ts });
      } catch (err) {
        log.warn('Channel guidelines setup failed for channel', {
          channelId,
          error: (err as Error).message,
        });
      }
    }
  }
}

export const channelSetupService = ChannelSetupService.getInstance();
