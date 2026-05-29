import cron, { ScheduledTask } from 'node-cron';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { storeOutreachService } from './storeOutreach';

const log = createLogger('storeOutreachScheduler');

export class StoreOutreachScheduler {
  private task: ScheduledTask | null = null;
  private running = false;

  async start(): Promise<void> {
    if (!config.storeOutreach.enabled) {
      log.info('Store outreach scheduler disabled (STORE_OUTREACH_ENABLED=false)');
      return;
    }
    await this.reschedule();
  }

  async reschedule(): Promise<void> {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }

    if (!config.storeOutreach.enabled) return;

    const cfg = await storeOutreachService.getConfig();
    if (!cfg.enabled) {
      log.info('Store outreach cron not scheduled (disabled in dashboard config)');
      return;
    }

    const expression = storeOutreachService.getCronExpression(cfg.hour, cfg.minute);
    if (!cron.validate(expression)) {
      log.error('Invalid cron expression for store outreach', { expression });
      return;
    }

    this.task = cron.schedule(
      expression,
      () => {
        void this.tick();
      },
      { timezone: cfg.timezone }
    );

    log.info('Store outreach cron scheduled', {
      expression,
      timezone: cfg.timezone,
      hint: cfg.nextRunHint,
    });
  }

  private async tick(): Promise<void> {
    if (this.running) {
      log.warn('Store outreach already running — skipping overlapping tick');
      return;
    }
    this.running = true;
    try {
      await storeOutreachService.runDailyOutreach();
    } catch (err) {
      log.error('Store outreach cron failed', { error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }
}

export const storeOutreachScheduler = new StoreOutreachScheduler();
