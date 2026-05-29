import { config } from '../config';
import { createLogger } from '../utils/logger';
import { IssueRecord, WorkloadSummary } from '../types';
import { Issue } from '../models';
import axios from 'axios';

const log = createLogger('tracker');

// ============================================================
// Notion Tracker
// ============================================================

class NotionTracker {
  private readonly baseUrl = 'https://api.notion.com/v1';
  private readonly headers: Record<string, string>;

  constructor(token: string) {
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    };
  }

  async upsertEntry(issue: IssueRecord): Promise<string> {
    const dbId = config.tracker.notion.databaseId!;

    const properties: Record<string, unknown> = {
      'Issue ID': { title: [{ text: { content: issue.id } }] },
      'Status': { select: { name: issue.status } },
      'Priority': { select: { name: issue.priority } },
      'Assigned To': { rich_text: [{ text: { content: issue.assignment.primaryOwnerName } }] },
      'Tags': { multi_select: issue.hashtags.map(t => ({ name: t.replace('#', '') })) },
      'GitHub Issue': issue.githubIssue
        ? { url: issue.githubIssue.issueUrl }
        : { url: null },
      'Created At': { date: { start: issue.createdAt.toISOString() } },
      'Original Message': { rich_text: [{ text: { content: issue.originalMessage.substring(0, 200) } }] },
    };

    // Check if entry exists
    const searchRes = await axios.post(
      `${this.baseUrl}/databases/${dbId}/query`,
      {
        filter: {
          property: 'Issue ID',
          title: { equals: issue.id },
        },
      },
      { headers: this.headers }
    );

    const existing = searchRes.data.results[0];

    if (existing) {
      await axios.patch(
        `${this.baseUrl}/pages/${existing.id}`,
        { properties },
        { headers: this.headers }
      );
      return existing.id;
    } else {
      const res = await axios.post(
        `${this.baseUrl}/pages`,
        { parent: { database_id: dbId }, properties },
        { headers: this.headers }
      );
      return res.data.id;
    }
  }
}

// ============================================================
// Google Sheets Tracker
// ============================================================

class GoogleSheetsTracker {
  private readonly sheetId: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(sheetId: string) {
    this.sheetId = sheetId;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const { createSign } = await import('crypto');
    const email = config.tracker.googleSheets.serviceAccountEmail!;
    const key = config.tracker.googleSheets.privateKey!.replace(/\\n/g, '\n');
    const now = Math.floor(Date.now() / 1000);

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })).toString('base64url');

    const unsigned = `${header}.${payload}`;
    const sign = createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign.sign(key, 'base64url');

    const jwt = `${unsigned}.${signature}`;

    const res = await axios.post('https://oauth2.googleapis.com/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    });

    this.accessToken = res.data.access_token;
    this.tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return this.accessToken!;
  }

  async upsertEntry(issue: IssueRecord): Promise<string> {
    const token = await this.getAccessToken();
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}`;
    const headers = { Authorization: `Bearer ${token}` };

    // Check if header row exists; if not, write it
    const rangeCheck = await axios.get(`${baseUrl}/values/Sheet1!A1:A1`, { headers });
    if (!rangeCheck.data.values) {
      await axios.put(
        `${baseUrl}/values/Sheet1!A1:L1?valueInputOption=RAW`,
        {
          values: [['Issue ID', 'Status', 'Priority', 'Assigned To', 'Tags',
            'GitHub Issue URL', 'GitHub #', 'Created At', 'Updated At',
            'Original Message', 'Channel', 'PR Status']],
        },
        { headers }
      );
    }

    const row = [
      issue.id,
      issue.status,
      issue.priority,
      issue.assignment.primaryOwnerName,
      issue.hashtags.join(', '),
      issue.githubIssue?.issueUrl ?? '',
      issue.githubIssue?.issueNumber ?? '',
      issue.createdAt.toISOString(),
      new Date().toISOString(),
      issue.originalMessage.substring(0, 100),
      issue.slackChannelName,
      '',
    ];

    await axios.post(
      `${baseUrl}/values/Sheet1!A:L:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values: [row] },
      { headers }
    );

    return `sheets:${issue.id}`;
  }
}

// ============================================================
// Workload Tracker Service (facade)
// ============================================================

export class WorkloadTrackerService {
  private static instance: WorkloadTrackerService;
  private notionTracker?: NotionTracker;
  private sheetsTracker?: GoogleSheetsTracker;

  private constructor() {
    if (config.tracker.type === 'notion' && config.tracker.notion.token) {
      this.notionTracker = new NotionTracker(config.tracker.notion.token);
    }
    if (config.tracker.type === 'google_sheets' && config.tracker.googleSheets.sheetId) {
      this.sheetsTracker = new GoogleSheetsTracker(config.tracker.googleSheets.sheetId);
    }
  }

  static getInstance(): WorkloadTrackerService {
    if (!WorkloadTrackerService.instance) {
      WorkloadTrackerService.instance = new WorkloadTrackerService();
    }
    return WorkloadTrackerService.instance;
  }

  /**
   * Track or update an issue in the workload tracker.
   */
  async trackIssue(issue: IssueRecord): Promise<string | undefined> {
    try {
      if (config.tracker.type === 'notion' && this.notionTracker) {
        const ref = await this.notionTracker.upsertEntry(issue);
        log.info('Synced to Notion', { issueId: issue.id, notionId: ref });
        return ref;
      }

      if (config.tracker.type === 'google_sheets' && this.sheetsTracker) {
        const ref = await this.sheetsTracker.upsertEntry(issue);
        log.info('Synced to Google Sheets', { issueId: issue.id });
        return ref;
      }

      // mongodb_only — tracking is already in MongoDB
      log.debug('Tracker type is mongodb_only; no external sync needed');
      return undefined;
    } catch (err) {
      log.error('Failed to sync workload tracker', { error: (err as Error).message });
      // Non-fatal: don't fail the main workflow
      return undefined;
    }
  }

  /**
   * Get workload summary for all developers (from MongoDB).
   */
  async getWorkloadSummary(): Promise<WorkloadSummary[]> {
    const pipeline = [
      {
        $group: {
          _id: '$assignment.primaryOwnerId',
          developerName: { $first: '$assignment.primaryOwnerName' },
          openIssues: {
            $sum: { $cond: [{ $in: ['$status', ['open']] }, 1, 0] },
          },
          inProgressIssues: {
            $sum: { $cond: [{ $in: ['$status', ['in_progress', 'pr_opened']] }, 1, 0] },
          },
          resolvedThisWeek: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ['$status', ['resolved', 'closed']] },
                    {
                      $gte: [
                        '$resolvedAt',
                        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          totalAssigned: { $sum: 1 },
        },
      },
    ];

    const results = await Issue.aggregate(pipeline);
    return results.map(r => ({
      developerId: r._id,
      developerName: r.developerName,
      openIssues: r.openIssues,
      inProgressIssues: r.inProgressIssues,
      resolvedThisWeek: r.resolvedThisWeek,
      totalAssigned: r.totalAssigned,
    }));
  }
}

export const workloadTracker = WorkloadTrackerService.getInstance();
