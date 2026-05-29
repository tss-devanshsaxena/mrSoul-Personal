import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { parseSlackMessage } from '../../utils/messageParser';
import { triageService } from '../../services/triage';
import { githubService } from '../../services/github';
import { routingService } from '../../services/routing';
import { advisorService } from '../../services/advisor';

const PLACEHOLDER_TEAM = 'T00000000';

/**
 * ADK tools backed by existing deterministic services (GitHub, triage, routing).
 * Lazy imports are not needed — these modules do not import ADK.
 */
export const triageTaskTool = new FunctionTool({
  name: 'triage_task',
  description:
    'Score CE-Tech developers for owning a Slack task. Uses hashtag routing, mentions, GitHub project board, and workload.',
  parameters: z.object({
    taskDescription: z.string().describe('Task or issue text from Slack'),
    hashtags: z.array(z.string()).optional().describe('Hashtags like refund, order'),
  }) as never,
  execute: async (input: { taskDescription: string; hashtags?: string[] }) => {
    const hashtags = (input.hashtags ?? []).map((t: string) => (t.startsWith('#') ? t : `#${t}`));
    const message = parseSlackMessage(
      input.taskDescription,
      'adk-triage',
      'adk',
      'adk',
      'adk',
      'MrSoul ADK',
      PLACEHOLDER_TEAM
    );
    message.hashtags = hashtags.length > 0 ? hashtags : message.hashtags;

    const decision = await triageService.triage(message);
    return {
      recommended: {
        githubUsername: decision.assignment.githubUsername,
        displayName: decision.assignment.primaryOwnerName,
        score: decision.chosen.score,
        signals: decision.chosen.signals.map(s => s.kind),
      },
      candidates: decision.candidates.slice(0, 5).map(c => ({
        githubUsername: c.githubUsername,
        displayName: c.slackName,
        score: c.score,
        signals: c.signals.map(s => s.kind),
      })),
    };
  },
});

export const lookupDeveloperWorkloadTool = new FunctionTool({
  name: 'lookup_developer_workload',
  description:
    'Return open GitHub project items and workload counts for a developer (name or tss-* login).',
  parameters: z.object({
    developerQuery: z.string().describe('First name, display name, or GitHub login'),
  }) as never,
  execute: async (input: { developerQuery: string }) => {
    const directory = await advisorService.buildDeveloperDirectory();
    const match = advisorService.resolveDeveloperQuery(input.developerQuery, directory);

    if (match.status === 'not_found') {
      return {
        status: 'not_found',
        query: input.developerQuery,
        suggestions: match.suggestions.slice(0, 5).map(p => p.githubUsername),
      };
    }
    if (match.status === 'ambiguous') {
      return {
        status: 'ambiguous',
        query: input.developerQuery,
        matches: match.matches.map(p => ({
          githubUsername: p.githubUsername,
          displayName: p.displayName,
        })),
      };
    }

    const login = match.profile.githubUsername;
    const [boardItems, workload] = await Promise.all([
      githubService.getOpenProjectItemsForAssignee(login, 10),
      githubService.getProjectWorkloadByAssignee(),
    ]);
    const wl = workload.get(login);

    return {
      status: 'ok',
      developer: match.profile,
      boardLoad: wl ?? { open: 0, inProgress: 0, total: 0 },
      openItems: boardItems.slice(0, 8).map(i => ({
        title: i.title,
        status: i.status,
        url: i.issueUrl,
      })),
    };
  },
});

export const getTeamRosterTool = new FunctionTool({
  name: 'get_team_roster',
  description: 'Summarize who on the team has open work on the TSS GitHub project board.',
  parameters: z.object({}) as never,
  execute: async () => {
    const [projectItems, workload, directory] = await Promise.all([
      githubService.getOpenProjectItems(8),
      githubService.getProjectWorkloadByAssignee(),
      advisorService.buildDeveloperDirectory(),
    ]);

    const nameByLogin = new Map(directory.map(d => [d.githubUsername, d.displayName]));
    const logins = [...workload.keys()].sort(
      (a, b) => (workload.get(b)?.total ?? 0) - (workload.get(a)?.total ?? 0)
    );

    return {
      developers: logins.slice(0, 15).map(login => ({
        login,
        name: nameByLogin.get(login) ?? login.replace(/^tss-/, ''),
        load: workload.get(login),
        sampleTitles: projectItems
          .filter(i => i.assignees.includes(login))
          .slice(0, 2)
          .map(i => i.title),
      })),
    };
  },
});

export const listRoutingDomainsTool = new FunctionTool({
  name: 'list_routing_domains',
  description: 'List hashtag → developer routing mappings configured for CE-Tech.',
  parameters: z.object({}) as never,
  execute: async () => {
    const mappings = await routingService.getAllMappings();
    return {
      mappings: [...mappings.values()]
        .filter(m => m.active)
        .map(m => ({
          tag: m.tag,
          owner: m.primaryOwnerName,
          githubUsername: m.githubUsername,
        })),
    };
  },
});

export const mrsoulAdvisorTools = [
  triageTaskTool,
  lookupDeveloperWorkloadTool,
  getTeamRosterTool,
  listRoutingDomainsTool,
];
