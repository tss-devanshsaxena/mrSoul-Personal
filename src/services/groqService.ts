import axios from 'axios';
import { z } from 'zod';
import { config } from '../config';
import { LlmUsage } from '../models';
import { createLogger } from '../utils/logger';

const log = createLogger('groq');

const GROQ_BASE = 'https://api.groq.com/openai/v1';

function todayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class GroqService {
  private static instance: GroqService;

  static getInstance(): GroqService {
    if (!GroqService.instance) {
      GroqService.instance = new GroqService();
    }
    return GroqService.instance;
  }

  isEnabled(): boolean {
    return config.groq.enabled && Boolean(config.groq.apiKey);
  }

  private async consumeBudget(): Promise<boolean> {
    const day = todayKey();
    const usage = await LlmUsage.findOneAndUpdate(
      { day },
      { $inc: { count: 1 }, $setOnInsert: { day } },
      { upsert: true, new: true }
    );
    if ((usage?.count ?? 0) > config.groq.maxCallsPerDay) {
      log.warn('Groq daily budget exceeded', { day, max: config.groq.maxCallsPerDay });
      return false;
    }
    return true;
  }

  async chat(
    system: string,
    user: string,
    opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean; skipBudget?: boolean }
  ): Promise<string | null> {
    if (!this.isEnabled()) return null;
    if (!opts?.skipBudget && !(await this.consumeBudget())) return null;

    try {
      const res = await axios.post(
        `${GROQ_BASE}/chat/completions`,
        {
          model: config.groq.model,
          temperature: opts?.temperature ?? 0.3,
          max_tokens: opts?.maxTokens ?? config.groq.maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          ...(opts?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        },
        {
          headers: {
            Authorization: `Bearer ${config.groq.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: config.groq.timeoutMs,
        }
      );

      const content = res.data?.choices?.[0]?.message?.content;
      return typeof content === 'string' && content.trim() ? content.trim() : null;
    } catch (err) {
      log.warn('Groq chat failed', { error: (err as Error).message });
      return null;
    }
  }

  async chatJson<T>(
    system: string,
    user: string,
    schema: z.ZodType<T>
  ): Promise<T | null> {
    const raw = await this.chat(system, user, { jsonMode: true, maxTokens: 4096 });
    if (!raw) return null;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const candidate = jsonMatch ? jsonMatch[0] : raw;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const result = schema.safeParse(parsed);
      if (!result.success) {
        log.warn('Groq JSON schema validation failed', { issues: result.error.issues.slice(0, 3) });
        return null;
      }
      return result.data;
    } catch {
      log.warn('Groq JSON parse failed');
      return null;
    }
  }
}

export const groqService = GroqService.getInstance();
