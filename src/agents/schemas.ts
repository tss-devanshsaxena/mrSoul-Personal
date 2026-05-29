import { z } from 'zod';

/** Structured intent classification for @MrSoul messages. */
export const slackIntentSchema = z.object({
  kind: z.enum([
    'create_issue',
    'developer_workload',
    'team_roster',
    'task_suggestion',
    'help',
  ]),
  developerQuery: z.string().optional(),
  taskDescription: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});

export type AdkSlackIntent = z.infer<typeof slackIntentSchema>;

/** Issue body summary for GitHub / Slack tracking. */
export const issueSummarySchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(z.string()).min(1).max(8),
  notes: z.array(z.string()).optional(),
  suggestedHashtags: z.array(z.string()).optional(),
  priorityHint: z.enum(['critical', 'urgent', 'high', 'medium', 'low']).optional(),
});

export type AdkIssueSummary = z.infer<typeof issueSummarySchema>;

/** Advisor narrative enrichment for task suggestions. */
export const taskSuggestionNarrativeSchema = z.object({
  headline: z.string().min(1),
  rationale: z.string().min(1),
  alternativesNote: z.string().optional(),
});

export type AdkTaskSuggestionNarrative = z.infer<typeof taskSuggestionNarrativeSchema>;

/** Product requirements document generated alongside issues. */
export const prdSchema = z.object({
  title: z.string().min(1),
  problemStatement: z.string().min(1),
  goals: z.array(z.string()).min(1).max(8),
  userStories: z.array(z.string()).min(1).max(10),
  functionalRequirements: z.array(z.string()).min(1).max(12),
  acceptanceCriteria: z.array(z.string()).min(1).max(10),
  outOfScope: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
  /** Short prompt the user can send to @Claude in the same Slack thread. */
  claudeHandoffPrompt: z.string().min(1),
});

export type AdkPrd = z.infer<typeof prdSchema>;
