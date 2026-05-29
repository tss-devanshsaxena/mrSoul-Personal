/**
 * Slack Block Kit for failed issue creation (actionable for users).
 */
export function buildIssueCreationErrorBlocks(errorMessage: string): Record<string, unknown>[] {
  const needsRouting =
    errorMessage.includes('routing') ||
    errorMessage.includes('test* mapping') ||
    errorMessage.includes('Assignee required');

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Could not create GitHub issue', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: errorMessage.slice(0, 2900),
      },
    },
  ];

  if (needsRouting) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Fix assignee (pick one):*\n' +
          '• @mention the owner in your message (`<@U…>`)\n' +
          '• Register `#payment` (etc.): `PUT /api/routing` with real Slack user ID + `tss-*` GitHub login\n' +
          '• Or set `GITHUB_FALLBACK_ASSIGNEE` in `.env` to a collaborator on the roadmap repo\n\n' +
          '`#effort-5`, `#squad-*`, `#raised-*`, `#q2-2026` do *not* need routing — only domain tags like `#payment`.',
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '_TSS requires assignee + clear description. Post again with fixes or `create issue …` in a thread._',
      },
    ],
  });

  return blocks;
}
