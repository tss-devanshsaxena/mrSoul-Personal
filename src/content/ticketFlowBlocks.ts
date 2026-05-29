import type { AdkPrd } from '../agents/schemas';

export const TICKET_FLOW_ACTION_APPROVE = 'ticket_flow_approve';
export const TICKET_FLOW_ACTION_REJECT = 'ticket_flow_reject';
export const CREATE_TICKET_MODAL_CALLBACK = 'create_ticket_modal';

export function buildProblemReviewBlocks(opts: {
  sessionId: string;
  title: string;
  summary: string;
  keyQuestions?: string[];
  suggestedScope?: string;
}): Record<string, unknown>[] {
  const questions =
    opts.keyQuestions?.length ?
      `\n*Questions to clarify*\n${opts.keyQuestions.map(q => `• ${q}`).join('\n')}`
    : '';
  const scope = opts.suggestedScope ? `\n*Suggested scope*\n${opts.suggestedScope}` : '';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Create ticket — review problem', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${opts.title}*\n\n${opts.summary}${scope}${questions}\n\n` +
          '_Reply in this thread with feedback, or use the buttons below._',
      },
    },
    {
      type: 'actions',
      block_id: `ticket_review_${opts.sessionId}`,
      elements: [
        {
          type: 'button',
          action_id: TICKET_FLOW_ACTION_APPROVE,
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          value: opts.sessionId,
        },
        {
          type: 'button',
          action_id: TICKET_FLOW_ACTION_REJECT,
          text: { type: 'plain_text', text: 'Reject', emoji: true },
          style: 'danger',
          value: opts.sessionId,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            '• *Approve* (or reply `approve`) → AI drafts PRD and uploads `.docx` here\n' +
            '• *Reject* (or reply `reject`) → cancel this ticket\n' +
            '• *Comment* in thread → AI revises the problem summary\n' +
            '• When PRD looks good: `Good to go raise this ticket to: <developer name>`',
        },
      ],
    },
  ];
}

export function buildPrdReadyBlocks(opts: {
  sessionId: string;
  prdTitle: string;
}): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*PRD ready for review:* ${opts.prdTitle}\n\n` +
          'The `.docx` file is attached above in this thread.\n\n' +
          'When you are satisfied, reply:\n' +
          '`Good to go raise this ticket to: <name or tss-github-login>`',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Session \`${opts.sessionId}\` · Powered by Groq + MrSoul`,
        },
      ],
    },
  ];
}

export function buildTicketCompletedBlocks(opts: {
  githubUrl: string;
  issueNumber: number;
  assigneeName: string;
  githubLogin: string;
  prdTitle: string;
  prdDocUrl?: string;
}): Record<string, unknown>[] {
  const prdLine = opts.prdDocUrl
    ? `*PRD:* <${opts.prdDocUrl}|${opts.prdTitle}.docx> + markdown in issue`
    : `*PRD:* ${opts.prdTitle} (in issue body, comment, and .docx in repo \`docs/prds/\`)`;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Ticket raised on GitHub', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*GitHub issue:* <${opts.githubUrl}|#${opts.issueNumber}>\n` +
          `*Assignee:* ${opts.assigneeName} (\`@${opts.githubLogin}\`)\n` +
          `${prdLine}\n\n` +
          '_TSS project fields were applied per issue guidelines._',
      },
    },
  ];
}

export function formatProblemReviewPlain(opts: {
  title: string;
  summary: string;
  keyQuestions?: string[];
}): string {
  const qs = opts.keyQuestions?.length
    ? `\n\nQuestions:\n${opts.keyQuestions.map(q => `- ${q}`).join('\n')}`
    : '';
  return `**${opts.title}**\n\n${opts.summary}${qs}`;
}

export function prdSummaryForSlack(prd: AdkPrd): string {
  return `*${prd.title}*\n${prd.problemStatement.slice(0, 400)}${prd.problemStatement.length > 400 ? '…' : ''}`;
}
