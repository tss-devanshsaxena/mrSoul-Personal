import { config } from './config';
import { createLogger } from './utils/logger';
import { formatUnknownError, isTransientSlackSocketError } from './utils/formatError';
import { db } from './services/database';
import { createSlackApp } from './handlers/slackApp';
import { createExpressApp } from './app';
import { routingService } from './services/routing';
import { accessControlService } from './services/accessControl';
import { channelSetupService } from './services/channelSetup';
import { activityFeed } from './services/activityFeed';
import { slackLiveOps } from './services/slackLiveOps';

const log = createLogger('main');

/** ADK Gemini client reads GOOGLE_GENAI_API_KEY / GEMINI_API_KEY from the environment. */
function bootstrapAdkEnv(): void {
  if (config.adk.apiKey && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_API_KEY) {
    process.env.GOOGLE_GENAI_API_KEY = config.adk.apiKey;
  }
}

function registerProcessErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', formatUnknownError(err));
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const details = formatUnknownError(reason);

    if (isTransientSlackSocketError(reason)) {
      log.warn('Slack Socket Mode reconnect (transient)', {
        message: details.message,
        hint:
          'Only one `npm run dev` per app token. Close other terminals, disable VPN sleep, or raise SLACK_SOCKET_PING_TIMEOUT_MS.',
      });
      return;
    }

    log.error('Unhandled rejection', details);
    if (!config.isDev) {
      process.exit(1);
    }
  });
}

registerProcessErrorHandlers();

async function bootstrap(): Promise<void> {
  bootstrapAdkEnv();

  log.info('🚀 Starting CE-Tech Automation Platform', {
    env: config.env,
    adk: config.adk.enabled && Boolean(config.adk.apiKey),
    version: process.env.npm_package_version ?? '1.0.0',
  });

  // 1. Connect to MongoDB
  log.info('Connecting to MongoDB...');
  await db.connect();

  // 2. Seed default routing mappings
  log.info('Seeding default routing mappings...');
  await routingService.seedDefaults();

  log.info('Seeding MrSoul access control...');
  await accessControlService.seedDefaults();

  // 3. Start Express API server
  const expressApp = createExpressApp();
  const onListen = () => {
    log.info(`✅ API server running on port ${config.port}`, {
      health: `http://localhost:${config.port}/health`,
      api: `http://localhost:${config.port}/api`,
      webhooks: `http://localhost:${config.port}/webhooks`,
    });
  };
  const httpServer = config.isProd
    ? expressApp.listen(config.port, '0.0.0.0', onListen)
    : expressApp.listen(config.port, onListen);

  // 4. Start Slack app
  const slackApp = createSlackApp();

  if (config.slack.appToken) {
    // Socket Mode (development-friendly)
    await slackApp.start();
    log.info('✅ Slack app started in Socket Mode');
  } else {
    // HTTP Mode (production)
    await slackApp.start(config.port + 1);
    log.info(`✅ Slack app started on port ${config.port + 1} (HTTP mode)`);
  }

  if (config.slack.postGuidelinesOnStart) {
    channelSetupService.ensureChannelGuidelines().catch(err => {
      log.warn('Channel guidelines setup failed', { error: (err as Error).message });
    });
  }

  slackLiveOps.init();

  log.info('🎯 CE-Tech Automation Platform fully operational', {
    monitoredChannels: config.slack.monitoredChannels,
    postGuidelinesOnStart: config.slack.postGuidelinesOnStart,
    setChannelMetaOnSetup: config.slack.setChannelMetaOnSetup,
    trackerType: config.tracker.type,
    githubRepo: `${config.github.owner}/${config.github.repo}`,
    slackLiveOps: config.slack.liveOpsEnabled,
    prdEnabled: config.prd.enabled,
    claudeHandoff: Boolean(config.slack.claudeBotUserId),
  });

  activityFeed.logBoot();
  activityFeed.emitActivity({
    level: 'info',
    source: 'system',
    title: 'Slack live pipeline ready',
    detail:
      'Issue + PRD updates post in-thread. Set SLACK_CLAUDE_BOT_USER_ID for @Claude handoff.',
  });

  // ---- Graceful shutdown ----
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal} — shutting down gracefully...`);
    await slackApp.stop();
    httpServer.close();
    await db.disconnect();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
