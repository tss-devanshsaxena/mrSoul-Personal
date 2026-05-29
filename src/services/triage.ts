import { ParsedSlackMessage, IssueAssignment } from '../types';
import { routingService } from './routing';
import { createLogger } from '../utils/logger';
import { githubService } from './github';
import { config } from '../config';

const log = createLogger('triage');

export type TriageSignal =
  | { kind: 'slack_mention'; slackUserId: string; score: number }
  | { kind: 'hashtag_match'; tag: string; score: number }
  | { kind: 'workload_penalty'; open: number; inProgress: number; score: number }
  | { kind: 'recent_activity_boost'; count: number; score: number }
  | { kind: 'project_title_match'; matchedTitle: string; score: number }
  | { kind: 'fallback_default'; score: number };

export interface TriageDecision {
  assignment: IssueAssignment;
  candidates: Array<{ slackUserId: string; slackName: string; githubUsername: string; score: number; signals: TriageSignal[] }>;
  chosen: { score: number; signals: TriageSignal[] };
}

function extractSlackMentions(text: string): string[] {
  // Slack user mentions look like: <@U012ABCDEF>
  const matches = text.match(/<@([A-Z0-9]+)>/g) ?? [];
  return [...new Set(matches.map(m => m.slice(2, -1)))];
}

export class TriageService {
  private static instance: TriageService;

  static getInstance(): TriageService {
    if (!TriageService.instance) {
      TriageService.instance = new TriageService();
    }
    return TriageService.instance;
  }

  /**
   * Deterministic assignment with cheap signals.
   *
   * Order of strength:
   * - Explicit Slack mention of a routed owner
   * - Hashtag-based mapping (first match)
   * - Default owner fallback
   */
  async triage(message: ParsedSlackMessage): Promise<TriageDecision> {
    const mappings = await routingService.getAllMappings();
    const mentioned = extractSlackMentions(message.text).filter(id => id !== config.slack.botUserId);

    const candidates: TriageDecision['candidates'] = [];

    const byGithub = new Map<string, TriageDecision['candidates'][number]>();

    for (const m of mappings.values()) {
      if (!m.active) continue;
      const c = {
        slackUserId: m.primaryOwner,
        slackName: m.primaryOwnerName,
        githubUsername: m.githubUsername,
        score: 0,
        signals: [],
      };
      candidates.push(c);
      byGithub.set(c.githubUsername, c);
    }

    // 1) Slack mention signal
    for (const c of candidates) {
      if (mentioned.includes(c.slackUserId)) {
        c.score += 100;
        c.signals.push({ kind: 'slack_mention', slackUserId: c.slackUserId, score: 100 });
      }
    }

    // 2) Hashtag signal
    for (const tag of message.hashtags) {
      const mapping = mappings.get(tag);
      if (!mapping?.active) continue;

      const c = candidates.find(x => x.slackUserId === mapping.primaryOwner);
      if (c) {
        c.score += 50;
        c.signals.push({ kind: 'hashtag_match', tag, score: 50 });
      }

      // First match wins strongly; keep scoring but break to preserve determinism.
      break;
    }

    // 3) GitHub signals (best-effort): workload penalty + recent activity boost
    const [workload, activity, projectTitleAssignees] = await Promise.all([
      githubService.getProjectWorkloadByAssignee(),
      githubService.getRecentRepoActivityCounts(14),
      githubService.inferAssigneesFromProjectTitles(message.text, 3),
    ]);

    // Expand candidate pool using real GitHub signals (so we can assign to people like tss-arush)
    const inferredFromSearch = await githubService.searchTopContributorsFromText(message.text, 5);
    const githubUsernames = new Set<string>([
      ...workload.keys(),
      ...activity.keys(),
      ...inferredFromSearch,
      ...projectTitleAssignees.map(x => x.login),
    ]);

    for (const login of githubUsernames) {
      if (byGithub.has(login)) continue;
      const c = {
        slackUserId: '', // unknown unless configured in mappings
        slackName: login,
        githubUsername: login,
        score: 0,
        signals: [],
      };
      candidates.push(c);
      byGithub.set(login, c);
    }

    for (const c of candidates) {
      const match = projectTitleAssignees.find(m => m.login === c.githubUsername);
      if (match) {
        const boost = Math.round(60 * match.score);
        c.score += boost;
        c.signals.push({ kind: 'project_title_match', matchedTitle: match.matchedTitle, score: boost });
      }

      const wl = workload.get(c.githubUsername);
      if (wl) {
        // Penalize in-progress more than open.
        const penalty = Math.min(40, wl.open * 2 + wl.inProgress * 5);
        c.score -= penalty;
        c.signals.push({ kind: 'workload_penalty', open: wl.open, inProgress: wl.inProgress, score: -penalty });
      }

      const act = activity.get(c.githubUsername);
      if (act && act > 0) {
        const boost = Math.min(15, act * 2);
        c.score += boost;
        c.signals.push({ kind: 'recent_activity_boost', count: act, score: boost });
      }
    }

    // 4) No routable people — do not invent test assignees.
    if (candidates.length === 0) {
      const assignment: IssueAssignment = {
        primaryOwnerId: 'unassigned',
        primaryOwnerName: 'Unassigned',
        secondaryOwnerIds: [],
        githubUsername: config.github.fallbackAssignee?.trim() ?? '',
        resolvedFromTags: [],
      };
      return {
        assignment,
        candidates: [],
        chosen: { score: 0, signals: [{ kind: 'fallback_default', score: 0 }] },
      };
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];

    const resolvedFromTags: string[] = [];
    for (const s of top.signals) {
      if (s.kind === 'hashtag_match') resolvedFromTags.push(s.tag);
    }

    const assignment: IssueAssignment = {
      // If we don't know the Slack user ID for this GitHub username, avoid a bad mention later.
      primaryOwnerId: top.slackUserId || 'unknown',
      primaryOwnerName: top.slackName,
      secondaryOwnerIds: [],
      githubUsername: top.githubUsername,
      resolvedFromTags,
    };

    log.info('Triage decision', {
      issueChannel: message.channelName,
      hashtags: message.hashtags,
      mentioned,
      chosen: assignment.githubUsername,
      score: top.score,
      signals: top.signals.map(s => s.kind),
    });

    return {
      assignment,
      candidates,
      chosen: { score: top.score, signals: top.signals },
    };
  }
}

export const triageService = TriageService.getInstance();

