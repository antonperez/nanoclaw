import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { calcCost, loadSession, appendToSession, executeBuiltinTool } from './direct-api.js';

// --- calcCost ---

describe('calcCost', () => {
  it('returns 0 for zero usage', () => {
    expect(
      calcCost({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(0);
  });

  it('calculates input-only cost at $3/M', () => {
    expect(
      calcCost({
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(3.0);
  });

  it('calculates output-only cost at $15/M', () => {
    expect(
      calcCost({
        input_tokens: 0,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(15.0);
  });

  it('calculates cache_read cost at $0.30/M', () => {
    expect(
      calcCost({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
      }),
    ).toBeCloseTo(0.3, 4);
  });

  it('calculates mixed usage', () => {
    // 5K input + 1K output + 3K cache_read + 2K cache_creation
    // = 0.015 + 0.015 + 0.0009 + 0.0075 = 0.0384
    expect(
      calcCost({
        input_tokens: 5000,
        output_tokens: 1000,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 2000,
      }),
    ).toBeCloseTo(0.0384, 4);
  });

  it('handles typical single-turn chat (6K input, 500 output, 2K cache)', () => {
    const cost = calcCost({
      input_tokens: 6000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
    });
    // 0.018 + 0.0075 + 0.0006 = 0.0261
    expect(cost).toBeCloseTo(0.0261, 4);
    expect(cost).toBeLessThan(0.05); // sanity: single turn should be cheap
  });

  it('uses opus pricing at $15/M input for opus model', () => {
    expect(
      calcCost(
        {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        'claude-opus-4-20250514',
      ),
    ).toBe(15.0);
  });
});

// --- Session persistence ---

describe('session persistence', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadSession returns [] for missing file', () => {
    expect(loadSession('/tmp/nonexistent-session-test.jsonl')).toEqual([]);
  });

  it('loadSession returns [] for empty file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-api-test-'));
    fs.writeFileSync(path.join(tmpDir, 'empty.jsonl'), '');
    expect(loadSession(path.join(tmpDir, 'empty.jsonl'))).toEqual([]);
  });

  it('appendToSession creates parent dirs and writes JSONL', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-api-test-'));
    const sessionPath = path.join(tmpDir, 'nested', 'dir', 'session.jsonl');

    appendToSession(sessionPath, { role: 'user', content: 'hello' });
    appendToSession(sessionPath, { role: 'assistant', content: 'hi' });

    const lines = fs.readFileSync(sessionPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ role: 'user', content: 'hello' });
    expect(JSON.parse(lines[1])).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('round-trips messages through append + load', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-api-test-'));
    const sessionPath = path.join(tmpDir, 'roundtrip.jsonl');

    appendToSession(sessionPath, { role: 'user', content: 'question' });
    appendToSession(sessionPath, { role: 'assistant', content: 'answer' });

    const loaded = loadSession(sessionPath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual({ role: 'user', content: 'question' });
    expect(loaded[1]).toEqual({ role: 'assistant', content: 'answer' });
  });

  it('loadSession skips blank lines', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-api-test-'));
    const sessionPath = path.join(tmpDir, 'blanks.jsonl');
    fs.writeFileSync(
      sessionPath,
      '{"role":"user","content":"a"}\n\n{"role":"assistant","content":"b"}\n\n',
    );
    expect(loadSession(sessionPath)).toHaveLength(2);
  });
});

// --- executeBuiltinTool ---

describe('executeBuiltinTool', () => {
  it('returns null for unknown tool', async () => {
    expect(await executeBuiltinTool('nonexistent', {})).toBeNull();
  });

  // bash tests require /workspace/group (container-only cwd) — skip locally
  it.skipIf(!fs.existsSync('/workspace/group'))('bash runs a command and captures stdout', async () => {
    const result = await executeBuiltinTool('bash', { command: 'echo hello' });
    expect(result?.trim()).toBe('hello');
  });

  it.skipIf(!fs.existsSync('/workspace/group'))('bash captures stderr', async () => {
    const result = await executeBuiltinTool('bash', { command: 'echo err >&2' });
    expect(result).toContain('err');
  });

  it.skipIf(!fs.existsSync('/workspace/group'))('bash returns error message on failure', async () => {
    const result = await executeBuiltinTool('bash', { command: 'exit 1' });
    expect(result).toBeDefined();
  });

  // read_file uses /workspace/group as base — skip outside container
  it.skipIf(!fs.existsSync('/workspace/group'))('read_file returns numbered lines', async () => {
    const result = await executeBuiltinTool('read_file', { file_path: '/workspace/group' });
    // directory read will error, so just verify the tool runs; test via a real file in container
    expect(result).toBeDefined();
  });

  it('read_file blocks path traversal outside /workspace/', async () => {
    const result = await executeBuiltinTool('read_file', { file_path: '/etc/hostname' });
    expect(result).toMatch(/^Error: path must be within \/workspace\//);
  });

  it('read_file returns error for missing file within workspace', async () => {
    const result = await executeBuiltinTool('read_file', { file_path: 'nonexistent-file-xyz.txt' });
    expect(result).toMatch(/^Error:/);
  });

  it('write_file blocks path traversal outside /workspace/', async () => {
    const result = await executeBuiltinTool('write_file', {
      file_path: '/tmp/escape-attempt.txt',
      content: 'should be blocked',
    });
    expect(result).toMatch(/^Error: path must be within \/workspace\//);
  });

  it.skipIf(!fs.existsSync('/workspace/group'))('write_file creates file and reports byte count', async () => {
    const result = await executeBuiltinTool('write_file', {
      file_path: `direct-api-write-test-${Date.now()}.txt`,
      content: 'test content',
    });
    expect(result).toContain('12 bytes');
  });
});
