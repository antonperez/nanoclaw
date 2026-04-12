import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  TELEGRAM_BOT_POOL: '',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('https', () => {
  function Agent() {}
  const mod = { globalAgent: {}, Agent };
  return { ...mod, default: mod };
});

import { TelegramChannel } from './telegram.js';
import { logger } from '../logger.js';

function makeChannel(): TelegramChannel {
  return new TelegramChannel('fake-token', { onMessage: vi.fn() } as any);
}

function injectBot(
  channel: TelegramChannel,
  sendChatAction: ReturnType<typeof vi.fn>,
) {
  (channel as any).bot = { api: { sendChatAction } };
}

describe('TelegramChannel.setTyping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sendChatAction with the numeric chat id', async () => {
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const channel = makeChannel();
    injectBot(channel, sendChatAction);

    await channel.setTyping('tg:123456', true);

    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendChatAction).toHaveBeenCalledWith('123456', 'typing');
  });

  it('does nothing when isTyping is false', async () => {
    const sendChatAction = vi.fn();
    const channel = makeChannel();
    injectBot(channel, sendChatAction);

    await channel.setTyping('tg:123456', false);

    expect(sendChatAction).not.toHaveBeenCalled();
  });

  it('does nothing when bot is not connected', async () => {
    const channel = makeChannel();
    // bot is null by default — no inject
    await channel.setTyping('tg:123456', true);
    // no throw, no call
  });

  it('swallows network errors and logs at debug, does not throw', async () => {
    const networkErr = new Error('Network request for sendChatAction failed!');
    const sendChatAction = vi.fn().mockRejectedValue(networkErr);
    const channel = makeChannel();
    injectBot(channel, sendChatAction);

    await expect(channel.setTyping('tg:123456', true)).resolves.toBeUndefined();

    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'tg:123456', err: networkErr }),
      'Failed to send Telegram typing indicator',
    );
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('does not retry — sendChatAction is called exactly once on failure', async () => {
    const sendChatAction = vi
      .fn()
      .mockRejectedValue(new Error('flaky network'));
    const channel = makeChannel();
    injectBot(channel, sendChatAction);

    await channel.setTyping('tg:999', true);

    expect(sendChatAction).toHaveBeenCalledTimes(1);
  });
});
