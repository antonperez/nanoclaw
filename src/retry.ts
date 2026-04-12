import { GrammyError, HttpError } from 'grammy';

import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

/**
 * Retry an async operation with exponential backoff and jitter.
 * Retries on network errors, HttpError, and Telegram 429/5xx responses.
 * Does NOT retry on 400/401/403 (client errors that won't recover).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    label = 'operation',
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts;

      let shouldRetry = false;
      if (err instanceof HttpError) {
        // Network-level failure (no valid HTTP response) — always retry
        shouldRetry = true;
      } else if (err instanceof GrammyError) {
        const code = err.error_code;
        // 429 = rate limit, 5xx = server errors
        shouldRetry = code === 429 || code >= 500;
        // 400, 401, 403 won't recover — fall through to rethrow
      } else if (err instanceof Error) {
        const code = (err as NodeJS.ErrnoException).code;
        shouldRetry = code === 'ECONNRESET' || code === 'ETIMEDOUT';
      }

      if (!shouldRetry || isLastAttempt) {
        if (isLastAttempt && shouldRetry) {
          logger.error(
            { label, attempt, err },
            `${label}: all ${maxAttempts} attempts failed`,
          );
        }
        throw err;
      }

      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1),
        maxDelayMs,
      );
      const jitteredDelay = Math.round(delay * (0.75 + Math.random() * 0.5));
      const errMsg = err instanceof Error ? err.message : String(err);
      const innerErr =
        err instanceof HttpError
          ? (err.error as Record<string, unknown>)
          : null;
      const cause = innerErr
        ? {
            message: (innerErr.message as string) || undefined,
            code: (innerErr.code as string) || undefined,
            type: (innerErr.type as string) || undefined,
            errno: (innerErr.errno as string) || undefined,
          }
        : undefined;
      logger.warn(
        {
          label,
          attempt,
          nextAttemptIn: jitteredDelay,
          err: errMsg,
          ...(cause && { cause }),
        },
        `${label}: attempt ${attempt} failed, retrying in ${jitteredDelay}ms`,
      );
      await new Promise((r) => setTimeout(r, jitteredDelay));
    }
  }
  /* istanbul ignore next */
  throw new Error(`${label}: unreachable`);
}
