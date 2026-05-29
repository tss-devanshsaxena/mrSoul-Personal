import { DeveloperMappingModel } from '../models';
import { DeveloperMapping, IssueAssignment, ParsedSlackMessage } from '../types';
import { createLogger } from '../utils/logger';
import { config } from '../config';

const log = createLogger('routing');

/** Placeholder Slack IDs from early test seeds — never suggest these. */
const LEGACY_PLACEHOLDER_SLACK_IDS = new Set([
  'U_RAHUL',
  'U_DEVANSH',
  'U_AMAN',
  'U_NAMAN',
  'U_DEFAULT',
  'U_RAHUL_PLACEHOLDER',
  'U_DEVANSH_PLACEHOLDER',
  'U_AMAN_PLACEHOLDER',
  'U_NAMAN_PLACEHOLDER',
]);

/** Fake GitHub logins from test seed script — not real team members. */
const LEGACY_PLACEHOLDER_GITHUB = new Set([
  'rahul',
  'devansh',
  'aman',
  'naman',
  'engineering',
]);

function isLegacyTestMapping(doc: {
  primaryOwner?: string;
  githubUsername?: string;
}): boolean {
  const slack = doc.primaryOwner ?? '';
  const gh = (doc.githubUsername ?? '').toLowerCase();
  if (LEGACY_PLACEHOLDER_SLACK_IDS.has(slack)) return true;
  if (slack.endsWith('_PLACEHOLDER')) return true;
  if (LEGACY_PLACEHOLDER_GITHUB.has(gh)) return true;
  return false;
}

function unassignedAssignment(resolvedFromTags: string[] = []): IssueAssignment {
  const fallback = config.github.fallbackAssignee?.trim();
  if (fallback) {
    return {
      primaryOwnerId: 'unassigned',
      primaryOwnerName: fallback,
      secondaryOwnerIds: [],
      githubUsername: fallback,
      resolvedFromTags,
    };
  }
  return {
    primaryOwnerId: 'unassigned',
    primaryOwnerName: 'Unassigned',
    secondaryOwnerIds: [],
    githubUsername: '',
    resolvedFromTags,
  };
}

export class RoutingService {
  private static instance: RoutingService;
  private cache: Map<string, DeveloperMapping> = new Map();
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  static getInstance(): RoutingService {
    if (!RoutingService.instance) {
      RoutingService.instance = new RoutingService();
    }
    return RoutingService.instance;
  }

  /**
   * Prefer triage assignee; else hashtag routing; else env fallback.
   */
  async resolveAssignmentForIssue(
    message: ParsedSlackMessage,
    triageAssignment: IssueAssignment
  ): Promise<IssueAssignment> {
    if (triageAssignment.githubUsername?.trim()) {
      return triageAssignment;
    }
    const routed = await this.resolveAssignment(message);
    if (routed.githubUsername?.trim()) {
      return routed;
    }
    return triageAssignment;
  }

  /** Whether a hashtag has an active, inactive, or missing routing row. */
  async getTagRoutingStatus(tag: string): Promise<'active' | 'inactive' | 'missing'> {
    const normalized = tag.startsWith('#') ? tag.toLowerCase() : `#${tag.toLowerCase()}`;
    const doc = await DeveloperMappingModel.findOne({ tag: normalized });
    if (!doc) return 'missing';
    if (!doc.active || isLegacyTestMapping(doc)) return 'inactive';
    return 'active';
  }

  /**
   * Resolve assignment from hashtags. First matching active mapping wins.
   * If no match, returns unassigned (optional GITHUB_FALLBACK_ASSIGNEE only).
   */
  async resolveAssignment(message: ParsedSlackMessage): Promise<IssueAssignment> {
    const mappings = await this.getAllMappings();
    const resolvedFromTags: string[] = [];

    for (const tag of message.hashtags) {
      const mapping = mappings.get(tag);
      if (mapping?.active) {
        log.info('Resolved assignment', {
          hashtags: message.hashtags,
          resolvedFromTags: [tag],
          primaryOwnerName: mapping.primaryOwnerName,
        });
        return {
          primaryOwnerId: mapping.primaryOwner,
          primaryOwnerName: mapping.primaryOwnerName,
          secondaryOwnerIds: mapping.secondaryOwners,
          githubUsername: mapping.githubUsername,
          resolvedFromTags: [tag],
        };
      }
    }

    log.info('No routing match for hashtags', { hashtags: message.hashtags });
    return unassignedAssignment(resolvedFromTags);
  }

  /**
   * Get all active mappings (cached). Legacy test rows are excluded.
   */
  async getAllMappings(): Promise<Map<string, DeveloperMapping>> {
    if (Date.now() < this.cacheExpiry && this.cache.size > 0) {
      return this.cache;
    }

    try {
      const docs = await DeveloperMappingModel.find({ active: true });
      this.cache.clear();

      docs.forEach(doc => {
        if (isLegacyTestMapping(doc)) return;
        this.cache.set(doc.tag, {
          tag: doc.tag,
          primaryOwner: doc.primaryOwner,
          primaryOwnerName: doc.primaryOwnerName,
          secondaryOwners: doc.secondaryOwners,
          githubUsername: doc.githubUsername,
          notionUserId: doc.notionUserId,
          active: doc.active,
        });
      });

      this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;
      log.debug('Refreshed routing cache', { count: this.cache.size });
    } catch (err) {
      log.error('Failed to load routing mappings', { error: (err as Error).message });
    }

    return this.cache;
  }

  /**
   * Upsert a developer mapping.
   */
  async upsertMapping(mapping: Omit<DeveloperMapping, 'active'> & { active?: boolean }): Promise<void> {
    await DeveloperMappingModel.findOneAndUpdate(
      { tag: mapping.tag.toLowerCase() },
      { ...mapping, active: mapping.active ?? true },
      { upsert: true, new: true }
    );
    this.invalidateCache();
    log.info('Updated mapping', { tag: mapping.tag, owner: mapping.primaryOwnerName });
  }

  /**
   * Disable placeholder mappings from early test seeds (idempotent).
   */
  async deactivateLegacyTestMappings(): Promise<number> {
    const docs = await DeveloperMappingModel.find({ active: true });
    let deactivated = 0;

    for (const doc of docs) {
      if (!isLegacyTestMapping(doc)) continue;
      doc.active = false;
      await doc.save();
      deactivated += 1;
      log.info('Deactivated legacy test mapping', {
        tag: doc.tag,
        githubUsername: doc.githubUsername,
      });
    }

    if (deactivated > 0) {
      this.invalidateCache();
    }
    return deactivated;
  }

  /**
   * On startup: remove test mappings only. Real mappings are added via API or `npm run seed`.
   */
  async seedDefaults(): Promise<void> {
    const n = await this.deactivateLegacyTestMappings();
    if (n > 0) {
      log.info('Legacy test routing mappings deactivated', { count: n });
    }
  }

  invalidateCache(): void {
    this.cacheExpiry = 0;
    this.cache.clear();
  }
}

export const routingService = RoutingService.getInstance();
