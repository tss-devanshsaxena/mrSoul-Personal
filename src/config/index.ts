import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const optionalPositiveInt = z.preprocess((v) => {
  // Treat empty string / whitespace as "unset"
  if (typeof v === 'string' && v.trim() === '') return undefined;
  return v;
}, z.coerce.number().int().positive().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  APP_NAME: z.string().default('ce-tech-automation'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Slack
  SLACK_BOT_TOKEN: z.string().min(1, 'SLACK_BOT_TOKEN is required'),
  SLACK_SIGNING_SECRET: z.string().min(1, 'SLACK_SIGNING_SECRET is required'),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_MONITORED_CHANNELS: z.string().default('ce-tech-issues'),
  SLACK_BOT_USER_ID: z.string().optional(),
  SLACK_POST_GUIDELINES_ON_START: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(false)),
  /** If true, allows `npm run slack:set-meta` to set topic/description (never on dev start). Default off. */
  SLACK_SET_CHANNEL_META: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(false)),
  SLACK_GUIDELINES_CHANNELS: z.string().optional(),
  /** Socket Mode ping/pong timeout (ms). Default 30s; Slack SDK default is 5s and reconnects often on VPN/sleep. */
  SLACK_SOCKET_PING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // GitHub
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  GITHUB_OWNER: z.string().min(1, 'GITHUB_OWNER is required'),
  GITHUB_REPO: z.string().min(1, 'GITHUB_REPO is required'),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  // If GitHub rejects assigning the inferred user, fall back to this assignee.
  GITHUB_FALLBACK_ASSIGNEE: z.string().optional(),

  // GitHub Project (Projects v2) — required to enforce issue guidelines
  GITHUB_PROJECT_ORG: z.string().optional(),
  GITHUB_PROJECT_NUMBER: optionalPositiveInt,
  GITHUB_DEFAULT_SQUAD: z.string().default('Backend'),
  GITHUB_DEFAULT_RAISED_BY: z.string().default('Tech'),
  GITHUB_DEFAULT_EFFORT: z.enum(['1', '2', '3', '5', '8', '13']).default('3'),
  /** Override target quarter on project (e.g. Q2 2026). Default: quarter of target date. */
  GITHUB_DEFAULT_TARGET_QUARTER: z.string().optional(),
  // Optional: default parent epic for all issues (override with #parent-N in Slack)
  GITHUB_PARENT_ISSUE_NUMBER: optionalPositiveInt,

  // MongoDB
  MONGODB_URI: z.string().default('mongodb://localhost:27017/ce-tech-automation'),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(0),

  // Tracker
  TRACKER_TYPE: z.enum(['notion', 'google_sheets', 'mongodb_only']).default('mongodb_only'),
  NOTION_TOKEN: z.string().optional(),
  NOTION_DATABASE_ID: z.string().optional(),
  GOOGLE_SHEETS_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),

  // Retry
  MAX_RETRY_ATTEMPTS: z.coerce.number().default(3),
  RETRY_DELAY_MS: z.coerce.number().default(1000),

  // Queue
  QUEUE_CONCURRENCY: z.coerce.number().default(5),

  // Optional LLM (budgeted)
  LLM_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(false)),
  LLM_PROVIDER: z.enum(['openai_compatible']).default('openai_compatible'),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(2048).default(300),
  LLM_MAX_CALLS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(20),
  LLM_CACHE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),

  // Google Agent Development Kit (ADK) — Gemini-powered agents with tools
  ADK_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(false)),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_GENAI_API_KEY: z.string().optional(),
  ADK_MODEL: z.string().default('gemini-2.5-flash'),
  ADK_MAX_CALLS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(30),
  ADK_CACHE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
  ADK_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120_000).default(45_000),
  ADK_MIN_INTENT_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.72),
  ADK_INTENT_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),
  ADK_ENRICH_TRIAGE: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),
  ADK_ADVISOR_MODE: z.enum(['deterministic', 'agent']).default('deterministic'),

  // Slack live ops + PRD (in-thread updates, not browser dashboard)
  SLACK_LIVE_OPS_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),
  PRD_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),
  /** Generate PRD on every issue create (when PRD_ENABLED). If false, only with #prd. */
  PRD_ON_EVERY_ISSUE: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),
  /** Slack user ID of the Claude app bot — enables @Claude handoff in thread. */
  SLACK_CLAUDE_BOT_USER_ID: z.string().optional(),
  /** Display name for Claude in thread context (default: Claude). */
  SLACK_CLAUDE_BOT_NAME: z.string().default('Claude'),

  // Groq — used for /create-ticket AI flow (problem brief, PRD, revisions)
  GROQ_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_MAX_TOKENS: z.coerce.number().int().min(256).max(8192).default(4096),
  GROQ_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120_000).default(60_000),
  GROQ_MAX_CALLS_PER_DAY: z.coerce.number().int().min(0).max(2000).default(150),
  /** Use Groq for @MrSoul conversations (workload, ownership, general Q&A) with live GitHub context */
  GROQ_ADVISOR_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),

  /** Enable /create-ticket slash command workflow */
  TICKET_FLOW_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),

  /** Email-based allowlist for MrSoul (Slack profile email must match) */
  ACCESS_CONTROL_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),

  /** Daily Slack messages to store owners (dashboard + cron) */
  STORE_OUTREACH_ENABLED: z.preprocess((v) => {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return v;
  }, z.boolean().default(true)),
  STORE_OUTREACH_TIMEZONE: z.string().default('Asia/Kolkata'),

  /** Admin portal login (sidebar dashboard at /admin) */
  DASHBOARD_USERNAME: z.string().default('admin'),
  DASHBOARD_PASSWORD: z.string().optional(),
  DASHBOARD_SESSION_SECRET: z.string().optional(),
  DASHBOARD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
});

let parsedEnv: z.infer<typeof envSchema>;

try {
  parsedEnv = envSchema.parse(process.env);
} catch (err) {
  if (err instanceof z.ZodError) {
    console.error('❌ Invalid environment configuration:');
    err.errors.forEach(e => {
      console.error(`  ${e.path.join('.')}: ${e.message}`);
    });
    process.exit(1);
  }
  throw err;
}

export const config = {
  env: parsedEnv.NODE_ENV,
  port: parsedEnv.PORT,
  appName: parsedEnv.APP_NAME,
  logLevel: parsedEnv.LOG_LEVEL,

  slack: {
    botToken: parsedEnv.SLACK_BOT_TOKEN,
    signingSecret: parsedEnv.SLACK_SIGNING_SECRET,
    appToken: parsedEnv.SLACK_APP_TOKEN,
    monitoredChannels: parsedEnv.SLACK_MONITORED_CHANNELS.split(',').map(c => c.trim()),
    botUserId: parsedEnv.SLACK_BOT_USER_ID,
    postGuidelinesOnStart: parsedEnv.SLACK_POST_GUIDELINES_ON_START,
    setChannelMetaOnSetup: parsedEnv.SLACK_SET_CHANNEL_META,
    guidelinesChannels: (parsedEnv.SLACK_GUIDELINES_CHANNELS ?? parsedEnv.SLACK_MONITORED_CHANNELS)
      .split(',')
      .map(c => c.trim())
      .filter(Boolean),
    guidelinesPinMarker: 'mrsoul-guidelines-v1',
    socketPingTimeoutMs: parsedEnv.SLACK_SOCKET_PING_TIMEOUT_MS,
    liveOpsEnabled: parsedEnv.SLACK_LIVE_OPS_ENABLED,
    claudeBotUserId: parsedEnv.SLACK_CLAUDE_BOT_USER_ID?.trim() || undefined,
    claudeBotName: parsedEnv.SLACK_CLAUDE_BOT_NAME,
  },

  prd: {
    enabled: parsedEnv.PRD_ENABLED,
    onEveryIssue: parsedEnv.PRD_ON_EVERY_ISSUE,
  },

  github: {
    token: parsedEnv.GITHUB_TOKEN,
    owner: parsedEnv.GITHUB_OWNER,
    repo: parsedEnv.GITHUB_REPO,
    webhookSecret: parsedEnv.GITHUB_WEBHOOK_SECRET,
    fallbackAssignee: parsedEnv.GITHUB_FALLBACK_ASSIGNEE?.trim() || undefined,
    project: {
      org: parsedEnv.GITHUB_PROJECT_ORG,
      number: parsedEnv.GITHUB_PROJECT_NUMBER,
      defaultSquad: parsedEnv.GITHUB_DEFAULT_SQUAD,
      defaultRaisedBy: parsedEnv.GITHUB_DEFAULT_RAISED_BY,
      defaultEffort: Number(parsedEnv.GITHUB_DEFAULT_EFFORT) as 1 | 2 | 3 | 5 | 8 | 13,
      targetQuarter: parsedEnv.GITHUB_DEFAULT_TARGET_QUARTER,
      parentIssueNumber: parsedEnv.GITHUB_PARENT_ISSUE_NUMBER,
    },
  },

  mongodb: {
    uri: parsedEnv.MONGODB_URI,
  },

  redis: {
    host: parsedEnv.REDIS_HOST,
    port: parsedEnv.REDIS_PORT,
    password: parsedEnv.REDIS_PASSWORD,
    db: parsedEnv.REDIS_DB,
  },

  tracker: {
    type: parsedEnv.TRACKER_TYPE,
    notion: {
      token: parsedEnv.NOTION_TOKEN,
      databaseId: parsedEnv.NOTION_DATABASE_ID,
    },
    googleSheets: {
      sheetId: parsedEnv.GOOGLE_SHEETS_ID,
      serviceAccountEmail: parsedEnv.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKey: parsedEnv.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
  },

  rateLimiting: {
    windowMs: parsedEnv.RATE_LIMIT_WINDOW_MS,
    maxRequests: parsedEnv.RATE_LIMIT_MAX_REQUESTS,
  },

  retry: {
    maxAttempts: parsedEnv.MAX_RETRY_ATTEMPTS,
    delayMs: parsedEnv.RETRY_DELAY_MS,
  },

  queue: {
    concurrency: parsedEnv.QUEUE_CONCURRENCY,
  },

  llm: {
    enabled: parsedEnv.LLM_ENABLED,
    provider: parsedEnv.LLM_PROVIDER,
    baseUrl: parsedEnv.LLM_BASE_URL,
    apiKey: parsedEnv.LLM_API_KEY,
    model: parsedEnv.LLM_MODEL,
    maxTokens: parsedEnv.LLM_MAX_TOKENS,
    maxCallsPerDay: parsedEnv.LLM_MAX_CALLS_PER_DAY,
    cacheTtlHours: parsedEnv.LLM_CACHE_TTL_HOURS,
  },

  adk: {
    enabled: parsedEnv.ADK_ENABLED,
    apiKey: parsedEnv.GEMINI_API_KEY ?? parsedEnv.GOOGLE_GENAI_API_KEY,
    model: parsedEnv.ADK_MODEL,
    maxCallsPerDay: parsedEnv.ADK_MAX_CALLS_PER_DAY,
    cacheTtlHours: parsedEnv.ADK_CACHE_TTL_HOURS,
    timeoutMs: parsedEnv.ADK_TIMEOUT_MS,
    minIntentConfidence: parsedEnv.ADK_MIN_INTENT_CONFIDENCE,
    useIntentClassifier: parsedEnv.ADK_INTENT_ENABLED,
    enrichTriage: parsedEnv.ADK_ENRICH_TRIAGE,
    advisorMode: parsedEnv.ADK_ADVISOR_MODE,
  },

  groq: {
    enabled: parsedEnv.GROQ_ENABLED,
    apiKey: parsedEnv.GROQ_API_KEY?.trim() || undefined,
    model: parsedEnv.GROQ_MODEL,
    maxTokens: parsedEnv.GROQ_MAX_TOKENS,
    timeoutMs: parsedEnv.GROQ_TIMEOUT_MS,
    maxCallsPerDay: parsedEnv.GROQ_MAX_CALLS_PER_DAY,
    advisorEnabled: parsedEnv.GROQ_ADVISOR_ENABLED,
  },

  ticketFlow: {
    enabled: parsedEnv.TICKET_FLOW_ENABLED,
  },

  accessControl: {
    enabled: parsedEnv.ACCESS_CONTROL_ENABLED,
  },

  storeOutreach: {
    enabled: parsedEnv.STORE_OUTREACH_ENABLED,
    defaultTimezone: parsedEnv.STORE_OUTREACH_TIMEZONE,
  },

  dashboard: {
    username: parsedEnv.DASHBOARD_USERNAME,
    password: parsedEnv.DASHBOARD_PASSWORD?.trim() || undefined,
    sessionSecret:
      parsedEnv.DASHBOARD_SESSION_SECRET?.trim() ||
      parsedEnv.DASHBOARD_PASSWORD?.trim() ||
      'dev-only-change-dashboard-session-secret',
    sessionTtlHours: parsedEnv.DASHBOARD_SESSION_TTL_HOURS,
  },

  isProd: parsedEnv.NODE_ENV === 'production',
  isDev: parsedEnv.NODE_ENV === 'development',
  isTest: parsedEnv.NODE_ENV === 'test',
} as const;

export type Config = typeof config;
