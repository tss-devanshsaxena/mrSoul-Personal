// ============================================================
// CE-Tech Automation Platform — Core Types
// ============================================================

export type Priority = 'critical' | 'urgent' | 'high' | 'medium' | 'low';
export type IssueStatus = 'open' | 'in_progress' | 'pr_opened' | 'pr_merged' | 'closed' | 'resolved';
export type TrackerType = 'notion' | 'google_sheets' | 'mongodb_only';

// ----------------------------
// Routing
// ----------------------------
export interface DeveloperMapping {
  tag: string;
  primaryOwner: string;         // Slack user ID
  primaryOwnerName: string;
  secondaryOwners: string[];    // Slack user IDs
  githubUsername: string;
  notionUserId?: string;
  active: boolean;
}

export interface RoutingConfig {
  mappings: DeveloperMapping[];
  defaultOwner: string;
  defaultOwnerName: string;
}

// ----------------------------
// Slack Event
// ----------------------------
export interface ParsedSlackMessage {
  messageTs: string;
  /** Parent thread root ts when message is a thread reply (for posting into same thread). */
  threadTs?: string;
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  text: string;
  hashtags: string[];
  priority: Priority;
  isPriority: boolean;
  isProduction: boolean;
  teamId: string;
  permalink?: string;
}

// ----------------------------
// Issue
// ----------------------------
export interface IssueAssignment {
  primaryOwnerId: string;
  primaryOwnerName: string;
  secondaryOwnerIds: string[];
  githubUsername: string;
  resolvedFromTags: string[];
}

export interface GitHubIssueRef {
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  nodeId: string;
}

export interface SlackThreadRef {
  channelId: string;
  threadTs: string;
  threadUrl?: string;
}

// ----------------------------
// Issue Record (DB)
// ----------------------------
export interface IssueRecord {
  id: string;
  slackMessageTs: string;
  slackChannelId: string;
  slackChannelName: string;
  slackUserId: string;
  slackUserName: string;
  originalMessage: string;
  hashtags: string[];
  priority: Priority;
  status: IssueStatus;
  assignment: IssueAssignment;
  githubIssue?: GitHubIssueRef;
  slackThread?: SlackThreadRef;
  workloadTrackerRef?: string;
  auditLog: AuditLogEntry[];
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
}

// ----------------------------
// Audit Log
// ----------------------------
export interface AuditLogEntry {
  timestamp: Date;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  success: boolean;
  error?: string;
}

// ----------------------------
// GitHub Webhook Events
// ----------------------------
export interface GitHubPREvent {
  action: 'opened' | 'closed' | 'merged' | 'reopened' | 'synchronized';
  pullRequest: {
    number: number;
    title: string;
    url: string;
    merged: boolean;
    body?: string;
  };
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
  };
}

export interface GitHubIssueEvent {
  action: 'opened' | 'closed' | 'reopened' | 'assigned';
  issue: {
    number: number;
    title: string;
    url: string;
    state: string;
    body?: string;
  };
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
  };
}

// ----------------------------
// Queue Jobs
// ----------------------------
export type JobType =
  | 'process_slack_message'
  | 'create_github_issue'
  | 'create_slack_thread'
  | 'update_slack_thread'
  | 'update_workload_tracker'
  | 'sync_github_status';

export interface QueueJob<T = unknown> {
  type: JobType;
  payload: T;
  issueId?: string;
  retryCount?: number;
}

export interface ProcessSlackMessagePayload {
  parsedMessage: ParsedSlackMessage;
}

export interface CreateGitHubIssuePayload {
  issueId: string;
  parsedMessage: ParsedSlackMessage;
  assignment: IssueAssignment;
}

export interface CreateSlackThreadPayload {
  issueId: string;
  parsedMessage: ParsedSlackMessage;
  assignment: IssueAssignment;
  githubIssue?: GitHubIssueRef;
}

export interface UpdateSlackThreadPayload {
  issueId: string;
  channelId: string;
  threadTs: string;
  updateType: 'status_change' | 'pr_opened' | 'pr_merged' | 'issue_closed';
  details: Record<string, unknown>;
}

// ----------------------------
// API Responses
// ----------------------------
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface WorkloadSummary {
  developerId: string;
  developerName: string;
  openIssues: number;
  inProgressIssues: number;
  resolvedThisWeek: number;
  totalAssigned: number;
}
