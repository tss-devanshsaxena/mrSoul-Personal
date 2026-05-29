/**
 * API Integration Tests
 * These tests spin up the Express app against an in-memory MongoDB.
 * No real Slack/GitHub calls are made — services are mocked.
 */

import request from 'supertest';
import { createExpressApp } from '../src/app';
import { Application } from 'express';

// Mock services that make external calls
jest.mock('../src/services/issue', () => ({
  issueService: {
    listIssues: jest.fn().mockResolvedValue({ issues: [], total: 0 }),
    getIssue: jest.fn().mockResolvedValue(null),
    updateIssueStatus: jest.fn().mockResolvedValue(undefined),
    handleGitHubPREvent: jest.fn().mockResolvedValue(undefined),
    handleGitHubIssueClosed: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../src/services/routing', () => ({
  routingService: {
    getAllMappings: jest.fn().mockResolvedValue(new Map([
      ['#refund', { tag: '#refund', primaryOwner: 'U001', primaryOwnerName: 'Rahul', secondaryOwners: [], githubUsername: 'rahul', active: true }],
    ])),
    upsertMapping: jest.fn().mockResolvedValue(undefined),
    invalidateCache: jest.fn(),
  },
}));

jest.mock('../src/services/tracker', () => ({
  workloadTracker: {
    getWorkloadSummary: jest.fn().mockResolvedValue([
      { developerId: 'U001', developerName: 'Rahul', openIssues: 3, inProgressIssues: 1, resolvedThisWeek: 2, totalAssigned: 10 },
    ]),
  },
}));

jest.mock('../src/services/github', () => ({
  githubService: {
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
  },
}));

jest.mock('../src/services/database', () => ({
  db: { connect: jest.fn(), disconnect: jest.fn(), isConnected: jest.fn().mockReturnValue(true) },
}));

let app: Application;

beforeAll(() => {
  app = createExpressApp();
});

afterAll(async () => {
  // Allow any setImmediate callbacks to flush
  await new Promise(resolve => setTimeout(resolve, 100));
});

// ============================================================
// Health endpoints
// ============================================================
describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('ce-tech-automation');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });
});

describe('GET /health/detailed', () => {
  it('returns memory and service info', async () => {
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('services');
    expect(res.body).toHaveProperty('memory');
    expect(res.body).toHaveProperty('node');
  });
});

// ============================================================
// Issues API
// ============================================================
describe('GET /api/issues', () => {
  it('returns 200 with paginated result', async () => {
    const res = await request(app).get('/api/issues');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('issues');
    expect(res.body.data).toHaveProperty('total');
  });

  it('accepts valid query params', async () => {
    const res = await request(app).get('/api/issues?status=open&priority=urgent&limit=10&offset=0');
    expect(res.status).toBe(200);
  });

  it('rejects invalid status param', async () => {
    const res = await request(app).get('/api/issues?status=invalid_status');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects limit > 200', async () => {
    const res = await request(app).get('/api/issues?limit=999');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/issues/:id', () => {
  it('returns 404 for unknown issue', async () => {
    const res = await request(app).get('/api/issues/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/issues/:id/status', () => {
  it('accepts valid status update', async () => {
    const { issueService } = require('../src/services/issue');
    issueService.getIssue.mockResolvedValueOnce({ id: 'test-id', status: 'open' });

    const res = await request(app)
      .patch('/api/issues/test-id/status')
      .send({ status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects invalid status', async () => {
    const res = await request(app)
      .patch('/api/issues/test-id/status')
      .send({ status: 'flying' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects missing status field', async () => {
    const res = await request(app)
      .patch('/api/issues/test-id/status')
      .send({});
    expect(res.status).toBe(400);
  });
});

// ============================================================
// Routing API
// ============================================================
describe('GET /api/routing', () => {
  it('returns routing mappings', async () => {
    const res = await request(app).get('/api/routing');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toMatchObject({ tag: '#refund', primaryOwnerName: 'Rahul' });
  });
});

describe('PUT /api/routing', () => {
  it('accepts valid mapping', async () => {
    const res = await request(app)
      .put('/api/routing')
      .send({
        tag: '#shipping',
        primaryOwner: 'U002',
        primaryOwnerName: 'Vikram',
        secondaryOwners: [],
        githubUsername: 'vikram',
        active: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects mapping missing required fields', async () => {
    const res = await request(app)
      .put('/api/routing')
      .send({ tag: '#bug' }); // missing primaryOwner, etc.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});

// ============================================================
// Workload API
// ============================================================
describe('GET /api/workload/summary', () => {
  it('returns workload summary per developer', async () => {
    const res = await request(app).get('/api/workload/summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toMatchObject({
      developerName: 'Rahul',
      openIssues: 3,
    });
  });
});

// ============================================================
// GitHub Webhook
// ============================================================
describe('POST /webhooks/github', () => {
  const prOpenedPayload = {
    action: 'opened',
    pull_request: {
      number: 42,
      title: 'Fix refund flow',
      html_url: 'https://github.com/org/repo/pull/42',
      merged: false,
      body: 'Fixes the refund issue',
    },
    repository: { full_name: 'org/repo' },
    sender: { login: 'rahul' },
  };

  it('returns 202 for valid PR event', async () => {
    const res = await request(app)
      .post('/webhooks/github')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'abc123')
      .send(prOpenedPayload);
    expect(res.status).toBe(202);
    expect(res.body.received).toBe(true);
  });

  it('returns 202 for issue closed event', async () => {
    const res = await request(app)
      .post('/webhooks/github')
      .set('X-GitHub-Event', 'issues')
      .set('X-GitHub-Delivery', 'def456')
      .send({ action: 'closed', issue: { number: 10 }, repository: { full_name: 'org/repo' }, sender: { login: 'rahul' } });
    expect(res.status).toBe(202);
  });

  it('handles unknown event types gracefully', async () => {
    const res = await request(app)
      .post('/webhooks/github')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'ghi789')
      .send({ action: 'push', repository: { full_name: 'org/repo' } });
    expect(res.status).toBe(202);
  });
});

// ============================================================
// 404 handler
// ============================================================
describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});

// ============================================================
// Response headers
// ============================================================
describe('response headers', () => {
  it('includes X-Request-Id header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers).toHaveProperty('x-request-id');
  });

  it('propagates provided X-Request-Id', async () => {
    const myId = 'my-custom-trace-id';
    const res = await request(app)
      .get('/health')
      .set('X-Request-Id', myId);
    expect(res.headers['x-request-id']).toBe(myId);
  });
});
