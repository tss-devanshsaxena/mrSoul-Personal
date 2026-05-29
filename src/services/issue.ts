import { v4 as uuidv4 } from 'uuid';
import { Issue, DedupeCache } from '../models';
import { githubService } from './github';
import { slackService } from './slack';
import { workloadTracker } from './tracker';
import { triageService } from './triage';
import { llmService } from './llm';
import { deriveIssueGuidelines, validateIssueCreation } from './issueGuidelines';
import { routingService } from './routing';
import { activityFeed } from './activityFeed';
import { prdService } from './prdService';
import { createLogger } from '../utils/logger';
import {
  ParsedSlackMessage,
  IssueRecord,
  IssueStatus,
  AuditLogEntry,
  IssueAssignment,
} from '../types';
import type { AdkPrd } from '../agents/schemas';
import { formatPrdPlainText } from '../content/prdBlocks';

const log = createLogger('issue-service');

const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class IssueService {
  private static instance: IssueService;

  static getInstance(): IssueService {
    if (!IssueService.instance) {
      IssueService.instance = new IssueService();
    }
    return IssueService.instance;
  }

  /**
   * Main entry point: process a parsed Slack message into a tracked issue.
   * Idempotent — duplicate calls are safely ignored.
   */
  async processSlackMessage(
    message: ParsedSlackMessage,
    options?: {
      forcedAssignment?: IssueAssignment;
      skipPrd?: boolean;
      prdAppendix?: AdkPrd;
      /** Reuse existing Slack thread (e.g. /create-ticket flow) instead of new tracking post */
      trackingThreadTs?: string;
    }
  ): Promise<IssueRecord | null> {
    const dedupeKey = `slack:${message.channelId}:${message.messageTs}`;

    // Deduplication check
    if (await this.isDuplicate(dedupeKey)) {
      log.warn('Duplicate event ignored', { dedupeKey });
      return null;
    }

    log.info('Processing Slack message', {
      channel: message.channelName,
      hashtags: message.hashtags,
      priority: message.priority,
    });

    // Mark as being processed
    await this.markProcessed(dedupeKey);

    // Deterministic triage (routing + mentions), or forced assignee from ticket flow
    const forcedSignal = { kind: 'hashtag_match' as const, tag: 'ticket-flow', score: 100 };
    const triage = options?.forcedAssignment
      ? {
          assignment: options.forcedAssignment,
          chosen: { score: 100, signals: [forcedSignal] },
          candidates: [
            {
              slackUserId: options.forcedAssignment.primaryOwnerId,
              slackName: options.forcedAssignment.primaryOwnerName,
              githubUsername: options.forcedAssignment.githubUsername,
              score: 100,
              signals: [forcedSignal],
            },
          ],
        }
      : await triageService.triage(message);
    const assignment = options?.forcedAssignment
      ? options.forcedAssignment
      : await routingService.resolveAssignmentForIssue(message, triage.assignment);

    const guidelines = deriveIssueGuidelines(message);
    const validation = await validateIssueCreation(message, assignment, guidelines);
    const threadRoot = message.threadTs ?? message.messageTs;
    const slackMeta = {
      channelId: message.channelId,
      messageTs: message.messageTs,
      threadRootTs: threadRoot,
    };

    if (!validation.ok) {
      activityFeed.emitActivity({
        level: 'error',
        source: 'issue',
        title: 'TSS validation failed',
        detail: validation.errors.join(' '),
        meta: slackMeta,
      });
      throw new Error(validation.errors.join(' '));
    }

    activityFeed.emitActivity({
      level: 'info',
      source: 'triage',
      title: `Assignee: ${assignment.githubUsername}`,
      detail: `${guidelines.priority} · effort ${guidelines.effort} · ${guidelines.squad}`,
      meta: { ...slackMeta, signals: triage.chosen.signals.map(s => s.kind) },
    });

    // Create issue record in DB
    const issueId = uuidv4();
    const issue = await Issue.create({
      slackMessageTs: message.messageTs,
      slackChannelId: message.channelId,
      slackChannelName: message.channelName,
      slackUserId: message.userId,
      slackUserName: message.userName,
      originalMessage: message.text,
      hashtags: message.hashtags,
      priority: message.priority,
      status: 'open' as IssueStatus,
      assignment,
      auditLog: [this.buildAuditEntry('issue_created', 'system', {
        hashtags: message.hashtags,
        priority: message.priority,
        assignedTo: assignment.primaryOwnerName,
        triage: {
          chosenScore: triage.chosen.score,
          chosenSignals: triage.chosen.signals,
          topCandidates: triage.candidates.slice(0, 3).map(c => ({
            githubUsername: c.githubUsername,
            slackUserId: c.slackUserId,
            score: c.score,
            signals: c.signals,
          })),
        },
        tssGuidelines: {
          priority: guidelines.priority,
          effort: guidelines.effort,
          targetQuarter: guidelines.targetQuarter,
          squad: guidelines.squad,
          raisedBy: guidelines.raisedBy,
        },
        validationWarnings: validation.warnings,
      })],
    });

    log.info('Issue record created', { issueId: issue.id });

    // ---- Parallel: create GitHub issue + Slack thread ----
    try {
      const shouldUseLlm =
        llmService.isEnabled() &&
        !triage.chosen.signals.some(s => s.kind === 'slack_mention' || s.kind === 'hashtag_match');

      const llmSummaryPromise = shouldUseLlm
        ? llmService.summarizeIssue(message.text)
        : Promise.resolve(null);

      const collabContext = await slackService.getCollaborationThreadContext(
        message.channelId,
        threadRoot,
        { excludeTs: message.messageTs }
      );

      const shouldPrd = !options?.skipPrd && prdService.shouldGenerateForIssue(message);
      const prdPromise = shouldPrd
        ? prdService.generate(message, collabContext, { assignment, guidelines })
        : Promise.resolve(null);

      const [githubIssue, prdOutcome] = await Promise.allSettled([
        llmSummaryPromise.then(llmSummary =>
          githubService.createIssue(message, assignment, issue.id, llmSummary, guidelines, {
            prdMarkdown: options?.prdAppendix ? formatPrdPlainText(options.prdAppendix) : undefined,
            prd: options?.prdAppendix,
          })
        ),
        prdPromise,
      ]);

      if (githubIssue.status === 'fulfilled') {
        issue.githubIssue = githubIssue.value;
        issue.auditLog.push(
          this.buildAuditEntry('github_issue_created', 'system', {
            issueNumber: githubIssue.value.issueNumber,
            issueUrl: githubIssue.value.issueUrl,
          })
        );
        log.info('GitHub issue linked', { number: githubIssue.value.issueNumber });
        activityFeed.emitActivity({
          level: 'success',
          source: 'github',
          title: `GitHub issue #${githubIssue.value.issueNumber} created`,
          detail: githubIssue.value.issueUrl,
          meta: slackMeta,
        });
      } else {
        log.error('GitHub issue creation failed', { error: githubIssue.reason });
        issue.auditLog.push(
          this.buildAuditEntry('github_issue_failed', 'system', {}, false, githubIssue.reason?.message)
        );
      }

      // Create Slack tracking thread (with GitHub issue if available)
      const slackThread = options?.trackingThreadTs
        ? { channelId: message.channelId, threadTs: options.trackingThreadTs }
        : await slackService.createTrackingThread(
            message,
            assignment,
            issue.id,
            issue.githubIssue,
            triage,
            guidelines,
            validation.warnings
          );

      issue.slackThread = slackThread;
      issue.auditLog.push(
        this.buildAuditEntry('slack_thread_created', 'system', {
          threadTs: slackThread.threadTs,
        })
      );

      if (prdOutcome.status === 'fulfilled' && prdOutcome.value) {
        await slackService.postPrdDraft(
          message.channelId,
          threadRoot,
          prdOutcome.value,
          { githubUrl: issue.githubIssue?.issueUrl }
        );
        issue.auditLog.push(
          this.buildAuditEntry('prd_posted', 'system', { title: prdOutcome.value.title })
        );
      } else if (prdOutcome.status === 'rejected') {
        log.warn('PRD generation failed', { error: String(prdOutcome.reason) });
      }

      // Save updated issue
      await issue.save();

      // Sync to workload tracker (non-blocking)
      this.syncToTracker(issue).catch(err =>
        log.error('Tracker sync failed', { error: err.message })
      );

      log.info('Issue fully processed', {
        issueId: issue.id,
        githubIssue: issue.githubIssue?.issueNumber,
        slackThread: issue.slackThread?.threadTs,
      });

      activityFeed.emitActivity({
        level: 'success',
        source: 'issue',
        title: 'Issue pipeline complete',
        detail: `Slack thread + TSS project fields · ${issue.githubIssue?.issueUrl ?? 'no GitHub link'}`,
        meta: slackMeta,
      });

      return issue.toObject() as unknown as IssueRecord;
    } catch (err) {
      log.error('Issue processing error', { error: (err as Error).message, issueId: issue.id });
      issue.auditLog.push(
        this.buildAuditEntry('processing_error', 'system', {}, false, (err as Error).message)
      );
      await issue.save();
      throw err;
    }
  }

  /**
   * Handle a GitHub PR event — update issue status and notify Slack thread.
   */
  async handleGitHubPREvent(
    action: string,
    prNumber: number,
    prTitle: string,
    prUrl: string,
    merged: boolean
  ): Promise<void> {
    // We don't have direct issue number here — look up by any recent open issues
    // In real scenario, PR body would contain the CE-Tech Issue ID
    log.info('GitHub PR event received', { action, prNumber, prTitle });

    // Find issues that could be linked (recent open/in_progress issues)
    // In production you'd parse the PR body for the issueId
    const recentIssues = await Issue.find({
      status: { $in: ['open', 'in_progress'] },
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    }).sort({ createdAt: -1 }).limit(10);

    if (recentIssues.length === 0) return;

    // For demo: update the most recent open issue
    // In production: extract issueId from PR body/description
    const issue = recentIssues[0];
    await this.updateIssueStatus(
      issue.id,
      merged ? 'pr_merged' : 'pr_opened',
      {
        prNumber,
        prTitle,
        prUrl,
        merged,
      }
    );
  }

  /**
   * Handle a GitHub issue closed event.
   */
  async handleGitHubIssueClosed(issueNumber: number): Promise<void> {
    const issue = await Issue.findOne({ 'githubIssue.issueNumber': issueNumber });
    if (!issue) {
      log.warn('GitHub issue not found in DB', { issueNumber });
      return;
    }

    await this.updateIssueStatus(issue.id, 'closed', { issueNumber });
  }

  /**
   * Update issue status and post to Slack thread.
   */
  async updateIssueStatus(
    issueId: string,
    newStatus: IssueStatus,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const issue = await Issue.findById(issueId);
    if (!issue) {
      log.warn('Issue not found for status update', { issueId });
      return;
    }

    const previousStatus = issue.status;
    issue.status = newStatus;

    if (['resolved', 'closed'].includes(newStatus)) {
      issue.resolvedAt = new Date();
    }

    issue.auditLog.push(
      this.buildAuditEntry('status_updated', 'system', {
        from: previousStatus,
        to: newStatus,
        ...details,
      })
    );

    await issue.save();

    // Post update to Slack thread
    if (issue.slackThread) {
      await slackService.postThreadUpdate(
        issue.slackThread.channelId,
        issue.slackThread.threadTs,
        details.prNumber ? (details.merged ? 'pr_merged' : 'pr_opened') : 'status_change',
        details,
        newStatus
      );
    }

    // Sync to workload tracker
    await this.syncToTracker(issue);

    log.info('Issue status updated', {
      issueId,
      from: previousStatus,
      to: newStatus,
    });
  }

  /**
   * Get issue by ID.
   */
  async getIssue(issueId: string): Promise<IssueRecord | null> {
    const issue = await Issue.findById(issueId);
    return issue ? (issue.toObject() as unknown as IssueRecord) : null;
  }

  /**
   * List issues with filters.
   */
  async listIssues(filters: {
    status?: IssueStatus;
    assignee?: string;
    priority?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ issues: IssueRecord[]; total: number }> {
    const query: Record<string, unknown> = {};

    if (filters.status) query.status = filters.status;
    if (filters.assignee) query['assignment.primaryOwnerId'] = filters.assignee;
    if (filters.priority) query.priority = filters.priority;

    const [issues, total] = await Promise.all([
      Issue.find(query)
        .sort({ createdAt: -1 })
        .limit(filters.limit ?? 50)
        .skip(filters.offset ?? 0),
      Issue.countDocuments(query),
    ]);

    return {
      issues: issues.map(i => i.toObject() as unknown as IssueRecord),
      total,
    };
  }

  // -----------------------------------------------
  // Private helpers
  // -----------------------------------------------

  private async isDuplicate(key: string): Promise<boolean> {
    try {
      const entry = await DedupeCache.findOne({ key });
      return !!entry;
    } catch {
      return false;
    }
  }

  private async markProcessed(key: string): Promise<void> {
    try {
      await DedupeCache.create({
        key,
        processedAt: new Date(),
        expiresAt: new Date(Date.now() + DEDUPE_TTL_MS),
      });
    } catch {
      // Race condition — another process already marked it
    }
  }

  private buildAuditEntry(
    action: string,
    actor: string,
    details: Record<string, unknown>,
    success = true,
    error?: string
  ): AuditLogEntry {
    return {
      timestamp: new Date(),
      action,
      actor,
      details,
      success,
      error,
    };
  }

  private async syncToTracker(issue: ReturnType<typeof Issue.prototype.toObject>): Promise<void> {
    try {
      // Issue from mongoose document needs its fields
      const doc = await Issue.findById((issue as { _id: unknown })._id);
      if (!doc) return;
      const issueRecord = doc.toObject() as unknown as IssueRecord;
      await workloadTracker.trackIssue({ ...issueRecord, id: doc.id });
    } catch (err) {
      log.error('Tracker sync failed', { error: (err as Error).message });
    }
  }
}

export const issueService = IssueService.getInstance();
