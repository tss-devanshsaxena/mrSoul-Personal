import { Octokit } from '@octokit/rest';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { withRetry, RateLimiter } from '../utils/retry';
import { ParsedSlackMessage, IssueAssignment, GitHubIssueRef, Priority } from '../types';
import type { LlmIssueSummary } from './llm';
import {
  DerivedIssueGuidelines,
  buildGuidelinesChecklistMarkdown,
  deriveIssueGuidelines,
} from './issueGuidelines';
import { TSS_PROJECT_URL } from '../content/tssIssueGuidelines';
import { formatPrdPlainText } from '../content/prdBlocks';
import type { AdkPrd } from '../agents/schemas';
import { buildPrdDocxBuffer, prdDocxFilename } from './prdDocx';
import { activityFeed } from './activityFeed';

const log = createLogger('github');

// GitHub API: max 5000 requests/hour for authenticated user = ~1.38 req/sec
const rateLimiter = new RateLimiter(1); // conservative: 1 req/sec

const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'priority: critical',
  urgent: 'priority: urgent',
  high: 'priority: high',
  medium: 'priority: medium',
  low: 'priority: low',
};

export interface ProjectOpenItem {
  title: string;
  status?: string;
  assignees: string[];
  issueUrl?: string;
  repo?: string;
}

export class GitHubService {
  private static instance: GitHubService;
  private octokit: Octokit;
  private projectCache?: {
    projectId: string;
    fieldsByName: Map<string, { id: string; kind: 'text' | 'date' | 'number' | 'single_select'; options?: Map<string, string> }>;
  };

  private constructor() {
    this.octokit = new Octokit({
      auth: config.github.token,
      throttle: {
        onRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
          log.warn('GitHub rate limit hit', { url: options.url, retryAfter });
          return retryAfter <= 60; // Retry if rate reset within 60s
        },
        onSecondaryRateLimit: (_retryAfter: number, options: { method: string; url: string }) => {
          log.warn('GitHub secondary rate limit hit', { url: options.url });
          return false;
        },
      },
    });
  }

  static getInstance(): GitHubService {
    if (!GitHubService.instance) {
      GitHubService.instance = new GitHubService();
    }
    return GitHubService.instance;
  }

  /**
   * Create a GitHub issue from a Slack message.
   */
  async createIssue(
    message: ParsedSlackMessage,
    assignment: IssueAssignment,
    issueId: string,
    llmSummary?: LlmIssueSummary | null,
    guidelines?: DerivedIssueGuidelines,
    extras?: { prdMarkdown?: string; prd?: AdkPrd | Record<string, unknown> }
  ): Promise<GitHubIssueRef> {
    await rateLimiter.acquire();

    const g = guidelines ?? deriveIssueGuidelines(message);
    const title = this.buildIssueTitle(message);
    const body = this.buildIssueBody(message, assignment, issueId, g, llmSummary ?? undefined, extras?.prdMarkdown);
    const labels = this.buildLabels(message, g);
    const assignees = [assignment.githubUsername].filter(Boolean);
    if (assignees.length === 0) {
      throw new Error('Missing GitHub assignee username (required by guidelines)');
    }

    return withRetry(async () => {
      log.info('Creating GitHub issue', { title, labels });

      // Ensure required labels exist
      await this.ensureLabelsExist(labels);

      const create = async (assigneesToUse: string[]) =>
        this.octokit.issues.create({
          owner: config.github.owner,
          repo: config.github.repo,
          title,
          body,
          labels,
          assignees: assigneesToUse,
        });

      let data: any;
      try {
        ({ data } = await create(assignees));
      } catch (err) {
        const e = err as any;
        const status = e?.status;
        const ghMessage = e?.response?.data?.errors?.[0]?.message as string | undefined;
        const invalidAssignee = status === 422 && typeof ghMessage === 'string' && ghMessage.includes('cannot be assigned');

        if (!invalidAssignee) throw err;

        const fallback = (config.github as any).fallbackAssignee as string | undefined;
        if (!fallback) throw err;

        log.warn('Assignee not assignable; falling back', {
          requested: assignees,
          fallback,
        });

        ({ data } = await create([fallback]));

        // Add a comment so it's not lost who should actually take it.
        await this.addComment(data.number, [
          'Auto-triage selected assignee is not assignable in this repository.',
          `- Intended assignee: @${assignment.githubUsername}`,
          `- Fallback assignee used: @${fallback}`,
          '',
          'Fix: add the intended assignee as a collaborator, or create issues in an org repo where they have access.',
        ].join('\n'));
      }

      log.info('GitHub issue created', {
        number: data.number,
        url: data.html_url,
        assignee: (data.assignees?.[0]?.login) ?? assignment.githubUsername,
      });

      // Enforce TSS guidelines: project board + mandatory fields (best-effort)
      await this.applyIssueGuidelines(g, data.node_id, data.number).catch((err: Error) => {
        log.error('Failed to apply GitHub project guidelines', { error: err.message, issueNumber: data.number });
      });

      const ref: GitHubIssueRef = {
        issueNumber: data.number,
        issueUrl: data.html_url,
        issueTitle: data.title,
        nodeId: data.node_id,
      };

      if (extras?.prd) {
        await this.attachPrdToIssue(ref.issueNumber, extras.prd).catch((err: Error) => {
          log.warn('PRD attach to GitHub issue failed', {
            issueNumber: ref.issueNumber,
            error: err.message,
          });
        });
      }

      return ref;
    });
  }

  /**
   * Attach PRD to a GitHub issue: upload .docx to the repo + comment with download link.
   * Requires PAT scope `repo` (contents write). Falls back to markdown-only comment.
   */
  async attachPrdToIssue(
    issueNumber: number,
    prd: AdkPrd | Record<string, unknown>
  ): Promise<{ docUrl?: string }> {
    const owner = config.github.owner;
    const repo = config.github.repo;
    const filename = prdDocxFilename(prd as AdkPrd);
    const path = `docs/prds/issue-${issueNumber}/${filename}`;
    let docUrl: string | undefined;

    try {
      const { data: repoMeta } = await this.octokit.repos.get({ owner, repo });
      const branch = repoMeta.default_branch ?? 'main';

      const buffer = await buildPrdDocxBuffer(prd as AdkPrd);
      let sha: string | undefined;
      try {
        const existing = await this.octokit.repos.getContent({ owner, repo, path, ref: branch });
        if (!Array.isArray(existing.data) && existing.data.type === 'file') {
          sha = existing.data.sha;
        }
      } catch {
        // new file
      }

      await rateLimiter.acquire();
      const uploaded = await withRetry(() =>
        this.octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          branch,
          message: `docs: PRD for issue #${issueNumber} — ${(prd as AdkPrd).title ?? 'PRD'}`,
          content: buffer.toString('base64'),
          sha,
        })
      );
      docUrl = uploaded.data.content?.html_url ?? `https://github.com/${owner}/${repo}/blob/${branch}/${path}`;
      log.info('PRD docx uploaded to repository', { issueNumber, path, docUrl });
    } catch (err) {
      log.warn('PRD docx repo upload failed; will comment markdown only', {
        issueNumber,
        error: (err as Error).message,
      });
    }

    const prdMarkdown = formatPrdPlainText(prd);
    const maxLen = 58_000;
    const truncated =
      prdMarkdown.length > maxLen
        ? `${prdMarkdown.slice(0, maxLen)}\n\n_…PRD truncated in comment${docUrl ? '; download .docx above._' : '._'}_`
        : prdMarkdown;

    const commentParts = [
      '## 📎 PRD attached (MrSoul `/create-ticket`)',
      '',
      docUrl ? `**Download PRD (.docx):** [${filename}](${docUrl})` : '',
      docUrl ? '' : '_Could not upload .docx to repo (check GitHub token has `repo` scope). Full PRD markdown below._',
      '',
      truncated,
    ].filter(line => line !== undefined);

    await this.addComment(issueNumber, commentParts.join('\n'));
    return { docUrl };
  }

  /**
   * Add a comment to an existing GitHub issue.
   */
  async addComment(issueNumber: number, body: string): Promise<void> {
    await rateLimiter.acquire();
    await withRetry(() =>
      this.octokit.issues.createComment({
        owner: config.github.owner,
        repo: config.github.repo,
        issue_number: issueNumber,
        body,
      })
    );
    log.info('Added comment to GitHub issue', { issueNumber });
  }

  /**
   * Close a GitHub issue.
   */
  async closeIssue(issueNumber: number): Promise<void> {
    await rateLimiter.acquire();
    await withRetry(() =>
      this.octokit.issues.update({
        owner: config.github.owner,
        repo: config.github.repo,
        issue_number: issueNumber,
        state: 'closed',
      })
    );
    log.info('Closed GitHub issue', { issueNumber });
  }

  /**
   * Verify webhook signature from GitHub.
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!config.github.webhookSecret) return true; // Bypass if no secret configured

    const crypto = require('crypto');
    const computedSig = 'sha256=' + crypto
      .createHmac('sha256', config.github.webhookSecret)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(computedSig)
    );
  }

  /**
   * Workload signal from GitHub Project (Projects v2).
   * Returns counts grouped by GitHub username.
   *
   * Best-effort: if project isn't configured or query fails, returns empty map.
   */
  /**
   * Open (non-Done) issues on the org Project board with assignees and status.
   */
  async getOpenProjectItems(maxPages: number = 3): Promise<ProjectOpenItem[]> {
    const org = config.github.project.org;
    const number = config.github.project.number;
    if (!org || !number) return [];

    await rateLimiter.acquire();

    try {
      await this.getProjectMetadata(org, number);

      const query = `query($org: String!, $number: Int!, $cursor: String) {
        organization(login: $org) {
          projectV2(number: $number) {
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                content {
                  __typename
                  ... on Issue {
                    title
                    state
                    url
                    assignees(first: 10) { nodes { login } }
                    repository { nameWithOwner }
                  }
                }
                fieldValues(first: 30) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2SingleSelectField { name } }
                    }
                  }
                }
              }
            }
          }
        }
      }`;

      const rawNodes: any[] = [];
      let cursor: string | null = null;

      for (let i = 0; i < maxPages; i++) {
        const resp: any = await this.octokit.graphql<any>(query, { org, number, cursor });
        const page: any = resp?.organization?.projectV2?.items;
        rawNodes.push(...(page?.nodes ?? []));
        const pi: any = page?.pageInfo;
        if (!pi?.hasNextPage) break;
        cursor = pi.endCursor ?? null;
        await rateLimiter.acquire();
      }

      const out: ProjectOpenItem[] = [];

      for (const item of rawNodes) {
        const content = item?.content;
        if (!content || content.__typename !== 'Issue') continue;
        if (content.state !== 'OPEN') continue;

        let statusValue: string | undefined;
        for (const n of item?.fieldValues?.nodes ?? []) {
          if (n?.field?.name === 'Status') {
            statusValue = n?.name;
            break;
          }
        }
        if (statusValue?.toLowerCase() === 'done') continue;

        const assignees: string[] = (content.assignees?.nodes ?? [])
          .map((n: any) => n.login)
          .filter(Boolean);
        if (assignees.length === 0) continue;

        out.push({
          title: content.title ?? 'Untitled',
          status: statusValue,
          assignees,
          issueUrl: content.url,
          repo: content.repository?.nameWithOwner,
        });
      }

      return out;
    } catch (err) {
      log.warn('Failed to query open project items', { error: (err as Error).message });
      return [];
    }
  }

  /** Board items assigned to a specific GitHub user (paginates deeper than the default roster slice). */
  async getOpenProjectItemsForAssignee(login: string, maxPages: number = 12): Promise<ProjectOpenItem[]> {
    const items = await this.getOpenProjectItems(maxPages);
    return items.filter(i => i.assignees.includes(login));
  }

  /**
   * Org-wide open issues for an assignee (fallback when board pagination misses them).
   */
  async searchOpenAssignedIssues(login: string, limit: number = 15): Promise<ProjectOpenItem[]> {
    const org = config.github.project.org ?? config.github.owner;
    await rateLimiter.acquire();

    try {
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `org:${org} assignee:${login} is:issue state:open`,
        per_page: limit,
        sort: 'updated',
        order: 'desc',
      });

      return (data.items ?? []).map(item => {
        const repoMatch = item.repository_url?.match(/repos\/([^/]+\/[^/]+)/);
        return {
          title: item.title ?? 'Untitled',
          assignees: [login],
          issueUrl: item.html_url,
          repo: repoMatch?.[1],
        };
      });
    } catch (err) {
      log.warn('Assignee issue search failed', { login, error: (err as Error).message });
      return [];
    }
  }

  async getProjectWorkloadByAssignee(): Promise<Map<string, { open: number; inProgress: number; total: number }>> {
    const items = await this.getOpenProjectItems(8);
    const counts = new Map<string, { open: number; inProgress: number; total: number }>();

    for (const item of items) {
      const isInProgress = ['in progress', 'blocked'].includes((item.status ?? '').toLowerCase());
      for (const login of item.assignees) {
        const cur = counts.get(login) ?? { open: 0, inProgress: 0, total: 0 };
        if (isInProgress) cur.inProgress += 1;
        else cur.open += 1;
        cur.total += 1;
        counts.set(login, cur);
      }
    }

    return counts;
  }

  /**
   * Recency signal from repo activity (cheap heuristic).
   * Counts recent PRs + commits by author.
   */
  async getRecentRepoActivityCounts(days: number = 14): Promise<Map<string, number>> {
    await rateLimiter.acquire();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const counts = new Map<string, number>();

    try {
      const prs = await this.octokit.pulls.list({
        owner: config.github.owner,
        repo: config.github.repo,
        state: 'all',
        per_page: 50,
        sort: 'updated',
        direction: 'desc',
      });

      for (const pr of prs.data) {
        const updatedAt = pr.updated_at ? new Date(pr.updated_at).toISOString() : undefined;
        if (updatedAt && updatedAt < since) continue;
        const login = pr.user?.login;
        if (!login) continue;
        counts.set(login, (counts.get(login) ?? 0) + 1);
      }
    } catch (err) {
      log.warn('Failed to list PRs for activity signal', { error: (err as Error).message });
    }

    try {
      const commits = await this.octokit.repos.listCommits({
        owner: config.github.owner,
        repo: config.github.repo,
        since,
        per_page: 50,
      });

      for (const c of commits.data) {
        const login = c.author?.login;
        if (!login) continue;
        counts.set(login, (counts.get(login) ?? 0) + 1);
      }
    } catch (err) {
      log.warn('Failed to list commits for activity signal', { error: (err as Error).message });
    }

    return counts;
  }

  /**
   * Search repo history for terms from the issue text and return top logins.
   * Deterministic + cheap compared to full LLM analysis.
   */
  async searchTopContributorsFromText(text: string, limit: number = 5): Promise<string[]> {
    await rateLimiter.acquire();

    const tokens = (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
      .filter(t => !['please', 'help', 'issue', 'error', 'urgent', 'critical', 'refund', 'payment', 'order', 'inventory'].includes(t));

    const queryTerms = [...new Set(tokens)].slice(0, 5);
    if (queryTerms.length === 0) return [];

    const q = `repo:${config.github.owner}/${config.github.repo} ${queryTerms.join(' ')}`;

    try {
      const res = await this.octokit.search.issuesAndPullRequests({
        q,
        sort: 'updated',
        order: 'desc',
        per_page: 50,
      });

      const counts = new Map<string, number>();
      for (const item of res.data.items ?? []) {
        const login = item.user?.login;
        if (!login) continue;
        counts.set(login, (counts.get(login) ?? 0) + 1);
      }

      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([login]) => login);
    } catch (err) {
      log.warn('Repo search failed for contributor inference', { error: (err as Error).message });
      return [];
    }
  }

  /**
   * Find likely assignees by matching the message against existing Project items' titles.
   * Uses only the org Project (no repo history endpoints), so it works even when PR/commit APIs time out.
   */
  async inferAssigneesFromProjectTitles(text: string, limit: number = 3): Promise<Array<{ login: string; score: number; matchedTitle: string }>> {
    const org = config.github.project.org;
    const number = config.github.project.number;
    if (!org || !number) return [];

    await rateLimiter.acquire();

    const normalize = (s: string) =>
      (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(t => !['please', 'track', 'issue', 'error', 'dummy', 'data'].includes(t));

    const qTokens = new Set(normalize(text));
    if (qTokens.size === 0) return [];

    try {
      const query = `query($org: String!, $number: Int!, $cursor: String) {
        organization(login: $org) {
          projectV2(number: $number) {
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                content {
                  __typename
                  ... on Issue {
                    title
                    state
                    assignees(first: 10) { nodes { login } }
                  }
                }
              }
            }
          }
        }
      }`;

      const items: any[] = [];
      let cursor: string | null = null;

      // Fetch up to 300 items (3 pages) to keep latency and rate-limits sane.
      for (let i = 0; i < 3; i++) {
        const resp: any = await this.octokit.graphql<any>(query, { org, number, cursor });
        const page: any = resp?.organization?.projectV2?.items;
        const nodes: any[] = page?.nodes ?? [];
        items.push(...nodes);
        const pi: any = page?.pageInfo;
        if (!pi?.hasNextPage) break;
        cursor = pi.endCursor ?? null;
      }

      const bestByLogin = new Map<string, { score: number; matchedTitle: string }>();

      for (const item of items) {
        const issue = item?.content;
        if (!issue || issue.__typename !== 'Issue') continue;
        if (issue.state !== 'OPEN') continue;
        const title: string = issue.title ?? '';
        if (!title) continue;
        const tTokens = normalize(title);
        if (tTokens.length === 0) continue;

        let overlap = 0;
        for (const t of tTokens) if (qTokens.has(t)) overlap += 1;
        if (overlap === 0) continue;

        const score = overlap / Math.min(8, tTokens.length); // simple normalized overlap
        const assignees: string[] = (issue.assignees?.nodes ?? []).map((n: any) => n.login).filter(Boolean);
        for (const login of assignees) {
          const cur = bestByLogin.get(login);
          if (!cur || score > cur.score) bestByLogin.set(login, { score, matchedTitle: title });
        }
      }

      return [...bestByLogin.entries()]
        .map(([login, v]) => ({ login, score: v.score, matchedTitle: v.matchedTitle }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (err) {
      log.warn('Project title inference failed', { error: (err as Error).message });
      return [];
    }
  }

  // -----------------------------------------------
  // Private helpers
  // -----------------------------------------------

  private buildIssueTitle(message: ParsedSlackMessage): string {
    // Use first 80 chars of message, stripping hashtags for readability
    const clean = message.text
      .replace(/#[\w-]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const prefix = message.priority === 'critical' ? '[CRITICAL] ' :
      message.priority === 'urgent' ? '[URGENT] ' : '';
    return `${prefix}${clean}`.substring(0, 120);
  }

  private buildIssueBody(
    message: ParsedSlackMessage,
    assignment: IssueAssignment,
    issueId: string,
    guidelines: DerivedIssueGuidelines,
    llmSummary?: LlmIssueSummary,
    prdMarkdown?: string
  ): string {
    const slackLink = message.permalink
      ? `[View in Slack](${message.permalink})`
      : `Channel: \`${message.channelName}\``;

    const whatToDo =
      llmSummary?.summary ??
      message.text.replace(/#[\w-]+/g, '').replace(/\s+/g, ' ').trim();

    const tasksSection = llmSummary?.tasks?.length
      ? `\n### What needs to be done\n\n${llmSummary.tasks.map(t => `- [ ] ${t}`).join('\n')}\n`
      : '';

    const llmNotes = llmSummary?.notes?.length
      ? `\n### Notes\n\n${llmSummary.notes.map(n => `- ${n}`).join('\n')}\n`
      : '';

    const checklist = buildGuidelinesChecklistMarkdown(
      guidelines,
      assignment,
      `${config.github.owner}/${config.github.repo}`
    );

    const warningsBlock =
      guidelines.warnings.length > 0
        ? `\n> ⚠️ ${guidelines.warnings.join('\n> ')}\n`
        : '';

    const prdBlock = prdMarkdown
      ? `\n---\n\n## Product Requirements Document (PRD)\n\n${prdMarkdown}\n`
      : '';

    return `## Summary

${whatToDo}

${tasksSection}${llmNotes}${warningsBlock}${prdBlock}
---

### TSS guidelines checklist (auto-applied)

${checklist}

| Project board | ${guidelines.projectName} |
| Project link | ${TSS_PROJECT_URL} |

---

### Source (Slack)

> ${message.text}

${slackLink}

| Reporter | @${message.userName} |
| Tags | ${message.hashtags.map(t => `\`${t}\``).join(' ') || '_none_'} |
| CE-Tech ID | \`${issueId}\` |

---

*Created by MrSoul / CE-Tech Automation. Status updates sync to the Slack thread.*`;
  }

  private buildLabels(message: ParsedSlackMessage, guidelines: DerivedIssueGuidelines): string[] {
    const labels: string[] = [
      'ce-tech-auto',
      PRIORITY_LABELS[message.priority],
      `priority: ${guidelines.priority}`,
    ];

    if (message.isProduction) labels.push('production');

    // Add tag-based labels (clean up #)
    message.hashtags
      .filter(tag => {
        if (/^#(?:effort|sp)-\d+$/.test(tag)) return false;
        if (/^#squad-/.test(tag)) return false;
        if (/^#raised-/.test(tag)) return false;
        if (/^#q[1-4]-\d{4}$/.test(tag)) return false;
        if (/^#(?:parent|epic)-\d+$/.test(tag)) return false;
        if (['#urgent', '#critical', '#high', '#medium', '#low', '#prod', '#p0', '#p1', '#p2', '#p3'].some(p => tag.includes(p))) {
          return false;
        }
        return true;
      })
      .forEach(tag => labels.push(`type: ${tag.replace('#', '')}`));

    return [...new Set(labels)];
  }

  private async applyIssueGuidelines(
    guidelines: DerivedIssueGuidelines,
    issueNodeId: string,
    issueNumber: number
  ): Promise<void> {
    const projectOrg = config.github.project.org;
    const projectNumber = config.github.project.number;
    if (!projectOrg || !projectNumber) {
      log.warn('GitHub project not configured; skipping guideline fields', { issueNumber });
      return;
    }

    await rateLimiter.acquire();

    const { projectId, fieldsByName } = await this.getProjectMetadata(projectOrg, projectNumber);

    const itemId = await this.addIssueToProject(projectId, issueNodeId);

    for (const { field, value } of guidelines.appliedFields) {
      const meta = fieldsByName.get(field);
      if (!meta) {
        log.warn('Project field not found; skipping', { field, issueNumber });
        continue;
      }
      await this.setProjectFieldValue(projectId, itemId, meta, value, issueNumber);
    }

    if (guidelines.parentIssueNumber) {
      await this.linkAsSubIssue(
        config.github.owner,
        config.github.repo,
        guidelines.parentIssueNumber,
        issueNodeId
      ).catch((err: Error) => {
        log.warn('Failed to set parent issue relationship', {
          issueNumber,
          parent: guidelines.parentIssueNumber,
          error: err.message,
        });
      });
    }

    log.info('Applied TSS GitHub guidelines', {
      issueNumber,
      projectOrg,
      projectNumber,
      priority: guidelines.priority,
      effort: guidelines.effort,
    });

    activityFeed.emitActivity({
      level: 'success',
      source: 'github',
      title: `TSS project fields applied · #${issueNumber}`,
      detail: `P${guidelines.priority.replace('P', '')} · effort ${guidelines.effort} · ${guidelines.targetQuarter} · ${guidelines.status}`,
      meta: {
        squad: guidelines.squad,
        raisedBy: guidelines.raisedBy,
        parent: guidelines.parentIssueNumber,
      },
    });
  }

  private async getProjectMetadata(org: string, number: number): Promise<NonNullable<GitHubService['projectCache']>> {
    if (this.projectCache) return this.projectCache;

    const query = `query($org: String!, $number: Int!) {
      organization(login: $org) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
              ... on ProjectV2IterationField { id name }
            }
          }
        }
      }
    }`;

    const resp = await this.octokit.graphql<any>(query, { org, number });
    const project = resp?.organization?.projectV2;
    if (!project?.id) throw new Error(`GitHub project not found: ${org}/projects/${number}`);

    const fieldsByName = new Map<string, { id: string; kind: 'text' | 'date' | 'number' | 'single_select'; options?: Map<string, string> }>();
    const nodes: any[] = project.fields?.nodes ?? [];

    for (const n of nodes) {
      if (!n?.name || !n?.id) continue;
      if (n.__typename === 'ProjectV2SingleSelectField') {
        const options = new Map<string, string>();
        for (const opt of n.options ?? []) {
          if (opt?.name && opt?.id) options.set(opt.name, opt.id);
        }
        fieldsByName.set(n.name, { id: n.id, kind: 'single_select', options });
      } else {
        // We can still set text/number/date without knowing the subtype.
        // GitHub resolves based on the value payload we send.
        fieldsByName.set(n.name, { id: n.id, kind: 'text' });
      }
    }

    this.projectCache = { projectId: project.id, fieldsByName };
    return this.projectCache;
  }

  private async addIssueToProject(projectId: string, contentId: string): Promise<string> {
    const mutation = `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`;
    const resp = await this.octokit.graphql<any>(mutation, { projectId, contentId });
    const itemId = resp?.addProjectV2ItemById?.item?.id;
    if (!itemId) throw new Error('Failed to add issue to project');
    return itemId;
  }

  private async setProjectFieldValue(
    projectId: string,
    itemId: string,
    field: { id: string; kind: 'text' | 'date' | 'number' | 'single_select'; options?: Map<string, string> },
    value: unknown,
    issueNumber: number
  ): Promise<void> {
    const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
        clientMutationId
      }
    }`;

    const buildValue = (): any => {
      if (field.kind === 'single_select') {
        const optionId = field.options?.get(String(value));
        if (!optionId) {
          log.warn('Single-select option not found; skipping', { fieldId: field.id, value, issueNumber });
          return null;
        }
        return { singleSelectOptionId: optionId };
      }

      if (typeof value === 'number') return { number: value };
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
      return { text: String(value) };
    };

    const v = buildValue();
    if (!v) return;

    await this.octokit.graphql<any>(mutation, {
      projectId,
      itemId,
      fieldId: field.id,
      value: v,
    });
  }

  private async linkAsSubIssue(owner: string, repo: string, parentIssueNumber: number, subIssueId: string): Promise<void> {
    // Best-effort: If the GraphQL "addSubIssue" mutation is unavailable for this org/repo,
    // we just skip (guidelines can be satisfied manually or via project).
    const parent = await this.octokit.graphql<any>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) { id }
        }
      }`,
      { owner, repo, number: parentIssueNumber }
    );

    const parentId = parent?.repository?.issue?.id;
    if (!parentId) throw new Error('Parent issue not found');

    const mutation = `mutation($parentId: ID!, $subIssueId: ID!) {
      addSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId }) {
        issue { id }
      }
    }`;

    await this.octokit.graphql<any>(mutation, { parentId, subIssueId });
  }

  /**
   * Create labels that don't exist yet.
   */
  private async ensureLabelsExist(labels: string[]): Promise<void> {
    const labelColors: Record<string, string> = {
      'ce-tech-auto': 'e4e669',
      'priority: critical': 'd73a4a',
      'priority: urgent': 'e99695',
      'priority: high': 'f9d0c4',
      'priority: medium': 'fef2c0',
      'priority: low': 'c2e0c6',
      'production': 'b60205',
    };

    for (const label of labels) {
      try {
        await this.octokit.issues.getLabel({
          owner: config.github.owner,
          repo: config.github.repo,
          name: label,
        });
      } catch {
        // Label doesn't exist — create it
        try {
          await this.octokit.issues.createLabel({
            owner: config.github.owner,
            repo: config.github.repo,
            name: label,
            color: labelColors[label] ?? '0075ca',
          });
          log.info('Created GitHub label', { label });
        } catch (createErr) {
          log.warn('Could not create label (may already exist)', { label });
        }
      }
    }
  }
}

export const githubService = GitHubService.getInstance();
