import { config } from '../config';
import {
  FIBONACCI_EFFORTS,
  RAISED_BY_OPTIONS,
  SQUAD_OPTIONS,
  TSS_PROJECT_NAME,
} from '../content/tssIssueGuidelines';
import { IssueAssignment, ParsedSlackMessage, Priority } from '../types';
import { routingService } from './routing';

export type GuidelinePriority = 'P0' | 'P1' | 'P2' | 'P3';
export type FibonacciEffort = (typeof FIBONACCI_EFFORTS)[number];

export interface DerivedIssueGuidelines {
  priority: GuidelinePriority;
  effort: FibonacciEffort;
  targetQuarter: string;
  squad: string;
  raisedBy: string;
  startDate: string;
  targetDate: string;
  status: 'Todo';
  parentIssueNumber?: number;
  projectName: string;
  warnings: string[];
  /** Fields auto-set on the GitHub project board */
  appliedFields: Array<{ field: string; value: string }>;
}

const SQUAD_BY_TAG: Record<string, string> = {
  'frontend-web': 'Frontend Web',
  'frontend-mobile': 'Frontend Mobile',
  'backend-python': 'Backend Python',
  backend: 'Backend',
  data: 'Data',
  devops: 'DevOps',
};

const RAISED_BY_TAG: Record<string, string> = {
  tech: 'Tech',
  marketing: 'Marketing',
  finance: 'Finance',
  cx: 'Customer Experience',
  'customer-experience': 'Customer Experience',
  retail: 'Retail',
};

const MIN_DESCRIPTION_CHARS = 12;

/** Priority / environment hashtags — not domain routing. */
const META_HASHTAG =
  /^#(?:p\d|critical|urgent|high|medium|low|prod|production|live|outage|incident|asap|blocker|important|minor|enhancement|feature|sev\d|down|prd)$/;

/** TSS field hashtags (#effort-5, #squad-backend, …) are not routing tags. */
export function isMetadataHashtag(tag: string): boolean {
  const t = tag.toLowerCase();
  if (META_HASHTAG.test(t)) return true;
  if (/^#(?:effort|sp)-\d+$/.test(t)) return true;
  if (/^#squad-/.test(t)) return true;
  if (/^#raised-/.test(t)) return true;
  if (/^#q[1-4]-\d{4}$/.test(t)) return true;
  if (/^#(?:parent|epic)-\d+$/.test(t)) return true;
  return false;
}

export function domainRoutingHashtags(message: ParsedSlackMessage): string[] {
  return message.hashtags.filter(t => !isMetadataHashtag(t));
}

/**
 * Human-readable assignee errors for Slack (routing, @mention, fallback).
 */
export async function buildAssigneeValidationErrors(
  message: ParsedSlackMessage,
  assignment: IssueAssignment
): Promise<string[]> {
  if (assignment.githubUsername?.trim()) return [];

  const errors: string[] = [];
  const domainTags = domainRoutingHashtags(message);

  for (const tag of domainTags) {
    const status = await routingService.getTagRoutingStatus(tag);
    if (status === 'inactive') {
      errors.push(
        `\`${tag}\` had an old *test* mapping that was removed. Add a real owner: \`PUT /api/routing\` with Slack user ID + \`tss-*\` GitHub login.`
      );
    } else if (status === 'missing') {
      errors.push(
        `No routing configured for \`${tag}\`. Add mapping via \`PUT /api/routing\` or @mention the assignee in your message.`
      );
    }
  }

  if (errors.length === 0) {
    const hints: string[] = [
      '@mention the GitHub collaborator in Slack (`<@U…>`)',
      'Add hashtag → owner via `PUT /api/routing`',
    ];
    if (!config.github.fallbackAssignee) {
      hints.push('Set `GITHUB_FALLBACK_ASSIGNEE` in `.env` to a real `tss-*` collaborator on the roadmap repo');
    }
    errors.push(`*Assignee required (TSS guidelines).* ${hints.join(' · ')}`);
  }

  return errors;
}

function mapPriority(p: Priority): GuidelinePriority {
  switch (p) {
    case 'critical':
      return 'P0';
    case 'urgent':
    case 'high':
      return 'P1';
    case 'medium':
      return 'P2';
    case 'low':
      return 'P3';
  }
}

function parseEffortFromHashtags(hashtags: string[]): FibonacciEffort | undefined {
  for (const tag of hashtags) {
    const m = tag.match(/^#(?:effort|sp)-(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (FIBONACCI_EFFORTS.includes(n as FibonacciEffort)) return n as FibonacciEffort;
    if (n === 21) return 13;
  }
  return undefined;
}

function parseQuarterFromHashtags(hashtags: string[]): string | undefined {
  for (const tag of hashtags) {
    const m = tag.match(/^#q([1-4])-(\d{4})$/);
    if (m) return `Q${m[1]} ${m[2]}`;
  }
  return undefined;
}

function parseSquadFromHashtags(hashtags: string[]): string | undefined {
  for (const tag of hashtags) {
    const slug = tag.replace(/^#squad-/, '');
    if (slug === tag) continue;
    const mapped = SQUAD_BY_TAG[slug];
    if (mapped) return mapped;
  }
  return undefined;
}

function parseRaisedByFromHashtags(hashtags: string[]): string | undefined {
  for (const tag of hashtags) {
    const slug = tag.replace(/^#raised-/, '');
    if (slug === tag) continue;
    const mapped = RAISED_BY_TAG[slug];
    if (mapped) return mapped;
  }
  return undefined;
}

function parseParentFromHashtags(hashtags: string[]): number | undefined {
  for (const tag of hashtags) {
    const m = tag.match(/^#(?:parent|epic)-(\d+)$/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function computeTargetQuarter(date: Date): string {
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `Q${quarter} ${year}`;
}

function targetDaysForEffort(effort: FibonacciEffort): number {
  const map: Record<FibonacciEffort, number> = {
    1: 2,
    2: 3,
    3: 5,
    5: 10,
    8: 14,
    13: 21,
  };
  return map[effort];
}

function descriptionText(message: ParsedSlackMessage): string {
  return message.text
    .replace(/#[\w-]+/g, '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive TSS mandatory project fields + metadata from Slack message and config.
 */
export function deriveIssueGuidelines(message: ParsedSlackMessage): DerivedIssueGuidelines {
  const warnings: string[] = [];
  const defaultEffort = config.github.project.defaultEffort as FibonacciEffort;

  let effort = parseEffortFromHashtags(message.hashtags) ?? defaultEffort;
  if (message.hashtags.some(t => /^#(?:effort|sp)-21$/.test(t))) {
    effort = 13;
    warnings.push('Effort 21 is not allowed — set to **13**. Break this into smaller child issues per TSS guidelines.');
  }
  if (effort >= 13) {
    warnings.push('Effort is **13+** — consider splitting into smaller child issues linked to a parent epic.');
  }

  const startDate = new Date();
  const targetDate = new Date(
    Date.now() + targetDaysForEffort(effort) * 24 * 60 * 60 * 1000
  );

  const parentIssueNumber =
    parseParentFromHashtags(message.hashtags) ?? config.github.project.parentIssueNumber;

  const priority = mapPriority(message.priority);
  const targetQuarter =
    parseQuarterFromHashtags(message.hashtags) ??
    config.github.project.targetQuarter?.trim() ??
    computeTargetQuarter(targetDate);

  const squad = parseSquadFromHashtags(message.hashtags) ?? config.github.project.defaultSquad;
  const raisedBy =
    parseRaisedByFromHashtags(message.hashtags) ?? config.github.project.defaultRaisedBy;

  const appliedFields: DerivedIssueGuidelines['appliedFields'] = [
    { field: 'Priority', value: priority },
    { field: 'Effort / Complexity', value: String(effort) },
    { field: 'Target Quarter', value: targetQuarter },
    { field: 'Start Date', value: startDate.toISOString().slice(0, 10) },
    { field: 'Target Date', value: targetDate.toISOString().slice(0, 10) },
    { field: 'Squad', value: squad },
    { field: 'Raised By', value: raisedBy },
    { field: 'Status', value: 'Todo' },
  ];

  return {
    priority,
    effort,
    targetQuarter,
    squad,
    raisedBy,
    startDate: startDate.toISOString().slice(0, 10),
    targetDate: targetDate.toISOString().slice(0, 10),
    status: 'Todo',
    parentIssueNumber,
    projectName: TSS_PROJECT_NAME,
    warnings,
    appliedFields,
  };
}

export interface IssueCreationValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate TSS mandatory rules before creating a GitHub issue.
 */
export async function validateIssueCreation(
  message: ParsedSlackMessage,
  assignment: IssueAssignment,
  guidelines: DerivedIssueGuidelines
): Promise<IssueCreationValidation> {
  const errors: string[] = [];
  const warnings = [...guidelines.warnings];

  if (!assignment.githubUsername?.trim()) {
    errors.push(...(await buildAssigneeValidationErrors(message, assignment)));
  }

  const desc = descriptionText(message);
  if (desc.length < MIN_DESCRIPTION_CHARS) {
    errors.push(
      `Description is required (min ${MIN_DESCRIPTION_CHARS} characters after hashtags). Explain *what* the issue is and *what needs to be done*.`
    );
  }

  const titleCandidate = desc.slice(0, 80);
  if (/^(fix bug|bug|api issue|fix stuff|improve system)$/i.test(titleCandidate.trim())) {
    errors.push('Title/description is too vague. Use a specific title a new developer can understand without context.');
  }

  if (!config.github.project.org || !config.github.project.number) {
    warnings.push(
      'GitHub project not configured (`GITHUB_PROJECT_ORG` / `GITHUB_PROJECT_NUMBER`) — board fields will not be set automatically.'
    );
  }

  if (!guidelines.parentIssueNumber) {
    warnings.push(
      'No parent epic linked. Add `#parent-<issueNumber>` or set `GITHUB_PARENT_ISSUE_NUMBER` if this belongs under an epic.'
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function buildGuidelinesChecklistMarkdown(
  guidelines: DerivedIssueGuidelines,
  assignment: IssueAssignment,
  repo: string
): string {
  const checks = [
    ['Assignee', assignment.githubUsername ? `@${assignment.githubUsername}` : '—'],
    ['Project', guidelines.projectName],
    ['Repository', repo],
    ['Target Quarter', guidelines.targetQuarter],
    ['Effort (Fibonacci)', String(guidelines.effort)],
    ['Priority', guidelines.priority],
    ['Start Date', guidelines.startDate],
    ['Target Date', guidelines.targetDate],
    ['Squad', guidelines.squad],
    ['Raised By', guidelines.raisedBy],
    ['Status', guidelines.status],
    ['Parent issue', guidelines.parentIssueNumber ? `#${guidelines.parentIssueNumber}` : '_not set_'],
  ];

  return checks.map(([k, v]) => `- [x] **${k}:** ${v}`).join('\n');
}

export { SQUAD_OPTIONS, RAISED_BY_OPTIONS, FIBONACCI_EFFORTS };
