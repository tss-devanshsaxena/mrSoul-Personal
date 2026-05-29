export type SlackIntent =
  | { kind: 'create_issue' }
  | { kind: 'developer_workload'; developerQuery: string }
  | { kind: 'team_roster' }
  | { kind: 'task_suggestion'; taskDescription: string }
  | { kind: 'help' };

/**
 * Strip Slack markup (mentions, links) for intent matching.
 */
export function stripSlackMarkup(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, ' ')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify an @bot message (hashtags handled separately by the caller).
 */
/** True when user wants to file an issue (including thread follow-ups like "create issue …"). */
/** User wants a PRD draft (#prd or explicit wording). */
export function wantsPrd(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /#prd\b/.test(lower) ||
    /\b(product requirements|write a prd|create prd|prd draft)\b/.test(lower)
  );
}

export function wantsCreateIssue(text: string, hasHashtags: boolean): boolean {
  return hasHashtags || /\bcreate\s+(an?\s+)?issue\b/i.test(stripSlackMarkup(text));
}

/**
 * Body after `create issue` (or null if keyword only / not a create command).
 */
export function extractCreateIssueBody(text: string): string | null {
  const stripped = stripSlackMarkup(text);
  if (!/\bcreate\s+(an?\s+)?issue\b/i.test(stripped)) return null;
  const m = stripped.match(/^\s*create\s+(?:an?\s+)?issue\s*:?\s*(.*)$/i);
  if (m) return m[1].trim();
  return '';
}

/** work / woking / working — tolerate common typos */
const WORK_VERB =
  '(?:work(?:ing)?|wok(?:ing)?|wrk(?:ing)?|working on|work on|woking on|wok on)';

function cleanDeveloperQuery(raw: string): string | null {
  const q = raw
    .replace(/^(the|dev|developer)\s+/i, '')
    .replace(/\s+is\s*$/i, '')
    .trim();
  if (q.length < 2 || /^(everyone|team|all|who|someone|anybody)$/i.test(q)) {
    return null;
  }
  return q;
}

/**
 * Pull developer name/login from natural questions (with or without @bot).
 */
export function extractDeveloperWorkloadQuery(text: string): string | null {
  const t = stripSlackMarkup(text).trim();
  if (!t) return null;

  const patterns = [
    new RegExp(`what(?:'s|s| is)\\s+(.+?)\\s+(?:is\\s+)?${WORK_VERB}`, 'i'),
    /what(?:'s|s| is)\s+(.+?)\s+(?:up on|up to)\b/i,
    /(?:show|list|get)\s+(.+?)(?:'s| is)?\s+(?:workload|tasks|commitments)\b/i,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    const q = cleanDeveloperQuery(m[1]);
    if (q) return q;
  }

  return null;
}

/** True when message is asking what someone is working on (not who-should-own-a-task). */
export function isDeveloperWorkloadQuestion(text: string): boolean {
  return extractDeveloperWorkloadQuery(text) !== null;
}

export function parseSlackIntent(text: string, opts: { hasHashtags: boolean }): SlackIntent {
  if (wantsCreateIssue(text, opts.hasHashtags)) {
    return { kind: 'create_issue' };
  }

  const t = stripSlackMarkup(text).toLowerCase();
  if (!t || /^(help|commands|\?)$/i.test(t)) {
    return { kind: 'help' };
  }

  const devQuery = extractDeveloperWorkloadQuery(text);
  if (devQuery) {
    return { kind: 'developer_workload', developerQuery: devQuery };
  }

  const task =
    t.match(/\bwho should\s+(?:take|own|handle|work on|pick up)\s+(.+)/i) ??
    t.match(/\bi have a task\s+(?:for|about|:)\s+(.+)/i) ??
    t.match(/\bbest\s+(?:person|developer|owner)\s+for\s+(.+)/i) ??
    t.match(/\bassign\s+(?:this|it)?\s*(?:to|for)?\s*(.+)/i) ??
    t.match(/\bwho can\s+(?:work on|handle|take)\s+(.+)/i);

  if (task?.[1]) {
    return { kind: 'task_suggestion', taskDescription: task[1].trim() };
  }

  if (
    /\bwho should\b/i.test(t) ||
    /\bwho can\b/i.test(t) ||
    /\bwho would\b/i.test(t) ||
    /\bsuggest\s+(?:a\s+)?(?:owner|assignee|developer)\b/i.test(t) ||
    /\bneed someone for\b/i.test(t)
  ) {
    return { kind: 'task_suggestion', taskDescription: stripSlackMarkup(text) };
  }

  if (
    /\bwho(?:'s| is)?\s+working on\b/i.test(t) ||
    /\bwho has what\b/i.test(t) ||
    /\bteam\s+(?:status|workload|overview)\b/i.test(t) ||
    /\beveryone(?:'s)?\s+work\b/i.test(t) ||
    /\bwhat is everyone\b/i.test(t)
  ) {
    return { kind: 'team_roster' };
  }

  // Default @bot chat → task / ownership suggestion (not "what is X working on")
  return { kind: 'task_suggestion', taskDescription: stripSlackMarkup(text) };
}
