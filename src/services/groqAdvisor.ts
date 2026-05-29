import { config } from '../config';
import { TSS_PROJECT_NAME, TSS_PROJECT_URL } from '../content/tssIssueGuidelines';
import { createLogger } from '../utils/logger';
import { stripSlackMarkup, type SlackIntent } from './intent';
import { groqService } from './groqService';
import { advisorService } from './advisor';
import { githubService } from './github';
import { routingService } from './routing';
import { triageService } from './triage';
import { slackService } from './slack';
import { parseSlackMessage } from '../utils/messageParser';
import { matchDevelopers } from './developerMatch';

const log = createLogger('groq-advisor');

const SYSTEM_PROMPT = `You are MrSoul, the CE-Tech engineering assistant for The Souled Store (e-commerce).

You receive LIVE JSON context from GitHub (project board, open issues, workload) and internal routing data. Use ONLY facts from that context — never invent developers, issue numbers, or URLs.

Reply in Slack mrkdwn:
- Use *bold* for emphasis, \`backticks\` for logins/tags, bullet lists for clarity
- Keep answers concise (under ~400 words unless listing many items)
- Reference GitHub logins as \`tss-name\` when naming people

What you can help with:
1. *Workload* — what someone is working on (use boardItems + workload in context)
2. *Team status* — who has open work (use team roster in context)
3. *Ownership* — who should own a task (use triage recommendation when provided)
4. *How to file work* — explain these paths:
   - \`/create-ticket\` → Groq drafts problem → PRD (.docx) → GitHub issue with PRD attached
   - \`@MrSoul #domain-tag description\` or \`create issue …\` in thread → tracked GitHub issue on ${config.github.owner}/${config.github.repo}
   - Hashtags: #critical, #squad-backend, #effort-5, etc. (see routingTags in context)

If context is missing data, say what you could not find and suggest a concrete @MrSoul command.`;

export type AdvisorConversationContext = {
  channelId: string;
  channelName: string;
  messageTs: string;
  userId: string;
  userName: string;
  teamId: string;
  rawText: string;
  threadTs?: string;
};

export class GroqAdvisorService {
  private static instance: GroqAdvisorService;

  static getInstance(): GroqAdvisorService {
    if (!GroqAdvisorService.instance) {
      GroqAdvisorService.instance = new GroqAdvisorService();
    }
    return GroqAdvisorService.instance;
  }

  isEnabled(): boolean {
    return config.groq.advisorEnabled && groqService.isEnabled();
  }

  async answer(
    intent: SlackIntent,
    ctx: AdvisorConversationContext
  ): Promise<{ text: string; blocks?: Record<string, unknown>[] } | null> {
    if (!this.isEnabled()) return null;

    const question = stripSlackMarkup(ctx.rawText);
    if (!question || question.length < 2) return null;

    const dataContext = await this.buildLiveContext(intent, ctx);
    const userPayload = JSON.stringify(
      {
        question,
        intent: intent.kind,
        reporter: ctx.userName,
        channel: ctx.channelName,
        liveData: dataContext,
      },
      null,
      2
    ).slice(0, 28_000);

    const reply = await groqService.chat(
      SYSTEM_PROMPT,
      userPayload,
      { temperature: 0.35, maxTokens: 2048 }
    );

    if (!reply?.trim()) return null;

    const text = reply.slice(0, 3900);
    log.info('Groq advisor reply', {
      intent: intent.kind,
      channel: ctx.channelName,
      length: text.length,
    });

    return {
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `_Powered by Groq + live GitHub · ${TSS_PROJECT_NAME} · <${TSS_PROJECT_URL}|board>_`,
            },
          ],
        },
      ],
    };
  }

  private async buildLiveContext(
    intent: SlackIntent,
    ctx: AdvisorConversationContext
  ): Promise<Record<string, unknown>> {
    const [directory, projectItems, workloadMap, mappings] = await Promise.all([
      advisorService.buildDeveloperDirectory(),
      githubService.getOpenProjectItems(15),
      githubService.getProjectWorkloadByAssignee(),
      routingService.getAllMappings(),
    ]);

    const workload = [...workloadMap.entries()]
      .sort((a, b) => (b[1].total ?? 0) - (a[1].total ?? 0))
      .slice(0, 20)
      .map(([login, w]) => ({
        githubUsername: login,
        displayName: directory.find(d => d.githubUsername === login)?.displayName ?? login,
        open: w.open,
        inProgress: w.inProgress,
        total: w.total,
      }));

    const base: Record<string, unknown> = {
      githubRepo: `${config.github.owner}/${config.github.repo}`,
      projectBoard: TSS_PROJECT_NAME,
      projectUrl: TSS_PROJECT_URL,
      developers: directory.slice(0, 50).map(d => ({
        githubUsername: d.githubUsername,
        displayName: d.displayName,
        domains: d.domains,
      })),
      boardItems: projectItems.map(i => ({
        title: i.title,
        status: i.status,
        assignees: i.assignees,
        url: i.issueUrl,
      })),
      workload,
      routingTags: [...mappings.values()]
        .filter(m => m.active)
        .slice(0, 40)
        .map(m => ({
          tag: m.tag,
          githubUsername: m.githubUsername,
          ownerName: m.primaryOwnerName,
        })),
    };

    if (ctx.threadTs) {
      const threadContext = await slackService.getCollaborationThreadContext(
        ctx.channelId,
        ctx.threadTs,
        { excludeTs: ctx.messageTs }
      );
      if (threadContext) {
        base.threadContext = threadContext.slice(0, 4000);
      }
    }

    if (intent.kind === 'developer_workload') {
      const match = matchDevelopers(intent.developerQuery, directory, l =>
        l.replace(/^tss-/, '')
      );
      base.workloadQuery = intent.developerQuery;
      base.developerMatch = match;

      if (match.status === 'matched') {
        const login = match.profile.githubUsername;
        const [items, wl] = await Promise.all([
          githubService.getOpenProjectItemsForAssignee(login, 12),
          githubService.getProjectWorkloadByAssignee(),
        ]);
        base.focusedDeveloper = {
          ...match.profile,
          boardLoad: wl.get(login),
          openItems: items.map(i => ({
            title: i.title,
            status: i.status,
            url: i.issueUrl,
          })),
        };
      }
    }

    if (intent.kind === 'task_suggestion') {
      const message = parseSlackMessage(
        intent.taskDescription || ctx.rawText,
        ctx.messageTs,
        ctx.channelId,
        ctx.channelName,
        ctx.userId,
        ctx.userName,
        ctx.teamId
      );
      const triage = await triageService.triage(message);
      base.triage = {
        recommended: {
          githubUsername: triage.assignment.githubUsername,
          displayName: triage.assignment.primaryOwnerName,
          score: triage.chosen.score,
          signals: triage.chosen.signals.map(s => s.kind),
        },
        candidates: triage.candidates.slice(0, 5).map(c => ({
          githubUsername: c.githubUsername,
          displayName: c.slackName,
          score: c.score,
          signals: c.signals.map(s => s.kind),
        })),
      };
      base.taskDescription = intent.taskDescription;
    }

    return base;
  }
}

export const groqAdvisorService = GroqAdvisorService.getInstance();
