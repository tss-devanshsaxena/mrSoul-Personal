/**
 * Serialize unknown thrown/rejected values for logging (Error JSON.stringify → {}).
 */
export function formatUnknownError(reason: unknown): {
  message: string;
  name?: string;
  code?: string;
  stack?: string;
  data?: unknown;
} {
  if (reason instanceof Error) {
    const err = reason as Error & { code?: string; data?: unknown };
    return {
      message: err.message || String(reason),
      name: err.name,
      code: err.code,
      stack: err.stack,
      data: err.data,
    };
  }

  if (typeof reason === 'string') {
    return { message: reason };
  }

  if (reason && typeof reason === 'object') {
    const obj = reason as Record<string, unknown>;
    const message =
      typeof obj.message === 'string'
        ? obj.message
        : typeof obj.error === 'string'
          ? obj.error
          : JSON.stringify(reason);
    return {
      message,
      code: typeof obj.code === 'string' ? obj.code : undefined,
      data: obj,
    };
  }

  return { message: String(reason) };
}

/** Transient Slack Socket Mode races (duplicate connection, reconnect, ping timeout). */
export function isTransientSlackSocketError(reason: unknown): boolean {
  const { message } = formatUnknownError(reason);
  const lower = message.toLowerCase();
  return (
    lower.includes('server explicit disconnect') ||
    (lower.includes('unhandled event') && lower.includes('connecting')) ||
    lower.includes("pong wasn't received") ||
    lower.includes("ping wasn't received") ||
    lower.includes('server pings not received') ||
    lower.includes('server pongs not received')
  );
}
