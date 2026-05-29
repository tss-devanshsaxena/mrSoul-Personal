/**
 * Routing maintenance — deactivate legacy test mappings.
 * Add real mappings via REST API or MongoDB, not hardcoded dummy names.
 *
 * Usage: npm run seed
 */

import dotenv from 'dotenv';
dotenv.config();

import { db } from '../services/database';
import { routingService } from '../services/routing';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withNetworkRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const retryable =
        /ENETUNREACH|MongoNetworkError|ETIMEDOUT|ECONNREFUSED|socket hang up/i.test(lastError.message);
      if (!retryable || i === attempts) break;
      const delay = 1500 * i;
      console.warn(`${label} failed (attempt ${i}/${attempts}): ${lastError.message}. Retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function printNetworkHelp(): void {
  console.error(`
Cannot reach MongoDB Atlas from this machine (ENETUNREACH / network error).

Try:
  • Stable Wi‑Fi or VPN (corporate networks often block MongoDB port 27017)
  • Atlas → Network Access → add your current IP (or 0.0.0.0/0 for dev only)
  • Run \`npm run dev\` — if the app connects, legacy test mappings are deactivated on startup automatically

You do not need \`npm run seed\` if the dev server already shows "MongoDB connected".
`);
}

async function seed() {
  console.log('Connecting to MongoDB...');
  await withNetworkRetry('Connect', () => db.connect());

  const deactivated = await withNetworkRetry('Deactivate legacy mappings', () =>
    routingService.deactivateLegacyTestMappings()
  );

  console.log(`\n✅ Deactivated ${deactivated} legacy test mapping(s) (Rahul/Devansh/Aman/Naman placeholders).\n`);
  console.log('Add real hashtag → owner mappings, for example:');
  console.log('  PUT /api/routing');
  console.log('  Body: { "tag": "#refund", "primaryOwner": "U…", "primaryOwnerName": "…", "githubUsername": "tss-…" }\n');

  await db.disconnect();
}

seed().catch(err => {
  const msg = (err as Error).message ?? String(err);
  if (/ENETUNREACH|MongoNetworkError|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
    printNetworkHelp();
  } else {
    console.error('Seed failed:', err);
  }
  process.exit(1);
});
