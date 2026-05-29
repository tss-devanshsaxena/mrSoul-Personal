import SocketModeReceiver from '@slack/bolt/dist/receivers/SocketModeReceiver';
import { ConsoleLogger, LogLevel } from '@slack/logger';
import { SocketModeClient } from '@slack/socket-mode';
import { config } from '../config';
import { isTransientSlackSocketError } from '../utils/formatError';

const socketLogger = new ConsoleLogger();
socketLogger.setName('socket-mode');
socketLogger.setLevel(LogLevel.WARN);

/**
 * Bolt's default Socket Mode client uses a 5s client ping timeout, which reconnects
 * often on slow/VPN networks. Use a longer timeout and quieter logs.
 */
export function createSocketModeReceiver(): SocketModeReceiver {
  const appToken = config.slack.appToken;
  if (!appToken) {
    throw new Error('SLACK_APP_TOKEN is required for Socket Mode');
  }

  const receiver = new SocketModeReceiver({
    appToken,
    logger: socketLogger,
    logLevel: LogLevel.WARN,
  });

  const timeoutMs = config.slack.socketPingTimeoutMs;
  const previousClient = receiver.client;

  const client = new SocketModeClient({
    appToken,
    logger: socketLogger,
    logLevel: LogLevel.WARN,
    clientPingTimeout: timeoutMs,
    serverPingTimeout: timeoutMs,
    autoReconnectEnabled: true,
  });

  for (const eventName of previousClient.eventNames()) {
    for (const listener of previousClient.listeners(eventName)) {
      client.on(eventName, listener as (...args: unknown[]) => void);
    }
  }
  previousClient.removeAllListeners();

  receiver.client = client;

  client.on('error', (err: unknown) => {
    if (isTransientSlackSocketError(err)) return;
    socketLogger.error(err);
  });

  client.on('disconnect', () => {
    socketLogger.debug('Socket Mode disconnected');
  });

  return receiver;
}
