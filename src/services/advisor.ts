import { Issue } from '../models';
import { ParsedSlackMessage } from '../types';
import { createLogger } from '../utils/logger';
import { githubService, ProjectOpenItem } from './github';
import { routingService } from './routing';
import { triageService, TriageDecision } from './triage';
import { parseSlackMessage } from '../utils/messageParser';
import { SlackIntent } from './intent';
import { buildGuidelinesBlocks, buildGuidelinesMrkdwn } from '../content/mrsoulGuidelines';
import { adkService } from './adkService';
import { groqAdvisorService } from './groqAdvisor';
import { config } from '../config';

const log = createLogger('advisor');

import {
  matchDevelopers,
  normalizeToken,
  parseExplicitGithubLogin,
  type DeveloperProfile,
} from './developerMatch';

export type { DeveloperProfile } from './developerMatch';
export { parseExplicitGithubLogin } from './developerMatch';

function displayFromGithub(login: string): string {
  const base = login.replace(/^tss-/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export class AdvisorService {
  private static instance: AdvisorService;

  static getInstance(): AdvisorService {
    if (!AdvisorService.instance) {
      AdvisorService.instance = new AdvisorService();
    }
    return AdvisorService.instance;
  }

  async handleIntent(
    intent: SlackIntent,
    context: {
      channelId: string;
      channelName: string;
      messageTs: string;
      userId: string;
      userName: string;
      teamId: string;
      rawText: string;
      threadTs?: string;
    }
  ): Promise<{ text: string; blocks?: Record<string, unknown>[] }> {
    if (groqAdvisorService.isEnabled() && intent.kind !== 'create_issue') {
      try {
        const groqReply = await groqAdvisorService.answer(intent, context);
        if (groqReply?.text?.trim()) {
          return groqReply;
        }
      } catch (err) {
        log.warn('Groq advisor failed; falling back', { error: (err as Error).message });
      }
    }

    if (
      config.adk.advisorMode === 'agent' &&
      adkService.isEnabled() &&
      intent.kind !== 'help'
    ) {
      const agentReply = await adkService.runAdvisorQuery(context.rawText, context.userId);
      if (agentReply?.trim()) {
        return {
          text: agentReply.slice(0, 3000),
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: agentReply.slice(0, 3000) },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: '_Powered by MrSoul ADK (Gemini + GitHub tools)_',
                },
              ],
            },
          ],
        };
      }
    }

    switch (intent.kind) {
      case 'help':
        return { text: buildGuidelinesMrkdwn(), blocks: buildGuidelinesBlocks() };
      case 'developer_workload':
        return this.answerDeveloperWorkload(intent.developerQuery, context);
      case 'team_roster':
        return this.answerTeamRoster();
      case 'task_suggestion':
        return this.answerTaskSuggestion(intent.taskDescription, context);
      default:
        return { text: buildGuidelinesMrkdwn(), blocks: buildGuidelinesBlocks() };
    }
  }

  async buildDeveloperDirectory(): Promise<DeveloperProfile[]> {
    const mappings = await routingService.getAllMappings();
    const byGithub = new Map<string, DeveloperProfile>();

    for (const m of mappings.values()) {
      if (!m.active || !m.githubUsername) continue;
      const existing = byGithub.get(m.githubUsername);
      const domain = m.tag.replace(/^#/, '');
      if (existing) {
        if (!existing.domains.includes(domain)) existing.domains.push(domain);
        if (m.primaryOwnerName && existing.displayName === displayFromGithub(m.githubUsername)) {
          existing.displayName = m.primaryOwnerName;
        }
        if (m.primaryOwner && !m.primaryOwner.startsWith('U_')) {
          existing.slackUserId = m.primaryOwner;
        }
      } else {
        byGithub.set(m.githubUsername, {
          githubUsername: m.githubUsername,
          displayName: m.primaryOwnerName || displayFromGithub(m.githubUsername),
          slackUserId: m.primaryOwner.startsWith('U_') ? undefined : m.primaryOwner,
          domains: domain ? [domain] : [],
        });
      }
    }

    const projectItems = await githubService.getOpenProjectItems(8);
    for (const item of projectItems) {
      for (const login of item.assignees) {
        if (!byGithub.has(login)) {
          byGithub.set(login, {
            githubUsername: login,
            displayName: displayFromGithub(login),
            domains: [],
          });
        }
      }
    }

    return [...byGithub.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** @deprecated Use matchDevelopers — kept for tests */
  resolveDeveloper(query: string, directory: DeveloperProfile[]): DeveloperProfile | null {
    const result = matchDevelopers(query, directory, displayFromGithub);
    return result.status === 'matched' ? result.profile : null;
  }

  resolveDeveloperQuery(query: string, directory: DeveloperProfile[]) {
    return matchDevelopers(query, directory, displayFromGithub);
  }

  private async fetchBoardItemsForDeveloper(login: string): Promise<ProjectOpenItem[]> {
    const fromBoard = await githubService.getOpenProjectItemsForAssignee(login, 12);
    if (fromBoard.length > 0) return fromBoard;

    const fromSearch = await githubService.searchOpenAssignedIssues(login);
    const seen = new Set<string>();
    const merged: ProjectOpenItem[] = [];

    for (const item of [...fromBoard, ...fromSearch]) {
      const key = item.issueUrl ?? item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    return merged;
  }

  private async answerDeveloperWorkload(
    developerQuery: string,
    context: { channelId: string; channelName: string; messageTs: string; userId: string; userName: string; teamId: string }
  ): Promise<{ text: string; blocks?: Record<string, unknown>[] }> {
    const directory = await this.buildDeveloperDirectory();
    const match = this.resolveDeveloperQuery(developerQuery, directory);

    if (match.status === 'ambiguous') {
      const lines = match.matches
        .map(p => `• *${p.displayName}* — \`${p.githubUsername}\``)
        .join('\n');
      return {
        text: `Multiple matches for "${developerQuery}"`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Several people match* \`${match.query}\`:\n${lines}\n\nAsk again with the full GitHub username, e.g. \`what is tss-akritiraj working on?\``,
            },
          },
        ],
      };
    }

    if (match.status === 'not_found') {
      const suggestions = match.suggestions
        .map(p => `• ${p.displayName} (\`${p.githubUsername}\`)`)
        .join('\n');

      return {
        text: `I couldn't find a developer matching "${developerQuery}".`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*No match for* \`${match.query}\`\n\nTry first name + more letters, or the full login:\n${suggestions || '_e.g. `what is tss-akritiraj working on?`_'}`,
            },
          },
        ],
      };
    }

    const dev = match.profile;

    const [boardItems, mongoIssues, workload] = await Promise.all([
      this.fetchBoardItemsForDeveloper(dev.githubUsername),
      Issue.find({
        'assignment.githubUsername': dev.githubUsername,
        status: { $in: ['open', 'in_progress', 'pr_opened'] },
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .lean(),
      githubService.getProjectWorkloadByAssignee(),
    ]);
    const wl = workload.get(dev.githubUsername);

    const domainLine =
      dev.domains.length > 0
        ? `*Domains / tags:* ${dev.domains.map(d => `\`#${d}\``).join(', ')}`
        : '*Domains:* _not in routing map yet_';

    const boardLines =
      boardItems.length === 0
        ? '_No open items on the TSS project board for this person._'
        : boardItems
            .slice(0, 8)
            .map(i => this.formatProjectItemLine(i))
            .join('\n');

    const localLines =
      mongoIssues.length === 0
        ? ''
        : '\n*CE-Tech tracked issues:*\n' +
          mongoIssues
            .slice(0, 5)
            .map((iss: { githubIssue?: { issueUrl?: string; issueNumber?: number }; originalMessage?: string }) => {
              const link = iss.githubIssue?.issueUrl
                ? `<${iss.githubIssue.issueUrl}|#${iss.githubIssue.issueNumber}>`
                : '_no GitHub link_';
              const preview = (iss.originalMessage ?? '').replace(/\n/g, ' ').slice(0, 60);
              return `• ${link} — ${preview}…`;
            })
            .join('\n');

    const loadLine = wl
      ? `*Board load:* ${wl.inProgress} in progress, ${wl.open} open (${wl.total} total)`
      : '*Board load:* _none counted_';

    const blocks: Record<string, unknown>[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${dev.displayName} — current work`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [`*GitHub:* \`${dev.githubUsername}\``, domainLine, loadLine].join('\n'),
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Project board (${boardItems.length}):*\n${boardLines}${localLines}`,
        },
      },
    ];

    log.info('Advisor developer workload', {
      query: developerQuery,
      resolved: dev.githubUsername,
      boardCount: boardItems.length,
      channel: context.channelName,
    });

    return {
      text: `${dev.displayName} (${dev.githubUsername}): ${boardItems.length} board items`,
      blocks,
    };
  }

  private async answerTeamRoster(): Promise<{ text: string; blocks?: Record<string, unknown>[] }> {
    const [projectItems, workload, directory] = await Promise.all([
      githubService.getOpenProjectItems(8),
      githubService.getProjectWorkloadByAssignee(),
      this.buildDeveloperDirectory(),
    ]);

    const byLogin = new Map<string, ProjectOpenItem[]>();
    for (const item of projectItems) {
      for (const login of item.assignees) {
        const list = byLogin.get(login) ?? [];
        list.push(item);
        byLogin.set(login, list);
      }
    }

    const logins = [...new Set([...byLogin.keys(), ...workload.keys()])].sort((a, b) => {
      const wa = workload.get(a)?.total ?? 0;
      const wb = workload.get(b)?.total ?? 0;
      return wb - wa;
    });

    if (logins.length === 0) {
      return {
        text: 'No open assigned work found on the project board.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '_No open assigned items on the TSS project board right now._',
            },
          },
        ],
      };
    }

    const nameByLogin = new Map(directory.map(d => [d.githubUsername, d.displayName]));

    const lines = logins.slice(0, 15).map(login => {
      const name = nameByLogin.get(login) ?? displayFromGithub(login);
      const wl = workload.get(login);
      const items = byLogin.get(login) ?? [];
      const top = items.slice(0, 2).map(i => `「${i.title}」`).join(', ');
      const load = wl ? `${wl.inProgress} in progress / ${wl.open} open` : '—';
      return `*${name}* (\`${login}\`) — ${load}\n  ${top || '_no titles_'}`;
    });

    return {
      text: `Team workload: ${logins.length} developers with open board items`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Who is working on what', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: lines.join('\n\n'),
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '_Source: TSS Product & Tech Master project + routing domains. Ask e.g. `what is Akriti working on?`_',
            },
          ],
        },
      ],
    };
  }

  private async answerTaskSuggestion(
    taskDescription: string,
    context: { channelId: string; channelName: string; messageTs: string; userId: string; userName: string; teamId: string }
  ): Promise<{ text: string; blocks?: Record<string, unknown>[] }> {
    const message = parseSlackMessage(
      taskDescription,
      context.messageTs,
      context.channelId,
      context.channelName,
      context.userId,
      context.userName,
      context.teamId
    );

    const triage: TriageDecision = await triageService.triage(message);
    const top = triage.candidates.slice(0, 3);

    const lines = top.map((c, i) => {
      const signals = c.signals.map(s => {
        switch (s.kind) {
          case 'project_title_match':
            return `matched board item "${s.matchedTitle}"`;
          case 'workload_penalty':
            return `load: ${s.open} open, ${s.inProgress} in progress`;
          case 'hashtag_match':
            return `domain tag ${s.tag}`;
          case 'recent_activity_boost':
            return `recent repo activity (${s.count})`;
          case 'slack_mention':
            return 'mentioned in message';
          default:
            return s.kind;
        }
      });
      return `${i + 1}. *${c.slackName || c.githubUsername}* (\`${c.githubUsername}\`) — score ${c.score}\n   _${signals.join(' · ') || 'default'}_`;
    });

    const chosen = triage.assignment;
    const isUnassigned =
      !chosen.githubUsername ||
      chosen.primaryOwnerName === 'Unassigned' ||
      triage.candidates.length === 0;

    if (isUnassigned) {
      return {
        text: 'No owner could be inferred from routing or the GitHub project board.',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'Could not suggest an owner', emoji: true },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `*Task:*\n>${taskDescription.slice(0, 500).replace(/\n/g, '\n>')}\n\n` +
                'No one is configured in *hashtag routing* for this topic, and the project board did not yield a clear match.\n\n' +
                '*Next steps:*\n' +
                '• Add a real mapping: `PUT /api/routing` with tag, Slack user ID, and GitHub login\n' +
                '• Or @mention the right person in Slack, then use `create issue`\n' +
                '• Or set `GITHUB_FALLBACK_ASSIGNEE` in `.env` for GitHub-only fallback',
            },
          },
        ],
      };
    }

    const suggestCreate =
      `\n\n_To create a tracked issue with this assignee, add a matching hashtag or say \`create issue\` with your description._`;

    const narrative = await adkService.enrichTaskSuggestion(taskDescription, triage);
    const narrativeBlock =
      narrative != null
        ? {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: `*${narrative.headline}*\n${narrative.rationale}${
                narrative.alternativesNote ? `\n_${narrative.alternativesNote}_` : ''
              }`,
            },
          }
        : null;

    return {
      text: `Suggested owner: ${chosen.githubUsername} (${chosen.primaryOwnerName})`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Suggested owner for this task', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Task:*\n>${taskDescription.slice(0, 500).replace(/\n/g, '\n>')}`,
          },
        },
        ...(narrativeBlock ? [narrativeBlock] : []),
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Recommendation:* \`${chosen.githubUsername}\` (${chosen.primaryOwnerName})\n\n*Ranked candidates:*\n${lines.join('\n')}${suggestCreate}`,
          },
        },
      ],
    };
  }

  private formatProjectItemLine(item: ProjectOpenItem): string {
    const status = item.status ? ` [${item.status}]` : '';
    const link = item.issueUrl ? `<${item.issueUrl}|${item.title}>` : item.title;
    return `• ${link}${status}`;
  }

}

export const advisorService = AdvisorService.getInstance();
