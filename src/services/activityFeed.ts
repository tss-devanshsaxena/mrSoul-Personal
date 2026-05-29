import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';

const log = createLogger('activity');

export type ActivityLevel = 'info' | 'success' | 'warn' | 'error';
export type ActivitySource =
  | 'system'
  | 'slack'
  | 'issue'
  | 'github'
  | 'adk'
  | 'triage'
  | 'routing';

export interface ActivityEvent {
  id: string;
  ts: string;
  level: ActivityLevel;
  source: ActivitySource;
  title: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

const MAX_EVENTS = 250;

class ActivityFeedService extends EventEmitter {
  private events: ActivityEvent[] = [];
  private startedAt = new Date().toISOString();

  emitActivity(
    partial: Omit<ActivityEvent, 'id' | 'ts'> & { ts?: string }
  ): ActivityEvent {
    const event: ActivityEvent = {
      id: randomUUID(),
      ts: partial.ts ?? new Date().toISOString(),
      level: partial.level,
      source: partial.source,
      title: partial.title,
      detail: partial.detail,
      meta: partial.meta,
    };

    this.events.unshift(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.length = MAX_EVENTS;
    }

    this.emit('activity', event);
    return event;
  }

  getSnapshot(): {
    startedAt: string;
    count: number;
    events: ActivityEvent[];
    countsByLevel: Record<ActivityLevel, number>;
    countsBySource: Record<string, number>;
  } {
    const countsByLevel: Record<ActivityLevel, number> = {
      info: 0,
      success: 0,
      warn: 0,
      error: 0,
    };
    const countsBySource: Record<string, number> = {};

    for (const e of this.events) {
      countsByLevel[e.level] += 1;
      countsBySource[e.source] = (countsBySource[e.source] ?? 0) + 1;
    }

    return {
      startedAt: this.startedAt,
      count: this.events.length,
      events: [...this.events],
      countsByLevel,
      countsBySource,
    };
  }

  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.on('activity', listener);
    return () => this.off('activity', listener);
  }

  logBoot(): void {
    this.emitActivity({
      level: 'success',
      source: 'system',
      title: 'CE-Tech / MrSoul platform started',
      detail: 'Slack Socket Mode + Express API ready',
    });
    log.debug('Activity feed boot event recorded');
  }
}

export const activityFeed = new ActivityFeedService();
