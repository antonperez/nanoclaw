import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logGeminiUsage, dedupeUserMessages } from './gemini-runner.js';
import type { NewMessage } from './types.js';

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm1',
    chat_jid: 'tg:1',
    sender: 'tg:1',
    sender_name: 'Anton',
    content: 'hello',
    timestamp: '2026-04-25T00:00:00Z',
    is_from_me: false,
    ...overrides,
  };
}

describe('dedupeUserMessages', () => {
  it('returns all recent user messages when hot memory is empty', () => {
    const recent = [
      makeMessage({ id: 'a', content: 'first' }),
      makeMessage({ id: 'b', content: 'second' }),
    ];
    const result = dedupeUserMessages(recent, []);
    expect(result).toHaveLength(2);
  });

  it('drops a recent message whose content is already in hot user events', () => {
    const recent = [
      makeMessage({ id: 'a', content: 'already-said' }),
      makeMessage({ id: 'b', content: 'new-message' }),
    ];
    const hot = [
      { event_type: 'user', content: 'already-said' },
      { event_type: 'assistant', content: 'some reply' },
    ];
    const result = dedupeUserMessages(recent, hot);
    expect(result.map((m) => m.id)).toEqual(['b']);
  });

  it('does NOT dedupe against assistant events — only user events', () => {
    // Critical guarantee: a user repeating wording from a prior assistant reply
    // must still get through.
    const recent = [makeMessage({ id: 'a', content: 'echoed reply text' })];
    const hot = [{ event_type: 'assistant', content: 'echoed reply text' }];
    const result = dedupeUserMessages(recent, hot);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('drops messages flagged is_from_me regardless of hot memory', () => {
    const recent = [
      makeMessage({ id: 'a', content: 'mine', is_from_me: true }),
      makeMessage({ id: 'b', content: 'theirs', is_from_me: false }),
    ];
    const result = dedupeUserMessages(recent, []);
    expect(result.map((m) => m.id)).toEqual(['b']);
  });

  it('returns empty array when all recent messages are deduped or from-me', () => {
    const recent = [
      makeMessage({ id: 'a', content: 'dup', is_from_me: false }),
      makeMessage({ id: 'b', content: 'mine', is_from_me: true }),
    ];
    const hot = [{ event_type: 'user', content: 'dup' }];
    expect(dedupeUserMessages(recent, hot)).toEqual([]);
  });
});

describe('logGeminiUsage', () => {
  let tmpDir: string;
  const groupFolder = 'test_group';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-log-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLog(): string[] {
    const p = path.join(tmpDir, 'tokens.csv');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  }

  it('does nothing when usage is undefined (no file written)', () => {
    logGeminiUsage(groupFolder, undefined, tmpDir);
    expect(readLog()).toEqual([]);
  });

  it('writes header + one row on first call', () => {
    logGeminiUsage(groupFolder, {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
    }, tmpDir);
    const lines = readLog();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'timestamp,group,model,input_tokens,cached_tokens,output_tokens,total_tokens,cost_usd',
    );
  });

  it('appends without re-writing the header on subsequent calls', () => {
    logGeminiUsage(groupFolder, {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
    }, tmpDir);
    logGeminiUsage(groupFolder, {
      prompt_tokens: 2000,
      completion_tokens: 200,
      total_tokens: 2200,
    }, tmpDir);
    expect(readLog()).toHaveLength(3); // header + 2 rows
  });

  it('computes cost without cache: 1M input + 1M output ≈ $2.80 ($0.30 + $2.50)', () => {
    logGeminiUsage(groupFolder, {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
    }, tmpDir);
    const row = readLog()[1].split(',');
    const cost = parseFloat(row[7]);
    expect(cost).toBeCloseTo(2.8, 5);
  });

  it('applies 75% discount to cached input tokens', () => {
    // 100K total input, 80K cached, 20K uncached. 1K output.
    // Cost = 20K * $0.30/M + 80K * $0.075/M + 1K * $2.50/M
    //      = 0.006 + 0.006 + 0.0025 = 0.0145
    logGeminiUsage(groupFolder, {
      prompt_tokens: 100_000,
      completion_tokens: 1_000,
      total_tokens: 101_000,
      prompt_tokens_details: { cached_tokens: 80_000 },
    }, tmpDir);
    const row = readLog()[1].split(',');
    const uncached = parseInt(row[3], 10);
    const cached = parseInt(row[4], 10);
    const cost = parseFloat(row[7]);
    expect(uncached).toBe(20_000);
    expect(cached).toBe(80_000);
    expect(cost).toBeCloseTo(0.0145, 5);
  });

  it('falls back to prompt+completion when total_tokens is missing', () => {
    logGeminiUsage(groupFolder, {
      prompt_tokens: 500,
      completion_tokens: 50,
    }, tmpDir);
    const row = readLog()[1].split(',');
    expect(parseInt(row[6], 10)).toBe(550); // total
  });

  it('handles zero usage values without crashing', () => {
    logGeminiUsage(groupFolder, {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    }, tmpDir);
    const row = readLog()[1].split(',');
    expect(parseFloat(row[7])).toBe(0);
  });
});
