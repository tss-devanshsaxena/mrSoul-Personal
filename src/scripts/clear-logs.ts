/**
 * Clear local log files + MongoDB issue/audit data (keeps routing mappings).
 *
 * Usage:
 *   npm run logs:clear              # local logs/ only
 *   npm run logs:clear -- --mongo   # also wipe Mongo issue records
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const args = process.argv.slice(2);
const clearMongo = args.includes('--mongo');

async function clearLocalLogs(): Promise<void> {
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    console.log('No logs/ directory.');
    return;
  }

  const files = fs.readdirSync(logsDir);
  let removed = 0;
  for (const f of files) {
    const full = path.join(logsDir, f);
    if (fs.statSync(full).isFile()) {
      fs.unlinkSync(full);
      removed += 1;
      console.log(`  removed ${f}`);
    }
  }
  console.log(`Local logs: ${removed} file(s) deleted.`);
}

async function clearMongoData(): Promise<void> {
  const { db } = await import('../services/database');
  const { Issue, DedupeCache, LlmCache, LlmUsage } = await import('../models');

  await db.connect();

  const [issues, dedupe, llmCache, llmUsage] = await Promise.all([
    Issue.deleteMany({}),
    DedupeCache.deleteMany({}),
    LlmCache.deleteMany({}),
    LlmUsage.deleteMany({}),
  ]);

  console.log('MongoDB cleared:');
  console.log(`  issues: ${issues.deletedCount}`);
  console.log(`  dedupe: ${dedupe.deletedCount}`);
  console.log(`  llm cache: ${llmCache.deletedCount}`);
  console.log(`  llm usage: ${llmUsage.deletedCount}`);
  console.log('  (routing mappings kept)');

  await db.disconnect();
}

(async () => {
  console.log('Clearing local log files…');
  await clearLocalLogs();

  if (clearMongo) {
    console.log('\nClearing MongoDB issue/audit data…');
    await clearMongoData();
  } else {
    console.log('\nSkip MongoDB (pass --mongo to clear issue records + audit logs in DB).');
  }

  console.log('\nDone.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
