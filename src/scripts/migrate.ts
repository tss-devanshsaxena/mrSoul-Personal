/**
 * CE-Tech Automation — Database Migration Runner
 * Usage: npm run migrate
 *
 * Migrations are idempotent — safe to run multiple times.
 * Each migration is tracked in the 'migrations' collection.
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { db } from '../services/database';
import { createLogger } from '../utils/logger';

const log = createLogger('migrate');

// ============================================================
// Migration registry — add new migrations here
// ============================================================
interface Migration {
  id: string;
  description: string;
  up: (db: mongoose.Connection) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    id: '001-initial-indexes',
    description: 'Create initial MongoDB indexes for performance',
    up: async (db) => {
      const issues = db.collection('issues');
      await issues.createIndex({ slackMessageTs: 1, slackChannelId: 1 }, { unique: true });
      await issues.createIndex({ status: 1, createdAt: -1 });
      await issues.createIndex({ 'assignment.primaryOwnerId': 1, status: 1 });
      await issues.createIndex({ 'githubIssue.issueNumber': 1 }, { sparse: true });
      log.info('Created issue indexes');

      const mappings = db.collection('developermappings');
      await mappings.createIndex({ tag: 1 }, { unique: true });
      log.info('Created mapping indexes');

      const dedupe = db.collection('dedupecaches');
      await dedupe.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await dedupe.createIndex({ key: 1 }, { unique: true });
      log.info('Created dedupe cache indexes');
    },
  },
  {
    id: '002-add-resolvedAt-index',
    description: 'Add index on resolvedAt for workload weekly summary',
    up: async (db) => {
      const issues = db.collection('issues');
      await issues.createIndex(
        { resolvedAt: 1 },
        { sparse: true, expireAfterSeconds: 0 }
      );
      log.info('Created resolvedAt index');
    },
  },
  // Future migrations go here:
  // {
  //   id: '003-...',
  //   description: '...',
  //   up: async (db) => { ... },
  // },
];

// ============================================================
// Migration runner
// ============================================================
interface MigrationRecord {
  migrationId: string;
  appliedAt: Date;
  success: boolean;
}

async function runMigrations(): Promise<void> {
  log.info('Starting migration runner...');
  await db.connect();
  const dbConn = mongoose.connection;

  // Ensure migrations collection exists
  const migrationsCollection = dbConn.collection<MigrationRecord>('migrations');
  await migrationsCollection.createIndex({ migrationId: 1 }, { unique: true });

  // Get already-applied migrations
  const applied = await migrationsCollection.find({}).toArray();
  const appliedIds = new Set(applied.filter(m => m.success).map(m => m.migrationId));

  log.info(`Found ${applied.length} previously applied migrations`);

  let ranCount = 0;
  let skippedCount = 0;

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) {
      log.info(`SKIP ${migration.id} — already applied`);
      skippedCount++;
      continue;
    }

    log.info(`RUN  ${migration.id} — ${migration.description}`);

    try {
      await migration.up(dbConn);

      await migrationsCollection.insertOne({
        migrationId: migration.id,
        appliedAt: new Date(),
        success: true,
      });

      log.info(`✅ ${migration.id} completed`);
      ranCount++;
    } catch (err) {
      log.error(`❌ ${migration.id} failed`, { error: (err as Error).message });

      await migrationsCollection.insertOne({
        migrationId: migration.id,
        appliedAt: new Date(),
        success: false,
      });

      await db.disconnect();
      process.exit(1);
    }
  }

  log.info(`Migration complete — ran: ${ranCount}, skipped: ${skippedCount}`);
  await db.disconnect();
}

runMigrations().catch(err => {
  console.error('Migration runner fatal error:', err);
  process.exit(1);
});
