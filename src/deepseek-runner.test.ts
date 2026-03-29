import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  DEEPSEEK_API_KEY: 'test-api-key',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
  DEEPSEEK_MODEL: 'deepseek-chat',
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { runDeepSeekAgent } from './deepseek-runner.js';
import type { NewMessage } from './types.js';

function makeMsg(content: string, is_from_me = false): NewMessage {
  return {
    id: `msg-${Math.random()}`,
    chat_jid: 'test@g.us',
    sender: is_from_me ? 'me' : 'user',
    sender_name: is_from_me ? 'Andy' : 'User',
    content,
    timestamp: new Date().toISOString(),
    is_from_me,
  };
}

function deepseekOk(text: string): object {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => '',
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('runDeepSeekAgent — success path', () => {
  it('calls onOutput with response text and returns success', async () => {
    mockFetch.mockResolvedValueOnce(deepseekOk('Hello from DeepSeek'));
    const onOutput = vi.fn(async () => {});
    const result = await runDeepSeekAgent(
      [makeMsg('hello')],
      'Andy',
      '/workspace/groups/test',
      onOutput,
    );
    expect(result).toBe('success');
    expect(onOutput).toHaveBeenCalledWith('Hello from DeepSeek');
  });

  it('sends x-api-key header with the configured key', async () => {
    mockFetch.mockResolvedValueOnce(deepseekOk('ok'));
    await runDeepSeekAgent([makeMsg('hi')], 'Andy', '/tmp', vi.fn(async () => {}));
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('test-api-key');
  });

  it('sends anthropic-version header', async () => {
    mockFetch.mockResolvedValueOnce(deepseekOk('ok'));
    await runDeepSeekAgent([makeMsg('hi')], 'Andy', '/tmp', vi.fn(async () => {}));
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('maps is_from_me messages to assistant role', async () => {
    mockFetch.mockResolvedValueOnce(deepseekOk('ok'));
    await runDeepSeekAgent(
      [makeMsg('user msg', false), makeMsg('bot reply', true)],
      'Andy',
      '/tmp',
      vi.fn(async () => {}),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[1].role).toBe('assistant');
  });

  it('filters out empty messages before sending', async () => {
    mockFetch.mockResolvedValueOnce(deepseekOk('ok'));
    await runDeepSeekAgent(
      [makeMsg('real message'), makeMsg('   '), makeMsg('')],
      'Andy',
      '/tmp',
      vi.fn(async () => {}),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe('real message');
  });

  it('does not call onOutput when response text is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '   ' }] }),
    });
    const onOutput = vi.fn(async () => {});
    await runDeepSeekAgent([makeMsg('hi')], 'Andy', '/tmp', onOutput);
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('concatenates multiple text blocks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
      }),
    });
    const onOutput = vi.fn(async () => {});
    await runDeepSeekAgent([makeMsg('hi')], 'Andy', '/tmp', onOutput);
    expect(onOutput).toHaveBeenCalledWith('Part one. Part two.');
  });

  it('ignores non-text content blocks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          { type: 'tool_use', id: 'x', input: {} },
          { type: 'text', text: 'Final answer' },
        ],
      }),
    });
    const onOutput = vi.fn(async () => {});
    await runDeepSeekAgent([makeMsg('hi')], 'Andy', '/tmp', onOutput);
    expect(onOutput).toHaveBeenCalledWith('Final answer');
  });

  it('includes assistant name in system prompt', async () => {
    mockFetch.mockResolvedValueOnce(deepseekOk('ok'));
    await runDeepSeekAgent([makeMsg('hi')], 'Claw', '/tmp', vi.fn(async () => {}));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.system).toContain('Claw');
  });
});

describe('runDeepSeekAgent — error handling', () => {
  it('returns error when DEEPSEEK_API_KEY is not set', async () => {
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DEEPSEEK_MODEL: 'deepseek-chat',
    }));
    const { runDeepSeekAgent: run } = await import('./deepseek-runner.js');
    const result = await run([makeMsg('hi')], 'Andy', '/tmp', vi.fn(async () => {}));
    expect(result).toBe('error');
    vi.resetModules();
  });

  it('returns error on HTTP error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
    });
    const result = await runDeepSeekAgent([makeMsg('hi')], 'Andy', '/tmp', vi.fn(async () => {}));
    expect(result).toBe('error');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await runDeepSeekAgent([makeMsg('hi')], 'Andy', '/tmp', vi.fn(async () => {}));
    expect(result).toBe('error');
  });

  it('returns error when API response contains error field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [],
        error: { message: 'Invalid request' },
      }),
    });
    const result = await runDeepSeekAgent([makeMsg('hi')], 'Andy', '/tmp', vi.fn(async () => {}));
    expect(result).toBe('error');
  });
});
