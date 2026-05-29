// copy-kit.ts — MrSoul channel copy & Block Kit

import { ISSUE_CREATION_HASHTAGS_HELP } from './tssIssueGuidelines';

// ─── Credits & Meta ───────────────────────────────────────────────────────────

export const MRSOUL_CREDIT = '';
export const MRSOUL_PIN_MARKER = 'mrsoul-guidelines-v1';

// ─── Channel Config ───────────────────────────────────────────────────────────

export const MRSOUL_CHANNEL_TOPIC =
  '📌 @MrSoul: dev workload, ownership & GitHub issues. Type /mrsoul for guide.';

export const MRSOUL_CHANNEL_PURPOSE =
  'CE-Tech intake via @MrSoul — check workload, find owners, create GitHub issues on the TSS roadmap.';

export const MRSOUL_CHANNEL_DESCRIPTION =
  `CE-Tech engineering intake (The Souled Store)

@MrSoul lets you:
- Check what a developer is currently working on
- Get a team-wide workload overview
- Find the right owner for a new task
- Create tracked GitHub issues in thesouledstore-tss/roadmap

Type /mrsoul or @MrSoul help to get started.`;

export const MRSOUL_SLASH_DESCRIPTION =
  'CE-Tech advisor: workload, task ownership & GitHub issue creation';

// ─── Suggested Prompts ────────────────────────────────────────────────────────

export const MRSOUL_PROMPTS = [
  { id: 'advisor_roster', label: 'Who is working on what?',   message: 'who is working on what' },
  { id: 'advisor_dev',    label: 'What is [dev] working on?', message: 'what is tss-akritiraj working on' },
  { id: 'advisor_task',   label: 'Who should own this task?', message: 'who should work on ' },
  { id: 'advisor_create', label: 'Create a GitHub issue',     message: 'create issue ' },
] as const;

/** @deprecated Use MRSOUL_PROMPTS — kept for existing imports */
export const MRSOUL_SUGGESTED_PROMPTS = MRSOUL_PROMPTS;

// ─── Guidelines Text ─────────────────────────────────────────────────────────

export function buildGuidelinesMrkdwn(): string {
  return `
${MRSOUL_CREDIT}

*What it does*
Connects to the TSS Product & Tech Master GitHub Project to surface workload, suggest owners, and create tracked issues — all from Slack.

*Commands*

*1. Check a developer's workload*
\`@MrSoul what is tss-vishwasbellani working on?\`
\`@MrSoul what is Akriti working on?\`

*2. Team overview*
\`@MrSoul who is working on what?\`

*3. Find the right owner for a task*
\`@MrSoul who should work on size chart excel upload?\`

*4. Create a GitHub issue (TSS guidelines enforced)*
\`@MrSoul create issue <clear description — what & what to do>\`
Or: \`Payment timeout on checkout #payment #effort-5 #squad-backend #raised-tech\`
Thread: reply \`create issue …\` in the same thread (no @ needed)

*Live updates in Slack:* MrSoul posts a *live pipeline* message in the thread (triage → GitHub → PRD → tracking). No browser dashboard needed.

*5. PRD + Claude (parallel to issues)*
Every issue also gets a *PRD draft* in-thread when \`PRD_ENABLED=true\`.
PRD only: \`@MrSoul #prd <describe the feature>\`
If Claude for Slack is in the channel, set \`SLACK_CLAUDE_BOT_USER_ID\` — MrSoul will @Claude with a refinement prompt after the PRD.

*Auto-filled on TSS Product & Tech Master:* assignee, project, P0–P3, Fibonacci effort, squad, raised-by, start/target dates, status Todo, description, optional parent epic.

*Issue hashtags*
${ISSUE_CREATION_HASHTAGS_HELP.map(h => `- ${h}`).join('\n')}

*Tips*
- Use full GitHub login (\`tss-username\`) if a name isn't found
- Configure real owners: \`PUT /api/routing\` (no dummy names)
- \`/mrsoul\` — this guide (ephemeral)`;
}

// ─── Block Kit ────────────────────────────────────────────────────────────────

export function buildGuidelinesBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: buildGuidelinesMrkdwn() },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_${MRSOUL_PIN_MARKER} · Repo: thesouledstore-tss/roadmap · Project #1_`,
        },
      ],
    },
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatBotPrompt(botUserId: string | undefined, prompt: string): string {
  const mention = botUserId ? `<@${botUserId}>` : '@MrSoul';
  const text = prompt.trim();
  if (!text) return `${mention} help`;
  if (text.startsWith('<@')) return text;
  return `${mention} ${text}`;
}