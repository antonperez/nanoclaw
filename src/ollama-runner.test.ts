import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// --- Mocks ---

const { mockReaddirSync, mockReadFileSync } = vi.hoisted(() => ({
  mockReaddirSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
  },
}));

vi.mock('./config.js', () => ({
  OLLAMA_HOST: 'http://localhost:11434',
  OLLAMA_DEFAULT_MODEL: 'test-model',
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { runOllamaAgent } from './ollama-runner.js';
import type { NewMessage } from './types.js';

const GROUP_DIR = '/workspace/groups/test_group';

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

function ollamaReply(content: string): object {
  return {
    ok: true,
    json: async () => ({ message: { role: 'assistant', content }, done: true }),
  };
}

function ollamaToolCall(name: string, args: Record<string, string>): object {
  return {
    ok: true,
    json: async () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name, arguments: args } }],
      },
      done: true,
    }),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockReaddirSync.mockReset();
  mockReadFileSync.mockReset();
  // Default: no md files
  mockReaddirSync.mockReturnValue([]);
});

// --- runOllamaAgent ---

describe('runOllamaAgent — basic response', () => {
  it('calls onOutput with the model reply and returns success', async () => {
    mockFetch.mockResolvedValueOnce(ollamaReply('Here is my answer'));
    const onOutput = vi.fn(async () => {});
    const result = await runOllamaAgent(
      [makeMsg('What is 2+2?')],
      'Andy',
      GROUP_DIR,
      onOutput,
    );
    expect(result).toBe('success');
    expect(onOutput).toHaveBeenCalledWith('Here is my answer');
  });

  it('returns error when Ollama HTTP request fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Error',
    });
    const result = await runOllamaAgent(
      [makeMsg('hello')],
      'Andy',
      GROUP_DIR,
      vi.fn(async () => {}),
    );
    expect(result).toBe('error');
  });

  it('returns error when fetch throws (network failure)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await runOllamaAgent(
      [makeMsg('hello')],
      'Andy',
      GROUP_DIR,
      vi.fn(async () => {}),
    );
    expect(result).toBe('error');
  });

  it('returns error when Ollama response contains error field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: '' },
        done: true,
        error: 'model not found',
      }),
    });
    const result = await runOllamaAgent(
      [makeMsg('hello')],
      'Andy',
      GROUP_DIR,
      vi.fn(async () => {}),
    );
    expect(result).toBe('error');
  });

  it('does not call onOutput when response content is empty', async () => {
    mockFetch.mockResolvedValueOnce(ollamaReply('   '));
    const onOutput = vi.fn(async () => {});
    await runOllamaAgent([makeMsg('hello')], 'Andy', GROUP_DIR, onOutput);
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('maps is_from_me messages to assistant role', async () => {
    mockFetch.mockResolvedValueOnce(ollamaReply('ok'));
    await runOllamaAgent(
      [makeMsg('user msg', false), makeMsg('bot reply', true)],
      'Andy',
      GROUP_DIR,
      vi.fn(async () => {}),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const roles = body.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });
});

// --- read_file tool ---

describe('runOllamaAgent — read_file tool', () => {
  it('reads a .md file and continues conversation', async () => {
    mockFetch
      .mockResolvedValueOnce(ollamaToolCall('read_file', { path: 'TASKS.md' }))
      .mockResolvedValueOnce(ollamaReply('Based on your tasks...'));

    mockReadFileSync.mockReturnValue('- [ ] Buy milk');

    const onOutput = vi.fn(async () => {});
    const result = await runOllamaAgent(
      [makeMsg('what are my tasks?')],
      'Andy',
      GROUP_DIR,
      onOutput,
    );
    expect(result).toBe('success');
    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.resolve(GROUP_DIR, 'TASKS.md'),
      'utf8',
    );
    expect(onOutput).toHaveBeenCalledWith('Based on your tasks...');
  });

  it('rejects path traversal attempts', async () => {
    mockFetch
      .mockResolvedValueOnce(
        ollamaToolCall('read_file', { path: '../../etc/passwd.md' }),
      )
      .mockResolvedValueOnce(ollamaReply('ok'));

    await runOllamaAgent(
      [makeMsg('hack')],
      'Andy',
      GROUP_DIR,
      vi.fn(async () => {}),
    );

    // The tool result pushed into conversation should contain the error
    const secondCall = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMsg = secondCall.messages.find(
      (m: { role: string }) => m.role === 'tool',
    );
    expect(toolMsg.content).toMatch(/path traversal not allowed/);
  });

  it('rejects non-.md file reads', async () => {
    mockFetch
      .mockResolvedValueOnce(
        ollamaToolCall('read_file', { path: 'secrets.env' }),
      )
      .mockResolvedValueOnce(ollamaReply('ok'));

    await runOllamaAgent(
      [makeMsg('read env')],
      'Andy',
      GROUP_DIR,
      vi.fn(async () => {}),
    );

    const secondCall = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMsg = secondCall.messages.find(
      (m: { role: string }) => m.role === 'tool',
    );
    expect(toolMsg.content).toMatch(/only .md files/);
  });

  it('returns error message for unknown tools', async () => {
    mockFetch
      .mockResolvedValueOnce(ollamaToolCall('delete_all_files', {}))
      .mockResolvedValueOnce(ollamaReply('ok'));

    await runOllamaAgent(
      [makeMsg('do it')],
      'Andy',
      GROUP_DIR,
      vi.fn(async () => {}),
    );

    const secondCall = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMsg = secondCall.messages.find(
      (m: { role: string }) => m.role === 'tool',
    );
    expect(toolMsg.content).toMatch(/unknown tool/);
  });

  it('forces a final response after MAX_TOOL_TURNS (10) tool calls', async () => {
    // Return tool calls 10 times, then a final answer
    for (let i = 0; i < 10; i++) {
      mockFetch.mockResolvedValueOnce(
        ollamaToolCall('read_file', { path: 'notes.md' }),
      );
    }
    mockFetch.mockResolvedValueOnce(ollamaReply('Final answer after timeout'));
    mockReadFileSync.mockReturnValue('content');

    const onOutput = vi.fn(async () => {});
    const result = await runOllamaAgent(
      [makeMsg('loop')],
      'Andy',
      GROUP_DIR,
      onOutput,
    );
    expect(result).toBe('success');
    // tools=false on the final call (no tools passed)
    const lastCall = JSON.parse(
      mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1].body,
    );
    expect(lastCall.tools).toBeUndefined();
  });
});

// --- memory file injection ---

describe('runOllamaAgent — memory file context injection', () => {
  it('injects available md files as context when files exist', async () => {
    mockReaddirSync.mockImplementation((dir: unknown, opts: unknown) => {
      if (String(dir) === GROUP_DIR) {
        return [
          Object.assign('CLAUDE.md', {
            isDirectory: () => false,
            isFile: () => true,
            name: 'CLAUDE.md',
          }),
          Object.assign('notes.md', {
            isDirectory: () => false,
            isFile: () => true,
            name: 'notes.md',
          }),
        ];
      }
      return [];
    });

    const body = await new Promise<ReturnType<typeof JSON.parse>>((resolve) => {
      mockFetch.mockImplementationOnce(
        async (_url: string, opts: RequestInit) => {
          resolve(JSON.parse(opts.body as string));
          return {
            ok: true,
            json: async () => ({
              message: { role: 'assistant', content: 'ok' },
              done: true,
            }),
          };
        },
      );
      runOllamaAgent(
        [makeMsg('hello')],
        'Andy',
        GROUP_DIR,
        vi.fn(async () => {}),
      );
    });

    const firstMsg = body.messages[0];
    expect(firstMsg.role).toBe('user');
    expect(firstMsg.content).toMatch(/Available memory files/);
    expect(firstMsg.content).toMatch(/CLAUDE\.md/);
  });

  it('skips context injection when no md files exist', async () => {
    mockReaddirSync.mockReturnValue([]);

    const body = await new Promise<ReturnType<typeof JSON.parse>>((resolve) => {
      mockFetch.mockImplementationOnce(
        async (_url: string, opts: RequestInit) => {
          resolve(JSON.parse(opts.body as string));
          return {
            ok: true,
            json: async () => ({
              message: { role: 'assistant', content: 'ok' },
              done: true,
            }),
          };
        },
      );
      runOllamaAgent(
        [makeMsg('hello')],
        'Andy',
        GROUP_DIR,
        vi.fn(async () => {}),
      );
    });

    const firstMsg = body.messages[0];
    expect(firstMsg.content).not.toMatch(/Available memory files/);
  });
});
