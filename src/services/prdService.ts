import { config } from '../config';
import type { AdkPrd } from '../agents/schemas';
import { adkService } from './adkService';
import { activityFeed } from './activityFeed';
import { wantsPrd } from './intent';
import { createLogger } from '../utils/logger';
import type { ParsedSlackMessage, IssueAssignment } from '../types';
import type { DerivedIssueGuidelines } from './issueGuidelines';

const log = createLogger('prd');

export class PrdService {
  private static instance: PrdService;

  static getInstance(): PrdService {
    if (!PrdService.instance) {
      PrdService.instance = new PrdService();
    }
    return PrdService.instance;
  }

  isEnabled(): boolean {
    return config.prd.enabled && adkService.isEnabled();
  }

  shouldGenerateForIssue(message: ParsedSlackMessage): boolean {
    if (!this.isEnabled()) return false;
    return config.prd.onEveryIssue || wantsPrd(message.text);
  }

  shouldGenerateStandalone(text: string): boolean {
    return this.isEnabled() && wantsPrd(text);
  }

  async generate(
    message: ParsedSlackMessage,
    threadContext: string,
    opts?: {
      assignment?: IssueAssignment;
      guidelines?: DerivedIssueGuidelines;
      githubIssueUrl?: string;
    }
  ): Promise<AdkPrd | null> {
    if (!this.isEnabled()) return null;

    activityFeed.emitActivity({
      level: 'info',
      source: 'adk',
      title: 'PRD draft generating',
      detail: message.text.slice(0, 120),
      meta: {
        channelId: message.channelId,
        messageTs: message.messageTs,
        threadRootTs: message.threadTs ?? message.messageTs,
      },
    });

    const prompt = [
      `Channel: ${message.channelName}`,
      `Reporter: ${message.userName}`,
      `Hashtags: ${message.hashtags.join(' ') || 'none'}`,
      `Priority: ${message.priority}`,
      opts?.assignment
        ? `Suggested owner: ${opts.assignment.primaryOwnerName} (@${opts.assignment.githubUsername})`
        : '',
      opts?.guidelines
        ? `TSS: ${opts.guidelines.priority}, effort ${opts.guidelines.effort}, squad ${opts.guidelines.squad}`
        : '',
      opts?.githubIssueUrl ? `GitHub: ${opts.githubIssueUrl}` : '',
      '',
      'Slack requirement:',
      message.text,
      threadContext ? `\nThread / collaboration context:\n${threadContext}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const result = await adkService.generatePrd(prompt);
      if (!result) {
        activityFeed.emitActivity({
          level: 'warn',
          source: 'adk',
          title: 'PRD draft failed',
          detail: 'Agent returned no output',
          meta: {
            channelId: message.channelId,
            messageTs: message.messageTs,
          },
        });
        return null;
      }

      activityFeed.emitActivity({
        level: 'success',
        source: 'adk',
        title: 'PRD draft ready',
        detail: result.title,
        meta: {
          channelId: message.channelId,
          messageTs: message.messageTs,
        },
      });

      return result;
    } catch (err) {
      log.warn('PRD generation failed', { error: (err as Error).message });
      activityFeed.emitActivity({
        level: 'error',
        source: 'adk',
        title: 'PRD draft failed',
        detail: (err as Error).message,
        meta: { channelId: message.channelId, messageTs: message.messageTs },
      });
      return null;
    }
  }
}

export const prdService = PrdService.getInstance();
