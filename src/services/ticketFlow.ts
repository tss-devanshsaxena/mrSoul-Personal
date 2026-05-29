import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { config } from '../config';
import { TicketFlowSession, type TicketFlowSessionDoc, type TicketFlowState } from '../models';
import { prdSchema, type AdkPrd } from '../agents/schemas';
import { groqService } from './groqService';
import { slackService } from './slack';
import { issueService } from './issue';
import { advisorService } from './advisor';
import { matchDevelopers, type DeveloperProfile } from './developerMatch';
import { parseSlackMessage } from '../utils/messageParser';
import {
  isRevisionComment,
  isTicketApproval,
  isTicketRejection,
  looksLikeRaiseAttempt,
  parseRaiseTicketAssignee,
} from '../utils/ticketFlowParser';
import { parseExplicitGithubLogin } from './developerMatch';
import {
  buildPrdReadyBlocks,
  buildProblemReviewBlocks,
  buildTicketCompletedBlocks,
} from '../content/ticketFlowBlocks';
import { buildPrdDocxBuffer, prdDocxFilename } from './prdDocx';
import { formatPrdPlainText } from '../content/prdBlocks';
import { TSS_GUIDELINES_DOC_HINT } from '../content/tssIssueGuidelines';
import { MRSOUL_COLLEAGUE_VOICE } from '../content/mrsoulVoice';
import { createLogger } from '../utils/logger';
import type { IssueAssignment } from '../types';

const log = createLogger('ticket-flow');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const problemBriefSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  keyQuestions: z.array(z.string()).optional(),
  suggestedScope: z.string().optional(),
});

const PROBLEM_SYSTEM = `You are MrSoul on The Souled Store tech team.

${MRSOUL_COLLEAGUE_VOICE}

The user is starting a new tracked ticket. Rewrite their raw notes into a clear problem brief for stakeholder approval.

Return JSON only:
{
  "title": "short title (max 80 chars)",
  "summary": "2-4 paragraphs: context, problem, desired outcome",
  "keyQuestions": ["optional open questions"],
  "suggestedScope": "optional one paragraph on in/out of scope"
}

Be specific to what they wrote. Do not invent systems or people not mentioned.`;

const REVISE_SYSTEM = `You are MrSoul on the TSS tech team, revising a ticket problem brief from user feedback.

${MRSOUL_COLLEAGUE_VOICE}

Return JSON with the same shape: title, summary, keyQuestions (optional), suggestedScope (optional).
Incorporate the feedback faithfully. Do not drop important details from the original.`;

const PRD_SYSTEM = `You are MrSoul writing a PRD for The Souled Store engineering.

${MRSOUL_COLLEAGUE_VOICE}

Return JSON matching this schema:
{
  "title": string,
  "problemStatement": string,
  "goals": string[],
  "userStories": string[],
  "functionalRequirements": string[],
  "acceptanceCriteria": string[],
  "outOfScope": string[] (optional),
  "openQuestions": string[] (optional),
  "claudeHandoffPrompt": string (2-4 sentences for optional AI refinement)
}

Rules (${TSS_GUIDELINES_DOC_HINT}):
- userStories: "As a … I want … so that …" when possible
- functionalRequirements: testable engineering requirements
- acceptanceCriteria: verifiable Given/When/Then or checklist items
- Be specific to e-commerce / CE-Tech when implied; do not invent unrelated systems
- claudeHandoffPrompt: ask to refine gaps, risks, edge cases`;

export class TicketFlowService {
  private static instance: TicketFlowService;

  static getInstance(): TicketFlowService {
    if (!TicketFlowService.instance) {
      TicketFlowService.instance = new TicketFlowService();
    }
    return TicketFlowService.instance;
  }

  isEnabled(): boolean {
    return config.ticketFlow.enabled && groqService.isEnabled();
  }

  async findActiveByThread(channelId: string, threadTs: string): Promise<TicketFlowSessionDoc | null> {
    return TicketFlowSession.findOne({
      channelId,
      threadTs,
      state: { $in: ['awaiting_approval', 'prd_generating', 'prd_ready', 'issue_creating'] },
    }).sort({ createdAt: -1 });
  }

  async findBySessionId(sessionId: string): Promise<TicketFlowSessionDoc | null> {
    return TicketFlowSession.findOne({ sessionId });
  }

  /**
   * Start flow from /create-ticket text or modal submission.
   */
  async startFlow(params: {
    channelId: string;
    userId: string;
    userName: string;
    rawInput: string;
    teamId: string;
  }): Promise<{ ok: true; threadTs: string } | { ok: false; error: string }> {
    if (!this.isEnabled()) {
      return {
        ok: false,
        error: 'Ticket flow is disabled. Set `GROQ_API_KEY` and `GROQ_ENABLED=true` in `.env`, then restart.',
      };
    }

    const raw = params.rawInput.trim();
    if (raw.length < 12) {
      return { ok: false, error: 'Please describe the problem in at least a few sentences.' };
    }

    const brief = await groqService.chatJson(
      PROBLEM_SYSTEM,
      `User notes:\n${raw}`,
      problemBriefSchema
    );
    if (!brief) {
      return { ok: false, error: 'Could not format the problem with Groq. Try again in a moment.' };
    }

    const sessionId = uuidv4();
    const posted = await slackService.postChannelMessage(
      params.channelId,
      `Create ticket — ${brief.title}`,
      buildProblemReviewBlocks({
        sessionId,
        title: brief.title,
        summary: brief.summary,
        keyQuestions: brief.keyQuestions,
        suggestedScope: brief.suggestedScope,
      })
    );

    const threadTs = posted.ts;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await TicketFlowSession.create({
      sessionId,
      channelId: params.channelId,
      threadTs,
      rootMessageTs: threadTs,
      userId: params.userId,
      userName: params.userName,
      state: 'awaiting_approval',
      rawInput: raw,
      problemTitle: brief.title,
      problemSummary: brief.summary,
      keyQuestions: brief.keyQuestions ?? [],
      suggestedScope: brief.suggestedScope,
      expiresAt,
    });

    log.info('Ticket flow started', { sessionId, channelId: params.channelId, threadTs });
    return { ok: true, threadTs };
  }

  async handleApprove(sessionId: string, actorUserId: string): Promise<void> {
    const session = await this.findBySessionId(sessionId);
    if (!session) return;
    if (session.state !== 'awaiting_approval') {
      await slackService.postThreadReply(
        session.channelId,
        session.threadTs,
        `_This ticket is already in state \`${session.state}\`._`
      );
      return;
    }

    session.state = 'prd_generating';
    await session.save();

    await slackService.postThreadReply(
      session.channelId,
      session.threadTs,
      `:hourglass_flowing_sand: <@${actorUserId}> approved. Drafting PRD with Groq…`
    );

    const prompt = [
      `Title: ${session.problemTitle}`,
      `Problem summary:\n${session.problemSummary}`,
      session.suggestedScope ? `Scope:\n${session.suggestedScope}` : '',
      session.keyQuestions.length
        ? `Open questions:\n${session.keyQuestions.map(q => `- ${q}`).join('\n')}`
        : '',
      '',
      'Original user notes:',
      session.rawInput,
    ]
      .filter(Boolean)
      .join('\n');

    const prd = await groqService.chatJson(PRD_SYSTEM, prompt, prdSchema);
    if (!prd) {
      session.state = 'awaiting_approval';
      await session.save();
      await slackService.postThreadReply(
        session.channelId,
        session.threadTs,
        ':x: PRD generation failed. Reply `approve` to retry or `reject` to cancel.'
      );
      return;
    }

    session.prd = prd as unknown as Record<string, unknown>;
    session.prdTitle = prd.title;
    session.state = 'prd_ready';
    await session.save();

    try {
      const buffer = await buildPrdDocxBuffer(prd);
      const filename = prdDocxFilename(prd);
      await slackService.uploadFile({
        channelId: session.channelId,
        threadTs: session.threadTs,
        filename,
        buffer,
        title: `PRD: ${prd.title}`,
        initialComment: `PRD document for review — ${prd.title}`,
      });
    } catch (err) {
      log.warn('DOCX upload failed', { error: (err as Error).message });
      await slackService.postThreadReply(
        session.channelId,
        session.threadTs,
        `:warning: Could not upload .docx (${(err as Error).message}). PRD text summary:\n\n${formatPrdPlainText(prd).slice(0, 3500)}`
      );
    }

    await slackService.postChannelMessage(
      session.channelId,
      `PRD ready — ${prd.title}`,
      buildPrdReadyBlocks({ sessionId: session.sessionId, prdTitle: prd.title }),
      session.threadTs
    );
  }

  async handleReject(sessionId: string, actorUserId: string): Promise<void> {
    const session = await this.findBySessionId(sessionId);
    if (!session) return;
    if (['completed', 'rejected', 'cancelled'].includes(session.state)) return;

    session.state = 'rejected';
    await session.save();
    await slackService.postThreadReply(
      session.channelId,
      session.threadTs,
      `:no_entry_sign: Ticket cancelled by <@${actorUserId}>. Start again with \`/create-ticket\` when ready.`
    );
  }

  async handleRevision(session: TicketFlowSessionDoc, comment: string): Promise<void> {
    if (session.state !== 'awaiting_approval') {
      await slackService.postThreadReply(
        session.channelId,
        session.threadTs,
        '_Revisions are only accepted before PRD generation. Reply with assignee after PRD is ready._'
      );
      return;
    }

    await slackService.postThreadReply(
      session.channelId,
      session.threadTs,
      '_Revising problem summary based on your feedback…_'
    );

    const userPrompt = [
      `Current title: ${session.problemTitle}`,
      `Current summary:\n${session.problemSummary}`,
      '',
      'Original notes:',
      session.rawInput,
      '',
      'User feedback:',
      comment,
    ].join('\n');

    const revised = await groqService.chatJson(REVISE_SYSTEM, userPrompt, problemBriefSchema);
    if (!revised) {
      await slackService.postThreadReply(
        session.channelId,
        session.threadTs,
        'Could not apply revisions. Try again or use *Approve* / *Reject*.'
      );
      return;
    }

    session.problemTitle = revised.title;
    session.problemSummary = revised.summary;
    session.keyQuestions = revised.keyQuestions ?? session.keyQuestions;
    session.suggestedScope = revised.suggestedScope ?? session.suggestedScope;
    await session.save();

    await slackService.postChannelMessage(
      session.channelId,
      `Updated problem — ${revised.title}`,
      buildProblemReviewBlocks({
        sessionId: session.sessionId,
        title: revised.title,
        summary: revised.summary,
        keyQuestions: revised.keyQuestions,
        suggestedScope: revised.suggestedScope,
      }),
      session.threadTs
    );
  }

  async handleRaiseTicket(session: TicketFlowSessionDoc, assigneeQuery: string, actorUserId: string): Promise<void> {
    if (session.state !== 'prd_ready') {
      await slackService.postThreadReply(
        session.channelId,
        session.threadTs,
        '_Approve the problem and wait for the PRD .docx before raising the GitHub issue._'
      );
      return;
    }

    const parsedPrd = prdSchema.safeParse(session.prd);
    if (!parsedPrd.success) {
      await slackService.postThreadReply(
        session.channelId,
        session.threadTs,
        'PRD data missing or invalid. Regenerate with `/create-ticket`.'
      );
      return;
    }
    const prd = parsedPrd.data;

    const directory = await advisorService.buildDeveloperDirectory();
    let profile: DeveloperProfile;

    const explicitLogin = parseExplicitGithubLogin(assigneeQuery);
    if (explicitLogin) {
      const found = directory.find(p => p.githubUsername === explicitLogin);
      profile =
        found ?? {
          githubUsername: explicitLogin,
          displayName: explicitLogin.replace(/^tss-/, '').replace(/-/g, ' '),
          domains: [],
        };
    } else {
      const match = matchDevelopers(assigneeQuery, directory, login =>
        login.replace(/^tss-/, '').replace(/-/g, ' ')
      );

      if (match.status === 'ambiguous') {
        const names = match.matches.map(m => `• ${m.displayName} (\`${m.githubUsername}\`)`).join('\n');
        await slackService.postThreadReply(
          session.channelId,
          session.threadTs,
          `Multiple developers match *"${assigneeQuery}"*. Please be specific:\n${names}`
        );
        return;
      }

      if (match.status === 'not_found') {
        const hints =
          match.suggestions.length > 0
            ? `\nDid you mean?\n${match.suggestions.map(s => `• ${s.displayName} (\`${s.githubUsername}\`)`).join('\n')}`
            : '\nUse a `tss-*` GitHub login or first name from the team roster.';
        await slackService.postThreadReply(
          session.channelId,
          session.threadTs,
          `Could not find developer *"${assigneeQuery}"*.${hints}`
        );
        return;
      }

      profile = match.profile;
    }
    const assignment: IssueAssignment = {
      primaryOwnerId: profile.slackUserId ?? 'unassigned',
      primaryOwnerName: profile.displayName,
      secondaryOwnerIds: [],
      githubUsername: profile.githubUsername,
      resolvedFromTags: ['ticket-flow'],
    };

    session.state = 'issue_creating';
    session.assigneeGithub = profile.githubUsername;
    session.assigneeName = profile.displayName;
    await session.save();

    await slackService.postThreadReply(
      session.channelId,
      session.threadTs,
      `:hourglass_flowing_sand: Creating GitHub issue for <@${actorUserId}> → *${profile.displayName}* (\`${profile.githubUsername}\`)…`
    );

    const channelName = await slackService.getChannelName(session.channelId);
    const permalink = await slackService.getPermalink(session.channelId, session.rootMessageTs);
    const issueText = [
      session.problemTitle,
      '',
      session.problemSummary,
      '',
      '#feature #ticket-flow',
    ].join('\n');

    const parsedMessage = parseSlackMessage(
      issueText,
      session.rootMessageTs,
      session.channelId,
      channelName,
      session.userId,
      session.userName,
      config.slack.botToken.split('-')[0],
      permalink,
      session.threadTs
    );

    try {
      const record = await issueService.processSlackMessage(parsedMessage, {
        forcedAssignment: assignment,
        skipPrd: true,
        prdAppendix: prd,
        trackingThreadTs: session.threadTs,
      });

      session.state = 'completed';
      session.githubIssueNumber = record?.githubIssue?.issueNumber;
      session.githubIssueUrl = record?.githubIssue?.issueUrl;
      await session.save();

      if (record?.githubIssue) {
        await slackService.postChannelMessage(
          session.channelId,
          'Ticket created on GitHub',
          buildTicketCompletedBlocks({
            githubUrl: record.githubIssue.issueUrl,
            issueNumber: record.githubIssue.issueNumber,
            assigneeName: profile.displayName,
            githubLogin: profile.githubUsername,
            prdTitle: prd.title,
          }),
          session.threadTs
        );

        await slackService.postThreadReply(
          session.channelId,
          session.threadTs,
          `📎 PRD attached on GitHub issue #${record.githubIssue.issueNumber}:\n` +
            `• Full PRD in the issue description + a comment with download link\n` +
            `• <${record.githubIssue.issueUrl}|Open issue>`
        );

        try {
          const buffer = await buildPrdDocxBuffer(prd);
          await slackService.uploadFile({
            channelId: session.channelId,
            threadTs: session.threadTs,
            filename: prdDocxFilename(prd),
            buffer,
            title: `PRD attached to #${record.githubIssue.issueNumber}`,
            initialComment: `PRD for GitHub issue #${record.githubIssue.issueNumber}\n${record.githubIssue.issueUrl}`,
          });
        } catch {
          // non-fatal
        }
      } else {
        await slackService.postThreadReply(
          session.channelId,
          session.threadTs,
          ':warning: Issue processing finished but no GitHub link was returned. Check logs.'
        );
      }
    } catch (err) {
      session.state = 'prd_ready';
      await session.save();
      await slackService.postThreadReply(
        session.channelId,
        session.threadTs,
        `:x: Failed to create GitHub issue:\n${(err as Error).message}`
      );
    }
  }

  /**
   * Handle thread replies on active ticket flows. Returns true if consumed.
   */
  async handleThreadReply(params: {
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
  }): Promise<boolean> {
    const session = await this.findActiveByThread(params.channelId, params.threadTs);
    if (!session) return false;

    const text = params.text.trim();
    if (!text) return true;

    const raiseTo = parseRaiseTicketAssignee(text);
    if (raiseTo && (session.state === 'prd_ready' || session.state === 'awaiting_approval')) {
      if (session.state === 'awaiting_approval') {
        await slackService.postThreadReply(
          session.channelId,
          session.threadTs,
          '_Please approve the problem first (button or `approve`), then wait for the PRD .docx._'
        );
        return true;
      }
      await this.handleRaiseTicket(session, raiseTo, params.userId);
      return true;
    }

    if (isTicketRejection(text)) {
      await this.handleReject(session.sessionId, params.userId);
      return true;
    }

    if (isTicketApproval(text) && session.state === 'awaiting_approval') {
      await this.handleApprove(session.sessionId, params.userId);
      return true;
    }

    if (isRevisionComment(text) && session.state === 'awaiting_approval') {
      await this.handleRevision(session, text);
      return true;
    }

    if (session.state === 'prd_ready') {
      if (looksLikeRaiseAttempt(text)) {
        await slackService.postThreadReply(
          session.channelId,
          session.threadTs,
          'I could not read the assignee. Try:\n' +
            '`Good to go raise this ticket to: tss-devanshsaxena`\n' +
            'or\n`Good to go raise this ticket to: Devansh Saxena`\n\n' +
            'Typos like *riase* are OK. Or reply `reject` to cancel.'
        );
      } else {
        await slackService.postThreadReply(
          session.channelId,
          session.threadTs,
          'Reply with:\n`Good to go raise this ticket to: <developer name or tss-login>`\nOr `reject` to cancel.'
        );
      }
      return true;
    }

    return true;
  }
}

export const ticketFlowService = TicketFlowService.getInstance();
