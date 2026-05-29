import { StoreOutreachConfig, StoreOwner } from '../models';
import { calendarDateInTimezone } from '../utils/timezoneDate';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { formatSlackApiError, slackService } from './slack';
import { storeOwnerService } from './storeOwner';
import { activityFeed } from './activityFeed';

const log = createLogger('storeOutreach');
const CONFIG_KEY = 'default';

export interface OutreachConfigView {
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: string;
  messageTemplate: string;
  pinMessages: boolean;
  oncePerDay: boolean;
  lastRunAt?: string;
  lastRunSummary?: string;
  cronExpression: string;
  nextRunHint: string;
  sendLimitHint: string;
}

export interface OutreachRunResult {
  sent: number;
  skipped: number;
  failed: number;
  details: Array<{ storeId: string; status: 'sent' | 'skipped' | 'failed'; message?: string }>;
}

export class StoreOutreachService {
  async getConfig(): Promise<OutreachConfigView> {
    const doc = await this.ensureConfigDoc();
    return this.toConfigView(doc);
  }

  async updateConfig(
    patch: Partial<{
      enabled: boolean;
      hour: number;
      minute: number;
      timezone: string;
      messageTemplate: string;
      pinMessages: boolean;
      oncePerDay: boolean;
    }>
  ): Promise<OutreachConfigView> {
    const doc = await this.ensureConfigDoc();

    if (patch.enabled !== undefined) doc.enabled = patch.enabled;
    if (patch.hour !== undefined) doc.hour = patch.hour;
    if (patch.minute !== undefined) doc.minute = patch.minute;
    if (patch.timezone !== undefined) doc.timezone = patch.timezone.trim() || config.storeOutreach.defaultTimezone;
    if (patch.messageTemplate !== undefined) doc.messageTemplate = patch.messageTemplate;
    if (patch.pinMessages !== undefined) doc.pinMessages = patch.pinMessages;
    if (patch.oncePerDay !== undefined) doc.oncePerDay = patch.oncePerDay;

    await doc.save();
    log.info('Updated store outreach config', {
      enabled: doc.enabled,
      time: `${doc.hour}:${String(doc.minute).padStart(2, '0')}`,
      timezone: doc.timezone,
    });

    return this.toConfigView(doc);
  }

  async runDailyOutreach(opts?: { force?: boolean }): Promise<OutreachRunResult> {
    if (!config.storeOutreach.enabled) {
      return { sent: 0, skipped: 0, failed: 0, details: [{ storeId: '-', status: 'skipped', message: 'STORE_OUTREACH_ENABLED=false' }] };
    }

    const cfg = await this.ensureConfigDoc();
    if (!cfg.enabled && !opts?.force) {
      return { sent: 0, skipped: 0, failed: 0, details: [{ storeId: '-', status: 'skipped', message: 'Outreach disabled in dashboard' }] };
    }

    const today = calendarDateInTimezone(cfg.timezone);
    const owners = await StoreOwner.find({ active: true });
    const result: OutreachRunResult = { sent: 0, skipped: 0, failed: 0, details: [] };

    const oncePerDay = cfg.oncePerDay !== false;

    for (const owner of owners) {
      if (!opts?.force && oncePerDay && owner.lastOutreachDate === today) {
        result.skipped += 1;
        result.details.push({
          storeId: owner.storeId,
          status: 'skipped',
          message: 'Already sent today (once-per-day is on)',
        });
        continue;
      }

      try {
        const slackUser = await slackService.lookupUserByEmail(owner.email);
        if (!slackUser) {
          throw new Error(`No Slack user for email ${owner.email}`);
        }

        const text = this.renderMessage(cfg.messageTemplate, {
          storeId: owner.storeId,
          storeLocation: owner.storeLocation,
          userName: owner.userName,
          name: owner.name,
          phone: owner.phone,
          email: owner.email,
        });

        const posted = await slackService.sendDirectMessage(slackUser.id, text);

        if (cfg.pinMessages) {
          try {
            await slackService.pinMessage(posted.channelId, posted.ts);
          } catch (pinErr) {
            log.warn('Could not pin outreach message', {
              storeId: owner.storeId,
              error: (pinErr as Error).message,
            });
          }
        }

        await storeOwnerService.recordOutreach(owner.storeId, {
          slackUserId: slackUser.id,
          channelId: posted.channelId,
          messageTs: posted.ts,
          outreachDate: today,
        });

        result.sent += 1;
        result.details.push({ storeId: owner.storeId, status: 'sent' });
      } catch (err) {
        const message = formatSlackApiError(err);
        result.failed += 1;
        result.details.push({ storeId: owner.storeId, status: 'failed', message });

        await StoreOwner.updateOne(
          { storeId: owner.storeId },
          { lastOutreachError: message, lastOutreachAt: new Date() }
        );

        log.error('Store outreach failed', { storeId: owner.storeId, error: message });
      }
    }

    const summary = `sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`;
    cfg.lastRunAt = new Date();
    cfg.lastRunSummary = summary;
    await cfg.save();

    activityFeed.emitActivity({
      level: result.failed > 0 ? 'warn' : 'success',
      source: 'store-outreach',
      title: 'Daily store outreach run',
      detail: summary,
      meta: { date: today, ...result },
    });

    log.info('Store outreach run complete', { summary, date: today });
    return result;
  }

  renderMessage(
    template: string,
    vars: {
      storeId: string;
      storeLocation: string;
      userName: string;
      name: string;
      phone: string;
      email: string;
    }
  ): string {
    return template
      .replace(/\{\{storeId\}\}/g, vars.storeId)
      .replace(/\{\{storeLocation\}\}/g, vars.storeLocation)
      .replace(/\{\{userName\}\}/g, vars.userName)
      .replace(/\{\{name\}\}/g, vars.name)
      .replace(/\{\{phone\}\}/g, vars.phone)
      .replace(/\{\{email\}\}/g, vars.email);
  }

  getCronExpression(hour: number, minute: number): string {
    return `${minute} ${hour} * * *`;
  }

  private async ensureConfigDoc() {
    let doc = await StoreOutreachConfig.findOne({ configKey: CONFIG_KEY });
    if (!doc) {
      doc = await StoreOutreachConfig.create({
        configKey: CONFIG_KEY,
        enabled: false,
        hour: 9,
        minute: 0,
        timezone: config.storeOutreach.defaultTimezone,
        pinMessages: true,
        oncePerDay: true,
      });
    }
    if (doc.oncePerDay === undefined) {
      doc.oncePerDay = true;
    }
    return doc;
  }

  private toConfigView(doc: Awaited<ReturnType<typeof this.ensureConfigDoc>>): OutreachConfigView {
    const cronExpression = this.getCronExpression(doc.hour, doc.minute);
    const pad = (n: number) => String(n).padStart(2, '0');
    const oncePerDay = doc.oncePerDay !== false;
    return {
      enabled: doc.enabled,
      hour: doc.hour,
      minute: doc.minute,
      timezone: doc.timezone,
      messageTemplate: doc.messageTemplate,
      pinMessages: doc.pinMessages,
      oncePerDay,
      lastRunAt: doc.lastRunAt?.toISOString(),
      lastRunSummary: doc.lastRunSummary,
      cronExpression,
      nextRunHint: `Daily at ${pad(doc.hour)}:${pad(doc.minute)} (${doc.timezone})`,
      sendLimitHint: oncePerDay
        ? 'At most one DM per store per day'
        : 'Sends on every scheduled run (no daily limit)',
    };
  }
}

export const storeOutreachService = new StoreOutreachService();
