import { LlmAgent, zodObjectToSchema } from '@google/adk';
import { config } from '../config';
import {
  issueSummarySchema,
  prdSchema,
  slackIntentSchema,
  taskSuggestionNarrativeSchema,
} from './schemas';

import { mrsoulAdvisorTools } from './tools/mrsoulTools';
import { MRSOUL_COLLEAGUE_VOICE } from '../content/mrsoulVoice';

/** Bridge project Zod v3 schemas to ADK (expects v3/v4 ZodObject). */
const asAdkSchema = (schema: unknown) => zodObjectToSchema(schema as Parameters<typeof zodObjectToSchema>[0]);

/** Required when using outputSchema — avoids ADK transfer-config warnings at startup. */
const structuredOutputAgentOpts = {
  disallowTransferToParent: true,
  disallowTransferToPeers: true,
} as const;

const model = () => config.adk.model;

const INTENT_INSTRUCTION = `You classify Slack messages sent to @MrSoul (CE-Tech engineering bot at The Souled Store).

Return JSON matching the output schema only.

Intent kinds:
- create_issue: user wants to file/track work (hashtags, "create issue", bug reports to track)
- developer_workload: asking what a specific person is working on
- team_roster: team-wide "who is working on what" / team status
- task_suggestion: who should own a task, assignee recommendation, generic @bot question
- help: help, commands, greetings with no other ask

Extract developerQuery for workload questions. Extract taskDescription for task_suggestion.
Set confidence 0.0-1.0. Use reasoning for ambiguous cases.`;

const SUMMARY_INSTRUCTION = `You are MrSoul, CE-Tech triage assistant for The Souled Store engineering.

Given a Slack message about a bug or task, produce a concise JSON summary for a GitHub issue.
Focus on: clear problem statement, actionable engineering tasks, risks/notes if any.
Suggest hashtags (without #) like refund, order, payment when domain is obvious.
Do not invent people or ticket numbers.`;

const ADVISOR_INSTRUCTION = `You are MrSoul on The Souled Store tech team — a friendly colleague in Slack.

${MRSOUL_COLLEAGUE_VOICE}

Help with workload, team status, and ownership. Call tools for real GitHub data before answering.
Reference GitHub logins (tss-*) when naming people. To file work: hashtags or "create issue".`;

const PRD_INSTRUCTION = `You are MrSoul, writing a Product Requirements Document (PRD) for The Souled Store engineering.

Given a Slack requirement (and optional thread context including messages from teammates or Claude), produce a structured PRD JSON.

Rules:
- Be specific to e-commerce / CE-Tech context when implied; do not invent systems not mentioned.
- userStories use "As a … I want … so that …" when possible.
- functionalRequirements are testable engineering requirements.
- acceptanceCriteria are verifiable Given/When/Then or checklist items.
- claudeHandoffPrompt: 2-4 sentences asking Claude to refine gaps, risks, and edge cases (written as if the user will paste it to @Claude in Slack).
- If thread context includes Claude or other bot replies, incorporate their points into openQuestions or requirements.`;

const NARRATIVE_INSTRUCTION = `You write a short Slack-friendly explanation for a task ownership recommendation.
Use the provided triage JSON (deterministic scores). Do not change the recommended assignee.
Only reference people and GitHub logins present in the triage JSON — never invent names like Rahul, Devansh, or Aman.
Be direct: headline (one line), rationale (2-4 sentences), optional alternativesNote.`;

/** Classifies @bot Slack messages into structured intents. */
export const intentClassifierAgent = new LlmAgent({
  name: 'mrsoul_intent_classifier',
  model: model(),
  instruction: INTENT_INSTRUCTION,
  outputSchema: asAdkSchema(slackIntentSchema),
  includeContents: 'none',
  ...structuredOutputAgentOpts,
});

/** Summarizes Slack text into GitHub-ready issue content. */
export const issueSummaryAgent = new LlmAgent({
  name: 'mrsoul_issue_summarizer',
  model: model(),
  instruction: SUMMARY_INSTRUCTION,
  outputSchema: asAdkSchema(issueSummarySchema),
  includeContents: 'none',
  ...structuredOutputAgentOpts,
});

/** Tool-using advisor for workload, roster, and ownership questions. */
export const mrsoulAdvisorAgent = new LlmAgent({
  name: 'mrsoul_advisor',
  model: model(),
  instruction: ADVISOR_INSTRUCTION,
  tools: mrsoulAdvisorTools,
});

/** Generates a PRD parallel to issue creation. */
export const prdAgent = new LlmAgent({
  name: 'mrsoul_prd_generator',
  model: model(),
  instruction: PRD_INSTRUCTION,
  outputSchema: asAdkSchema(prdSchema),
  includeContents: 'none',
  ...structuredOutputAgentOpts,
});

/** Adds human-readable narrative on top of deterministic triage. */
export const taskNarrativeAgent = new LlmAgent({
  name: 'mrsoul_task_narrative',
  model: model(),
  instruction: NARRATIVE_INSTRUCTION,
  outputSchema: asAdkSchema(taskSuggestionNarrativeSchema),
  includeContents: 'none',
  ...structuredOutputAgentOpts,
});

/** Root agent for ADK CLI / devtools (`npm run adk:web`). */
export const rootAgent = mrsoulAdvisorAgent;
