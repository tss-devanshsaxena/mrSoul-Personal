import { slackIntentSchema, issueSummarySchema } from '../src/agents/schemas';

jest.mock('../src/services/adkService', () => ({
  adkService: {
    isEnabled: jest.fn(() => false),
    classifyIntent: jest.fn(),
    summarizeIssue: jest.fn(),
    enrichTaskSuggestion: jest.fn(),
    runAdvisorQuery: jest.fn(),
  },
}));

describe('ADK schemas', () => {
  it('validates slack intent shape', () => {
    const parsed = slackIntentSchema.safeParse({
      kind: 'developer_workload',
      developerQuery: 'Akriti',
      confidence: 0.9,
    });
    expect(parsed.success).toBe(true);
  });

  it('validates issue summary shape', () => {
    const parsed = issueSummarySchema.safeParse({
      summary: 'Refund API returns 500',
      tasks: ['Check logs', 'Add retry', 'Notify payments'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid intent confidence', () => {
    const parsed = slackIntentSchema.safeParse({
      kind: 'help',
      confidence: 1.5,
    });
    expect(parsed.success).toBe(false);
  });
});
