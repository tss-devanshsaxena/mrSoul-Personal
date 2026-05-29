import mongoose, { Document, Schema, Model } from 'mongoose';
import {
  IssueRecord,
  IssueStatus,
  Priority,
  AuditLogEntry,
  IssueAssignment,
  GitHubIssueRef,
  SlackThreadRef,
  DeveloperMapping,
} from '../types';

// ============================================================
// Issue Model
// ============================================================

export interface IssueDocument extends Omit<IssueRecord, 'id'>, Document {}

const AuditLogEntrySchema = new Schema<AuditLogEntry>(
  {
    timestamp: { type: Date, required: true, default: Date.now },
    action: { type: String, required: true },
    actor: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} },
    success: { type: Boolean, required: true },
    error: { type: String },
  },
  { _id: false }
);

const AssignmentSchema = new Schema<IssueAssignment>(
  {
    primaryOwnerId: { type: String, required: true },
    primaryOwnerName: { type: String, required: true },
    secondaryOwnerIds: { type: [String], default: [] },
    githubUsername: { type: String, required: true },
    resolvedFromTags: { type: [String], default: [] },
  },
  { _id: false }
);

const GitHubIssueRefSchema = new Schema<GitHubIssueRef>(
  {
    issueNumber: { type: Number, required: true },
    issueUrl: { type: String, required: true },
    issueTitle: { type: String, required: true },
    nodeId: { type: String, required: true },
  },
  { _id: false }
);

const SlackThreadRefSchema = new Schema<SlackThreadRef>(
  {
    channelId: { type: String, required: true },
    threadTs: { type: String, required: true },
    threadUrl: { type: String },
  },
  { _id: false }
);

const IssueSchema = new Schema<IssueDocument>(
  {
    slackMessageTs: { type: String, required: true, index: true },
    slackChannelId: { type: String, required: true, index: true },
    slackChannelName: { type: String, required: true },
    slackUserId: { type: String, required: true },
    slackUserName: { type: String, required: true },
    originalMessage: { type: String, required: true },
    hashtags: { type: [String], required: true },
    priority: {
      type: String,
      enum: ['critical', 'urgent', 'high', 'medium', 'low'],
      required: true,
    },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'pr_opened', 'pr_merged', 'closed', 'resolved'],
      default: 'open',
      index: true,
    },
    assignment: { type: AssignmentSchema, required: true },
    githubIssue: { type: GitHubIssueRefSchema },
    slackThread: { type: SlackThreadRefSchema },
    workloadTrackerRef: { type: String },
    auditLog: { type: [AuditLogEntrySchema], default: [] },
    resolvedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound index to detect duplicates
IssueSchema.index({ slackMessageTs: 1, slackChannelId: 1 }, { unique: true });
IssueSchema.index({ 'assignment.primaryOwnerId': 1, status: 1 });
IssueSchema.index({ 'githubIssue.issueNumber': 1 });

export const Issue: Model<IssueDocument> = mongoose.model<IssueDocument>('Issue', IssueSchema);

// ============================================================
// Developer Routing Model
// ============================================================

export interface DeveloperMappingDocument extends Omit<DeveloperMapping, 'tag'>, Document {
  tag: string;
}

const DeveloperMappingSchema = new Schema<DeveloperMappingDocument>(
  {
    tag: { type: String, required: true, lowercase: true, trim: true },
    primaryOwner: { type: String, required: true },
    primaryOwnerName: { type: String, required: true },
    secondaryOwners: { type: [String], default: [] },
    githubUsername: { type: String, required: true },
    notionUserId: { type: String },
    active: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

DeveloperMappingSchema.index({ tag: 1 }, { unique: true });

export const DeveloperMappingModel: Model<DeveloperMappingDocument> =
  mongoose.model<DeveloperMappingDocument>('DeveloperMapping', DeveloperMappingSchema);

// ============================================================
// Deduplication Cache Model
// ============================================================

interface DedupeEntry {
  key: string;
  processedAt: Date;
  expiresAt: Date;
}

interface DedupeDocument extends DedupeEntry, Document {}

const DedupeSchema = new Schema<DedupeDocument>({
  key: { type: String, required: true, unique: true },
  processedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
});

// TTL index: MongoDB automatically removes expired entries
DedupeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DedupeCache: Model<DedupeDocument> =
  mongoose.model<DedupeDocument>('DedupeCache', DedupeSchema);

// ============================================================
// LLM Cache + Usage (optional)
// ============================================================

interface LlmCacheEntry {
  key: string;
  value: Record<string, unknown>;
  expiresAt: Date;
}

interface LlmCacheDocument extends LlmCacheEntry, Document {}

const LlmCacheSchema = new Schema<LlmCacheDocument>({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
});

LlmCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LlmCache: Model<LlmCacheDocument> =
  mongoose.model<LlmCacheDocument>('LlmCache', LlmCacheSchema);

interface LlmUsageEntry {
  day: string; // YYYY-MM-DD
  count: number;
}

interface LlmUsageDocument extends LlmUsageEntry, Document {}

const LlmUsageSchema = new Schema<LlmUsageDocument>({
  day: { type: String, required: true, unique: true, index: true },
  count: { type: Number, required: true, default: 0 },
});

export const LlmUsage: Model<LlmUsageDocument> =
  mongoose.model<LlmUsageDocument>('LlmUsage', LlmUsageSchema);

// ============================================================
// Ticket flow (/create-ticket) sessions
// ============================================================

export type TicketFlowState =
  | 'awaiting_approval'
  | 'prd_generating'
  | 'prd_ready'
  | 'issue_creating'
  | 'completed'
  | 'rejected'
  | 'cancelled';

export interface TicketFlowSessionDoc extends Document {
  sessionId: string;
  channelId: string;
  threadTs: string;
  rootMessageTs: string;
  userId: string;
  userName: string;
  state: TicketFlowState;
  rawInput: string;
  problemTitle: string;
  problemSummary: string;
  keyQuestions: string[];
  suggestedScope?: string;
  prd?: Record<string, unknown>;
  prdTitle?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  assigneeGithub?: string;
  assigneeName?: string;
  expiresAt: Date;
}

const TicketFlowSessionSchema = new Schema<TicketFlowSessionDoc>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    channelId: { type: String, required: true, index: true },
    threadTs: { type: String, required: true, index: true },
    rootMessageTs: { type: String, required: true },
    userId: { type: String, required: true },
    userName: { type: String, default: 'User' },
    state: {
      type: String,
      enum: ['awaiting_approval', 'prd_generating', 'prd_ready', 'issue_creating', 'completed', 'rejected', 'cancelled'],
      required: true,
    },
    rawInput: { type: String, required: true },
    problemTitle: { type: String, default: '' },
    problemSummary: { type: String, default: '' },
    keyQuestions: { type: [String], default: [] },
    suggestedScope: { type: String },
    prd: { type: Schema.Types.Mixed },
    prdTitle: { type: String },
    githubIssueNumber: { type: Number },
    githubIssueUrl: { type: String },
    assigneeGithub: { type: String },
    assigneeName: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

TicketFlowSessionSchema.index({ channelId: 1, threadTs: 1 });
TicketFlowSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TicketFlowSession: Model<TicketFlowSessionDoc> = mongoose.model<TicketFlowSessionDoc>(
  'TicketFlowSession',
  TicketFlowSessionSchema
);

// ============================================================
// MrSoul access control (email allowlist + roles)
// ============================================================

export type MrSoulAccessRole = 'super_admin' | 'admin' | 'member';

export interface MrSoulAccessUserDoc extends Document {
  email: string;
  role: MrSoulAccessRole;
  slackUserId?: string;
  grantedByEmail?: string;
  grantedBySlackId?: string;
  active: boolean;
  revokedAt?: Date;
  revokedByEmail?: string;
}

const MrSoulAccessUserSchema = new Schema<MrSoulAccessUserDoc>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: {
      type: String,
      enum: ['super_admin', 'admin', 'member'],
      required: true,
      default: 'member',
    },
    slackUserId: { type: String },
    grantedByEmail: { type: String },
    grantedBySlackId: { type: String },
    active: { type: Boolean, default: true, index: true },
    revokedAt: { type: Date },
    revokedByEmail: { type: String },
  },
  { timestamps: true }
);

MrSoulAccessUserSchema.index({ email: 1, active: 1 });

export const MrSoulAccessUser: Model<MrSoulAccessUserDoc> = mongoose.model<MrSoulAccessUserDoc>(
  'MrSoulAccessUser',
  MrSoulAccessUserSchema
);

// ============================================================
// Store owners (daily Slack outreach)
// ============================================================

export interface StoreOwnerDoc extends Document {
  storeId: string;
  storeLocation: string;
  userName: string;
  name: string;
  phone: string;
  email: string;
  active: boolean;
  slackUserId?: string;
  lastOutreachAt?: Date;
  lastOutreachDate?: string;
  lastOutreachError?: string;
  lastMessageTs?: string;
  lastChannelId?: string;
}

const StoreOwnerSchema = new Schema<StoreOwnerDoc>(
  {
    storeId: { type: String, required: true, unique: true, trim: true, index: true },
    storeLocation: { type: String, required: true, trim: true },
    userName: { type: String, trim: true, default: '' },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    active: { type: Boolean, default: true, index: true },
    slackUserId: { type: String },
    lastOutreachAt: { type: Date },
    lastOutreachDate: { type: String },
    lastOutreachError: { type: String },
    lastMessageTs: { type: String },
    lastChannelId: { type: String },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

StoreOwnerSchema.virtual('id').get(function (this: StoreOwnerDoc) {
  return this._id.toHexString();
});

export const StoreOwner: Model<StoreOwnerDoc> = mongoose.model<StoreOwnerDoc>(
  'StoreOwner',
  StoreOwnerSchema
);

// ============================================================
// Store outreach schedule (singleton)
// ============================================================

export interface StoreOutreachConfigDoc extends Document {
  configKey: string;
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: string;
  messageTemplate: string;
  pinMessages: boolean;
  /** When true (default), each store gets at most one DM per calendar day. */
  oncePerDay: boolean;
  lastRunAt?: Date;
  lastRunSummary?: string;
}

const StoreOutreachConfigSchema = new Schema<StoreOutreachConfigDoc>(
  {
    configKey: { type: String, required: true, unique: true, default: 'default' },
    enabled: { type: Boolean, default: false },
    hour: { type: Number, default: 9, min: 0, max: 23 },
    minute: { type: Number, default: 0, min: 0, max: 59 },
    timezone: { type: String, default: 'Asia/Kolkata' },
    messageTemplate: {
      type: String,
      default:
        'Good morning {{name}}! Daily check-in for store *{{storeLocation}}* ({{storeId}}). Reply here if you need anything from ops.',
    },
    pinMessages: { type: Boolean, default: true },
    oncePerDay: { type: Boolean, default: true },
    lastRunAt: { type: Date },
    lastRunSummary: { type: String },
  },
  { timestamps: true }
);

export const StoreOutreachConfig: Model<StoreOutreachConfigDoc> =
  mongoose.model<StoreOutreachConfigDoc>('StoreOutreachConfig', StoreOutreachConfigSchema);
