import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrammyError, HttpError } from 'grammy';

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

// Suppress backoff delays in all tests
vi.stubGlobal('setTimeout', (fn: () => void) => {
  fn();
  return 0 as any;
});

import { withRetry } from './retry.js';
import { logger } from './logger.js';

// Helper: build a GrammyError with a given error_code
function makeGrammyError(error_code: number): GrammyError {
  return new GrammyError(
    `Telegram error ${error_code}`,
    { ok: false, error_code, description: `error ${error_code}` },
    '',
    {},
  );
}

// Helper: build an HttpError (network-level, no HTTP response)
function makeHttpError(): HttpError {
  return new HttpError('Network request failed', new Error('socket hang up'));
}

// Helper: build a node network error (ECONNRESET, etc.)
function makeNodeError(code: string): Error {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('withRetry', () => {
  describe('success path', () => {
    it('returns the value immediately when fn succeeds on first try', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await withRetry(fn, { label: 'test' });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns the value after a retryable failure followed by success', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(makeHttpError())
        .mockResolvedValue('recovered');
      const result = await withRetry(fn, { label: 'test', baseDelayMs: 0 });
      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('non-retryable errors', () => {
    it('does not retry GrammyError 400 (bad request)', async () => {
      const err = makeGrammyError(400);
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, { label: 'test' })).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry GrammyError 401 (unauthorized)', async () => {
      const err = makeGrammyError(401);
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, { label: 'test' })).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry GrammyError 403 (forbidden)', async () => {
      const err = makeGrammyError(403);
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, { label: 'test' })).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry a generic Error with no code', async () => {
      const err = new Error('something else');
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, { label: 'test' })).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryable errors', () => {
    it('retries on HttpError up to maxAttempts', async () => {
      const err = makeHttpError();
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'test', maxAttempts: 3, baseDelayMs: 0 }),
      ).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries on GrammyError 429 (rate limit)', async () => {
      const err = makeGrammyError(429);
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'test', maxAttempts: 3, baseDelayMs: 0 }),
      ).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries on GrammyError 500', async () => {
      const err = makeGrammyError(500);
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'test', maxAttempts: 3, baseDelayMs: 0 }),
      ).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries on GrammyError 502', async () => {
      const err = makeGrammyError(502);
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'test', maxAttempts: 2, baseDelayMs: 0 }),
      ).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on ECONNRESET', async () => {
      const err = makeNodeError('ECONNRESET');
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'test', maxAttempts: 3, baseDelayMs: 0 }),
      ).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries on ETIMEDOUT', async () => {
      const err = makeNodeError('ETIMEDOUT');
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'test', maxAttempts: 3, baseDelayMs: 0 }),
      ).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('logging', () => {
    it('logs warn on each retry attempt', async () => {
      const err = makeHttpError();
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'myOp', maxAttempts: 3, baseDelayMs: 0 }),
      ).rejects.toThrow();
      // 2 warn calls: attempt 1 and 2 (attempt 3 is the last — logged as error)
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'myOp', attempt: 1 }),
        expect.stringContaining('attempt 1 failed'),
      );
    });

    it('logs error on final failed attempt', async () => {
      const err = makeHttpError();
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'myOp', maxAttempts: 2, baseDelayMs: 0 }),
      ).rejects.toThrow();
      expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'myOp', attempt: 2 }),
        expect.stringContaining('all 2 attempts failed'),
      );
    });

    it('logs underlying cause from HttpError.error', async () => {
      const err = makeHttpError(); // wraps Error('socket hang up')
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        withRetry(fn, { label: 'myOp', maxAttempts: 2, baseDelayMs: 0 }),
      ).rejects.toThrow();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'myOp',
          attempt: 1,
          cause: expect.objectContaining({ message: 'socket hang up' }),
        }),
        expect.stringContaining('attempt 1 failed'),
      );
    });

    it('does not log error for non-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(makeGrammyError(400));
      await expect(withRetry(fn, { label: 'test' })).rejects.toThrow();
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });
  });

  describe('defaults', () => {
    it('defaults to maxAttempts=5', async () => {
      const fn = vi.fn().mockRejectedValue(makeHttpError());
      await expect(withRetry(fn, { baseDelayMs: 0 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(5);
    });
  });
});
