import { StoreOwner, StoreOwnerDoc } from '../models';
import { createLogger } from '../utils/logger';

const log = createLogger('storeOwner');

export interface StoreOwnerInput {
  storeId: string;
  storeLocation: string;
  userName?: string;
  name: string;
  phone?: string;
  email: string;
  active?: boolean;
}

export interface StoreOwnerView {
  id: string;
  storeId: string;
  storeLocation: string;
  userName: string;
  name: string;
  phone: string;
  email: string;
  active: boolean;
  slackUserId?: string;
  lastOutreachAt?: string;
  lastOutreachDate?: string;
  lastOutreachError?: string;
  createdAt?: string;
  updatedAt?: string;
}

function toView(doc: StoreOwnerDoc): StoreOwnerView {
  return {
    id: doc.id,
    storeId: doc.storeId,
    storeLocation: doc.storeLocation,
    userName: doc.userName,
    name: doc.name,
    phone: doc.phone ?? '',
    email: doc.email,
    active: doc.active,
    slackUserId: doc.slackUserId,
    lastOutreachAt: doc.lastOutreachAt?.toISOString(),
    lastOutreachDate: doc.lastOutreachDate,
    lastOutreachError: doc.lastOutreachError,
    createdAt: (doc as { createdAt?: Date }).createdAt?.toISOString(),
    updatedAt: (doc as { updatedAt?: Date }).updatedAt?.toISOString(),
  };
}

export class StoreOwnerService {
  async list(): Promise<StoreOwnerView[]> {
    const docs = await StoreOwner.find().sort({ storeId: 1 }).lean(false);
    return docs.map(toView);
  }

  async getByStoreId(storeId: string): Promise<StoreOwnerView | null> {
    const doc = await StoreOwner.findOne({ storeId: storeId.trim() });
    return doc ? toView(doc) : null;
  }

  async create(input: StoreOwnerInput): Promise<StoreOwnerView> {
    const storeId = input.storeId.trim();
    const existing = await StoreOwner.findOne({ storeId });
    if (existing) {
      throw new Error(`Store owner with id "${storeId}" already exists`);
    }

    const email = input.email.trim().toLowerCase();
    const doc = await StoreOwner.create({
      storeId,
      storeLocation: input.storeLocation.trim(),
      userName: (input.userName?.trim() || email.split('@')[0] || 'user'),
      name: input.name.trim(),
      phone: (input.phone ?? '').trim(),
      email,
      active: input.active ?? true,
    });

    log.info('Created store owner', { storeId });
    return toView(doc);
  }

  async update(storeId: string, input: Partial<StoreOwnerInput>): Promise<StoreOwnerView> {
    const doc = await StoreOwner.findOne({ storeId: storeId.trim() });
    if (!doc) {
      throw new Error(`Store owner "${storeId}" not found`);
    }

    if (input.storeLocation !== undefined) doc.storeLocation = input.storeLocation.trim();
    if (input.userName !== undefined) doc.userName = input.userName.trim();
    if (input.name !== undefined) doc.name = input.name.trim();
    if (input.phone !== undefined) doc.phone = input.phone.trim();
    if (input.email !== undefined) doc.email = input.email.trim().toLowerCase();
    if (input.active !== undefined) doc.active = input.active;

    await doc.save();
    log.info('Updated store owner', { storeId: doc.storeId });
    return toView(doc);
  }

  async remove(storeId: string): Promise<boolean> {
    const result = await StoreOwner.deleteOne({ storeId: storeId.trim() });
    return result.deletedCount > 0;
  }

  async bulkImport(
    rows: StoreOwnerInput[],
    opts?: { updateExisting?: boolean }
  ): Promise<{ created: number; updated: number; failed: Array<{ row: number; storeId: string; error: string }> }> {
    const result = { created: 0, updated: 0, failed: [] as Array<{ row: number; storeId: string; error: string }> };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const storeId = row.storeId?.trim();
      if (!storeId) {
        result.failed.push({ row: i + 1, storeId: '', error: 'Missing storeId' });
        continue;
      }

      try {
        const existing = await StoreOwner.findOne({ storeId });
        if (existing) {
          if (!opts?.updateExisting) {
            result.failed.push({ row: i + 1, storeId, error: 'Already exists' });
            continue;
          }
          await this.update(storeId, row);
          result.updated += 1;
        } else {
          await this.create(row);
          result.created += 1;
        }
      } catch (err) {
        result.failed.push({ row: i + 1, storeId, error: (err as Error).message });
      }
    }

    log.info('Bulk import complete', result);
    return result;
  }

  async getStats(): Promise<{ total: number; active: number; withErrors: number }> {
    const [total, active, withErrors] = await Promise.all([
      StoreOwner.countDocuments(),
      StoreOwner.countDocuments({ active: true }),
      StoreOwner.countDocuments({ lastOutreachError: { $exists: true, $ne: '' } }),
    ]);
    return { total, active, withErrors };
  }

  async recordOutreach(
    storeId: string,
    data: {
      slackUserId: string;
      channelId: string;
      messageTs: string;
      outreachDate: string;
      error?: string;
    }
  ): Promise<void> {
    await StoreOwner.updateOne(
      { storeId },
      {
        slackUserId: data.slackUserId,
        lastChannelId: data.channelId,
        lastMessageTs: data.messageTs,
        lastOutreachAt: new Date(),
        lastOutreachDate: data.outreachDate,
        lastOutreachError: data.error,
      }
    );
  }
}

export const storeOwnerService = new StoreOwnerService();
