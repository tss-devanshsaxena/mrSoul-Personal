import mongoose, { ConnectOptions } from 'mongoose';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('database');

/** Prefer IPv4 — avoids intermittent ENETUNREACH on some Mac/Wi‑Fi setups. */
export const MONGODB_CONNECT_OPTIONS: ConnectOptions = {
  family: 4,
  serverSelectionTimeoutMS: 30_000,
  socketTimeoutMS: 45_000,
  maxPoolSize: 10,
};

const MAX_CONNECT_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectWithRetry(uri: string): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(uri, MONGODB_CONNECT_OPTIONS);
      return;
    } catch (err) {
      lastError = err as Error;
      const delay = Math.min(1000 * attempt, 5000);
      log.warn(`MongoDB connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed`, {
        error: lastError.message,
        retryInMs: attempt < MAX_CONNECT_ATTEMPTS ? delay : undefined,
      });
      if (attempt < MAX_CONNECT_ATTEMPTS) {
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

class Database {
  private static instance: Database;
  private connected = false;

  static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  async connect(): Promise<void> {
    if (this.connected && mongoose.connection.readyState === 1) {
      return;
    }

    mongoose.set('strictQuery', true);

    await connectWithRetry(config.mongodb.uri);
    this.connected = true;

    log.info('MongoDB connected', { uri: config.mongodb.uri.replace(/\/\/.*@/, '//***@') });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    await mongoose.disconnect();
    this.connected = false;
    log.info('MongoDB disconnected');
  }

  isConnected(): boolean {
    return mongoose.connection.readyState === 1;
  }
}

export const db = Database.getInstance();
