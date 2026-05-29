import { Priority, ParsedSlackMessage } from '../types';

// Priority keywords mapping
const PRIORITY_KEYWORDS: Record<Priority, string[]> = {
  critical: ['#critical', '#p0', '#sev0', '#down', '#outage', '#incident'],
  urgent: ['#urgent', '#p1', '#sev1', '#asap', '#blocker'],
  high: ['#high', '#p2', '#sev2', '#important'],
  medium: ['#medium', '#p3', '#sev3'],
  low: ['#low', '#p4', '#minor', '#enhancement', '#feature'],
};

const PRODUCTION_KEYWORDS = [
  '#prod', '#production', '#live', '#outage', '#down', '#critical', '#incident',
];

/**
 * Extract all hashtags from a Slack message text.
 * Handles Slack's encoding of special characters.
 */
export function extractHashtags(text: string): string[] {
  // Normalize Slack's smart quotes and special chars
  const normalized = text
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  // Match hashtags: # followed by word characters
  const matches = normalized.match(/#[\w-]+/g) ?? [];
  return [...new Set(matches.map(tag => tag.toLowerCase()))];
}

/**
 * Determine priority from detected hashtags.
 * Returns highest priority found (critical > urgent > high > medium > low).
 */
export function determinePriority(hashtags: string[]): Priority {
  const priorityOrder: Priority[] = ['critical', 'urgent', 'high', 'medium', 'low'];

  for (const priority of priorityOrder) {
    const keywords = PRIORITY_KEYWORDS[priority];
    if (hashtags.some(tag => keywords.includes(tag))) {
      return priority;
    }
  }

  return 'medium'; // default
}

/**
 * Check if message references production systems.
 */
export function isProductionRelated(hashtags: string[]): boolean {
  return hashtags.some(tag => PRODUCTION_KEYWORDS.includes(tag));
}

/**
 * Check if message appears to be a priority/urgent issue.
 */
export function isPriorityIssue(priority: Priority): boolean {
  return ['critical', 'urgent'].includes(priority);
}

/**
 * Parse a raw Slack message event into structured format.
 */
export function parseSlackMessage(
  text: string,
  messageTs: string,
  channelId: string,
  channelName: string,
  userId: string,
  userName: string,
  teamId: string,
  permalink?: string,
  threadTs?: string
): ParsedSlackMessage {
  const hashtags = extractHashtags(text);
  const priority = determinePriority(hashtags);

  return {
    messageTs,
    threadTs,
    channelId,
    channelName,
    userId,
    userName,
    text: text.trim(),
    hashtags,
    priority,
    isPriority: isPriorityIssue(priority),
    isProduction: isProductionRelated(hashtags),
    teamId,
    permalink,
  };
}

/**
 * Strip Slack user mentions and channel refs for cleaner display.
 */
export function cleanSlackText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, '[user]')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Format priority for display.
 */
export function formatPriority(priority: Priority): string {
  const emoji: Record<Priority, string> = {
    critical: '🔴',
    urgent: '🟠',
    high: '🟡',
    medium: '🔵',
    low: '⚪',
  };
  return `${emoji[priority]} ${priority.toUpperCase()}`;
}

/**
 * Format status for display.
 */
export function formatStatus(status: string): string {
  const map: Record<string, string> = {
    open: '🆕 Open',
    in_progress: '🔄 In Progress',
    pr_opened: '🔃 PR Opened',
    pr_merged: '✅ PR Merged',
    closed: '🔒 Closed',
    resolved: '✔️ Resolved',
  };
  return map[status] ?? status;
}
