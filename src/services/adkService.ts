import crypto from 'crypto';
import { Content } from '@google/genai';
import {
  InMemoryRunner,
  isFinalResponse,
  stringifyContent,
  StreamingMode,
  type LlmAgent,
} from '@google/adk';
import { config } from '../config';
import { LlmCache, LlmUsage } from '../models';
import { createLogger } from '../utils/logger';
import {
  intentClassifierAgent,
  issueSummaryAgent,
  mrsoulAdvisorAgent,
  prdAgent,
  taskNarrativeAgent,
} from '../agents/mrsoulAgents';
import {
  AdkIssueSummary,
  AdkPrd,
  AdkSlackIntent,
  AdkTaskSuggestionNarrative,
  issueSummarySchema,
  prdSchema,
  slackIntentSchema,
  taskSuggestionNarrativeSchema,
} from '../agents/schemas';
import type { SlackIntent } from './intent';
import type { LlmIssueSummary } from './llm';
import type { TriageDecision } from './triage';
import { activityFeed } from './activityFeed';

const log = createLogger('adk');

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function todayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function userMessage(text: string): Content {
  return { role: 'user', parts: [{ text }] };
}

function parseJsonFromAgentText<T>(text: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): T | null {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    const result = schema.safeParse(parsed);
    return result.success ? result.data! : null;
  } catch {
    return null;
  }
}

export class AdkService {
  private static instance: AdkService;
  private runners = new Map<string, InMemoryRunner>();

  static getInstance(): AdkService {
    if (!AdkService.instance) {
      AdkService.instance = new AdkService();
    }
    return AdkService.instance;
  }

  isEnabled(): boolean {
    return config.adk.enabled && Boolean(config.adk.apiKey);
  }

  private runnerFor(agent: LlmAgent): InMemoryRunner {
    const key = agent.name;
    let runner = this.runners.get(key);
    if (!runner) {
      runner = new InMemoryRunner({ agent, appName: config.appName });
      this.runners.set(key, runner);
    }
    return runner;
  }

  private async consumeBudget(): Promise<boolean> {
    const maxCalls = config.adk.maxCallsPerDay;
    const day = todayKey();
    const usage = await LlmUsage.findOneAndUpdate(
      { day },
      { $inc: { count: 1 }, $setOnInsert: { day } },
      { upsert: true, new: true }
    );
    if ((usage?.count ?? 0) > maxCalls) {
      log.warn('ADK daily budget exceeded', { day, maxCalls });
      return false;
    }
    return true;
  }

  private async getCached<T>(cacheKey: string): Promise<T | null> {
    const existing = await LlmCache.findOne({ key: cacheKey });
    if (!existing?.value) return null;
    return existing.value as T;
  }

  private async setCache(cacheKey: string, value: unknown): Promise<void> {
    await LlmCache.findOneAndUpdate(
      { key: cacheKey },
      {
        key: cacheKey,
        value,
        expiresAt: new Date(Date.now() + config.adk.cacheTtlHours * 3600_000),
      },
      { upsert: true, new: true }
    );
  }

  private async runAgentText(agent: LlmAgent, prompt: string, userId: string): Promise<string | null> {
    if (!(await this.consumeBudget())) return null;

    const runner = this.runnerFor(agent);
    const timeoutMs = config.adk.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let finalText = '';
      for await (const event of runner.runEphemeral({
        userId,
        newMessage: userMessage(prompt),
        runConfig: { streamingMode: StreamingMode.NONE },
      })) {
        if (controller.signal.aborted) break;
        if (isFinalResponse(event)) {
          finalText = stringifyContent(event);
        }
      }
      if (finalText) {
        activityFeed.emitActivity({
          level: 'success',
          source: 'adk',
          title: `ADK ${agent.name} completed`,
          detail: `${finalText.length} chars`,
        });
      }
      return finalText || null;
    } catch (err) {
      log.warn('ADK agent run failed', {
        agent: agent.name,
        error: (err as Error).message,
      });
      activityFeed.emitActivity({
        level: 'warn',
        source: 'adk',
        title: `ADK ${agent.name} failed`,
        detail: (err as Error).message,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * LLM intent classification (optional). Regex remains the fast path in slackApp.
   */
  async classifyIntent(text: string, opts: { hasHashtags: boolean }): Promise<SlackIntent | null> {
    if (!this.isEnabled()) return null;

    const cacheKey = `adk:intent:${sha256(`${opts.hasHashtags}:${text.trim().toLowerCase()}`)}`;
    const cached = await this.getCached<AdkSlackIntent>(cacheKey);
    if (cached) return this.toSlackIntent(cached);

    const prompt = [
      `Has hashtags in message: ${opts.hasHashtags}`,
      'Slack message:',
      text,
    ].join('\n');

    const raw = await this.runAgentText(intentClassifierAgent, prompt, 'mrsoul-intent');
    if (!raw) return null;

    const parsed = parseJsonFromAgentText(raw, slackIntentSchema);
    if (!parsed || parsed.confidence < config.adk.minIntentConfidence) {
      return null;
    }

    await this.setCache(cacheKey, parsed);
    return this.toSlackIntent(parsed);
  }

  private toSlackIntent(parsed: AdkSlackIntent): SlackIntent {
    switch (parsed.kind) {
      case 'developer_workload':
        return {
          kind: 'developer_workload',
          developerQuery: parsed.developerQuery ?? 'unknown',
        };
      case 'team_roster':
        return { kind: 'team_roster' };
      case 'task_suggestion':
        return {
          kind: 'task_suggestion',
          taskDescription: parsed.taskDescription ?? '',
        };
      case 'help':
        return { kind: 'help' };
      case 'create_issue':
      default:
        return { kind: 'create_issue' };
    }
  }

  async summarizeIssue(text: string): Promise<LlmIssueSummary | null> {
    if (!this.isEnabled()) return null;

    const cacheKey = `adk:summary:${sha256(text.trim().toLowerCase())}`;
    const cached = await this.getCached<AdkIssueSummary>(cacheKey);
    if (cached) return this.toLlmSummary(cached);

    const raw = await this.runAgentText(issueSummaryAgent, text, 'mrsoul-summary');
    if (!raw) return null;

    const parsed = parseJsonFromAgentText(raw, issueSummarySchema);
    if (!parsed) return null;

    await this.setCache(cacheKey, parsed);
    return this.toLlmSummary(parsed);
  }

  private toLlmSummary(parsed: AdkIssueSummary): LlmIssueSummary {
    const notes = [...(parsed.notes ?? [])];
    if (parsed.suggestedHashtags?.length) {
      notes.push(`Suggested tags: ${parsed.suggestedHashtags.map(t => `#${t}`).join(', ')}`);
    }
    if (parsed.priorityHint) {
      notes.push(`Priority hint: ${parsed.priorityHint}`);
    }
    return {
      summary: parsed.summary,
      tasks: parsed.tasks,
      notes: notes.length > 0 ? notes : undefined,
    };
  }

  /**
   * Full tool-using advisor reply (used when ADK_ADVISOR_MODE=agent).
   */
  async runAdvisorQuery(question: string, userId: string): Promise<string | null> {
    if (!this.isEnabled()) return null;
    return this.runAgentText(mrsoulAdvisorAgent, question, userId);
  }

  /**
   * Short narrative to enrich deterministic triage blocks in Slack.
   */
  async generatePrd(prompt: string): Promise<AdkPrd | null> {
    if (!this.isEnabled()) return null;

    const cacheKey = `adk:prd:${sha256(prompt.slice(0, 2000))}`;
    const cached = await this.getCached<AdkPrd>(cacheKey);
    if (cached) return cached;

    const raw = await this.runAgentText(prdAgent, prompt, 'mrsoul-prd');
    if (!raw) return null;

    const parsed = parseJsonFromAgentText(raw, prdSchema);
    if (!parsed) return null;

    await this.setCache(cacheKey, parsed);
    return parsed;
  }

  async enrichTaskSuggestion(
    taskDescription: string,
    triage: TriageDecision
  ): Promise<AdkTaskSuggestionNarrative | null> {
    if (!this.isEnabled() || !config.adk.enrichTriage) return null;

    const cacheKey = `adk:narrative:${sha256(
      `${taskDescription}:${triage.assignment.githubUsername}:${triage.chosen.score}`
    )}`;
    const cached = await this.getCached<AdkTaskSuggestionNarrative>(cacheKey);
    if (cached) return cached;

    const prompt = JSON.stringify({
      task: taskDescription.slice(0, 800),
      recommendation: {
        githubUsername: triage.assignment.githubUsername,
        displayName: triage.assignment.primaryOwnerName,
        score: triage.chosen.score,
        signals: triage.chosen.signals.map(s => s.kind),
      },
      candidates: triage.candidates.slice(0, 3).map(c => ({
        githubUsername: c.githubUsername,
        displayName: c.slackName,
        score: c.score,
      })),
    });

    const raw = await this.runAgentText(taskNarrativeAgent, prompt, 'mrsoul-narrative');
    if (!raw) return null;

    const parsed = parseJsonFromAgentText(raw, taskSuggestionNarrativeSchema);
    if (!parsed) return null;

    await this.setCache(cacheKey, parsed);
    return parsed;
  }
}

export const adkService = AdkService.getInstance();
