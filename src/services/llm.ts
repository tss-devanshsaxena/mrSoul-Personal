import crypto from 'crypto';
import axios from 'axios';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { LlmCache, LlmUsage } from '../models';
import { adkService } from './adkService';

const log = createLogger('llm');

export interface LlmIssueSummary {
  /** 1-2 lines problem statement */
  summary: string;
  /** Bullet-like steps */
  tasks: string[];
  /** Optional extra context/risks */
  notes?: string[];
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function todayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class LlmService {
  private static instance: LlmService;

  static getInstance(): LlmService {
    if (!LlmService.instance) {
      LlmService.instance = new LlmService();
    }
    return LlmService.instance;
  }

  isEnabled(): boolean {
    return config.llm.enabled === true || adkService.isEnabled();
  }

  async summarizeIssue(text: string): Promise<LlmIssueSummary | null> {
    if (adkService.isEnabled()) {
      const adkSummary = await adkService.summarizeIssue(text);
      if (adkSummary) return adkSummary;
    }

    if (!config.llm.enabled) return null;

    const key = sha256(text.trim().toLowerCase());
    const existing = await LlmCache.findOne({ key });
    if (existing?.value) {
      const v = existing.value as unknown;
      if (this.isValidSummary(v)) return v;
      // Corrupt/old cache entry — ignore.
    }

    const maxCalls = config.llm.maxCallsPerDay;
    const day = todayKey();
    const usage = await LlmUsage.findOneAndUpdate(
      { day },
      { $inc: { count: 1 }, $setOnInsert: { day } },
      { upsert: true, new: true }
    );

    if ((usage?.count ?? 0) > maxCalls) {
      log.warn('LLM daily budget exceeded; skipping', { day, maxCalls });
      return null;
    }

    const provider = config.llm.provider;
    if (provider !== 'openai_compatible') {
      log.warn('Unsupported LLM provider; skipping', { provider });
      return null;
    }

    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) {
      log.warn('LLM enabled but missing baseUrl/apiKey; skipping');
      return null;
    }

    const prompt = [
      'You are an engineering triage assistant.',
      'Given a Slack message, produce JSON with:',
      '{ "summary": string (1-2 lines), "tasks": string[] (3-7 bullets), "notes"?: string[] }.',
      'Keep it concise, no markdown, no extra keys.',
      '',
      'Slack message:',
      text,
    ].join('\n');

    try {
      const res = await axios.post(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          model: config.llm.model,
          temperature: 0.2,
          max_tokens: config.llm.maxTokens,
          messages: [
            { role: 'system', content: 'Return only valid JSON. Do not wrap in code fences.' },
            { role: 'user', content: prompt },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 20_000,
        }
      );

      const content = res.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('Empty LLM response');
      }

      const parsed = JSON.parse(content) as LlmIssueSummary;
      if (!this.isValidSummary(parsed)) {
        throw new Error('LLM JSON missing required keys');
      }

      await LlmCache.findOneAndUpdate(
        { key },
        { key, value: parsed, expiresAt: new Date(Date.now() + config.llm.cacheTtlHours * 3600_000) },
        { upsert: true, new: true }
      );

      return parsed;
    } catch (err) {
      log.warn('LLM summarize failed; skipping', { error: (err as Error).message });
      return null;
    }
  }

  private isValidSummary(v: unknown): v is LlmIssueSummary {
    if (!v || typeof v !== 'object') return false;
    const obj = v as { summary?: unknown; tasks?: unknown; notes?: unknown };
    if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) return false;
    if (!Array.isArray(obj.tasks) || obj.tasks.some(t => typeof t !== 'string')) return false;
    if (obj.notes !== undefined && (!Array.isArray(obj.notes) || obj.notes.some(n => typeof n !== 'string'))) return false;
    return true;
  }
}

export const llmService = LlmService.getInstance();

