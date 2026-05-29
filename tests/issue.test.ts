/**
 * Tests for IssueService business logic
 * Uses mocked dependencies — no real DB/Slack/GitHub calls
 */

import { parseSlackMessage } from '../src/utils/messageParser';

// Mock all external dependencies
jest.mock('../src/models', () => ({
  Issue: {
    create: jest.fn(),
    findById: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
    aggregate: jest.fn(),
    findOne: jest.fn(),
  },
  DedupeCache: {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../src/services/routing', () => ({
  routingService: {
    resolveAssignment: jest.fn().mockResolvedValue({
      primaryOwnerId: 'U001',
      primaryOwnerName: 'Rahul',
      secondaryOwnerIds: [],
      githubUsername: 'rahul',
      resolvedFromTags: ['#refund'],
    }),
  },
}));

jest.mock('../src/services/github', () => ({
  githubService: {
    createIssue: jest.fn().mockResolvedValue({
      issueNumber: 42,
      issueUrl: 'https://github.com/org/repo/issues/42',
      issueTitle: 'Refund failing',
      nodeId: 'I_abc123',
    }),
  },
}));

jest.mock('../src/services/slack', () => ({
  slackService: {
    createTrackingThread: jest.fn().mockResolvedValue({
      channelId: 'C001',
      threadTs: '1705312201.654321',
    }),
    postThreadUpdate: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../src/services/tracker', () => ({
  workloadTracker: {
    trackIssue: jest.fn().mockResolvedValue(undefined),
    getWorkloadSummary: jest.fn().mockResolvedValue([]),
  },
}));

describe('IssueService — message processing', () => {
  const makeMessage = (text: string) =>
    parseSlackMessage(
      text,
      '1705312200.123456',
      'C001',
      'ce-tech-issues',
      'U999',
      'Test User',
      'T001'
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('parses urgent refund message correctly', () => {
    const msg = makeMessage('Refund failing after payment success #refund #urgent');
    expect(msg.hashtags).toContain('#refund');
    expect(msg.hashtags).toContain('#urgent');
    expect(msg.priority).toBe('urgent');
    expect(msg.isPriority).toBe(true);
    expect(msg.channelId).toBe('C001');
    expect(msg.userId).toBe('U999');
  });

  it('parses critical production message', () => {
    const msg = makeMessage('API is down #payment #critical #prod');
    expect(msg.priority).toBe('critical');
    expect(msg.isProduction).toBe(true);
    expect(msg.hashtags).toContain('#payment');
  });

  it('parses low priority feature request', () => {
    const msg = makeMessage('Would be nice to have export #inventory #low #feature');
    expect(msg.priority).toBe('low');
    expect(msg.isPriority).toBe(false);
    expect(msg.isProduction).toBe(false);
  });

  it('handles message with no recognized routing tags', () => {
    const msg = makeMessage('Something weird happened #unknown-tag');
    expect(msg.hashtags).toContain('#unknown-tag');
    expect(msg.priority).toBe('medium'); // default
  });

  it('extracts correct messageTs for deduplication key', () => {
    const ts = '1705312200.123456';
    const msg = parseSlackMessage('test #order', ts, 'C001', 'test', 'U001', 'user', 'T001');
    expect(msg.messageTs).toBe(ts);
    expect(msg.channelId).toBe('C001');
  });
});

describe('Routing service integration', () => {
  it('resolves assignment correctly for #refund', async () => {
    const { routingService } = require('../src/services/routing');
    const msg = parseSlackMessage('Refund error #refund', '123', 'C001', 'ch', 'U001', 'user', 'T001');
    const assignment = await routingService.resolveAssignment(msg);

    expect(assignment.primaryOwnerName).toBe('Rahul');
    expect(assignment.githubUsername).toBe('rahul');
    expect(assignment.resolvedFromTags).toContain('#refund');
  });
});

describe('GitHub service integration', () => {
  it('creates GitHub issue with correct data', async () => {
    const { githubService } = require('../src/services/github');
    const msg = parseSlackMessage('Refund error #refund #urgent', '123', 'C001', 'issues', 'U001', 'Rahul', 'T001');

    const assignment = {
      primaryOwnerId: 'U001',
      primaryOwnerName: 'Rahul',
      secondaryOwnerIds: [],
      githubUsername: 'rahul',
      resolvedFromTags: ['#refund'],
    };

    const result = await githubService.createIssue(msg, assignment, 'issue-uuid-123');

    expect(result.issueNumber).toBe(42);
    expect(result.issueUrl).toContain('github.com');
    expect(result.issueTitle).toBe('Refund failing');
  });
});

describe('Slack service integration', () => {
  it('creates tracking thread with correct params', async () => {
    const { slackService } = require('../src/services/slack');
    const msg = parseSlackMessage('Refund error #refund', '123', 'C001', 'issues', 'U001', 'Rahul', 'T001');

    const assignment = {
      primaryOwnerId: 'U001',
      primaryOwnerName: 'Rahul',
      secondaryOwnerIds: [],
      githubUsername: 'rahul',
      resolvedFromTags: ['#refund'],
    };

    const thread = await slackService.createTrackingThread(msg, assignment, 'issue-uuid-123');

    expect(thread.channelId).toBe('C001');
    expect(thread.threadTs).toBeTruthy();
  });
});
