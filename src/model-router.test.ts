import { describe, it, expect } from 'vitest';

import { routeMessage } from './model-router.js';

describe('routeMessage — DeepSeek triggers', () => {
  it('routes "ds" prefix to deepseek', () => {
    expect(routeMessage('ds write a sorting algorithm').model).toBe('deepseek');
  });

  it('routes "DS" prefix (case-insensitive) to deepseek', () => {
    expect(routeMessage('DS write a sorting algorithm').model).toBe('deepseek');
  });

  it('routes "deepseek" prefix to deepseek', () => {
    expect(routeMessage('deepseek solve this equation').model).toBe('deepseek');
  });

  it('routes "DeepSeek" prefix (case-insensitive) to deepseek', () => {
    expect(routeMessage('DeepSeek solve this').model).toBe('deepseek');
  });

  it('does not route mid-sentence "deepseek" to deepseek', () => {
    expect(routeMessage('compare gemini and deepseek').model).not.toBe(
      'deepseek',
    );
  });

  it('does not route "ds" appearing mid-sentence to deepseek', () => {
    expect(routeMessage('what are the odds').model).not.toBe('deepseek');
  });

  it('returns force-deepseek reason', () => {
    expect(routeMessage('ds hello').reason).toBe('force-deepseek keyword');
  });
});

describe('routeMessage — Ollama triggers', () => {
  it('routes "vault" prefix to ollama', () => {
    expect(routeMessage("vault, what's 2+2?").model).toBe('ollama');
  });

  it('routes "ollama" prefix to ollama', () => {
    expect(routeMessage('ollama quick question').model).toBe('ollama');
  });

  it('routes "VAULT" (case-insensitive) to ollama', () => {
    expect(routeMessage('VAULT help me').model).toBe('ollama');
  });

  it('routes "Ollama" (case-insensitive) to ollama', () => {
    expect(routeMessage('Ollama, summarize this').model).toBe('ollama');
  });

  it('does not route mid-sentence "vault" to ollama', () => {
    expect(routeMessage('I prefer the vault for security').model).toBe(
      'claude',
    );
  });

  it('does not route mid-sentence "ollama" to ollama', () => {
    expect(routeMessage('compare ollama with deepseek').model).toBe('claude');
  });

  it('returns force-local reason', () => {
    expect(routeMessage('vault test').reason).toBe('force-local keyword');
  });
});

describe('routeMessage — Gemini triggers', () => {
  it('routes "gem" prefix to gemini', () => {
    expect(routeMessage('gem summarize this').model).toBe('gemini');
  });

  it('routes "gemini" prefix to gemini', () => {
    expect(routeMessage('gemini explain this').model).toBe('gemini');
  });

  it('returns force-gemini reason', () => {
    expect(routeMessage('gem hello').reason).toBe('force-gemini keyword');
  });
});

describe('routeMessage — default routing (Claude)', () => {
  it('defaults to claude for plain messages', () => {
    expect(routeMessage('what is the weather today?').model).toBe('claude');
  });

  it('defaults to claude for empty string', () => {
    expect(routeMessage('').model).toBe('claude');
  });

  it('returns default reason', () => {
    expect(routeMessage('hello').reason).toBe('default');
  });

  it('defaults to claude when discussing models without a prefix', () => {
    expect(
      routeMessage('I want to compare andy claude vault and ollama').model,
    ).toBe('claude');
  });

  it('mid-sentence "andy" routes to claude (default)', () => {
    expect(routeMessage('what did andy say yesterday').model).toBe('claude');
  });

  it('mid-sentence "claude" routes to claude (default)', () => {
    expect(routeMessage('compare claude.ai vs gemini').model).toBe('claude');
  });

  it('message starting with "claude" (not a trigger) routes to claude (default)', () => {
    expect(routeMessage('I think Claude is the best model').model).toBe(
      'claude',
    );
  });
});

describe('routeMessage — priority order', () => {
  it('deepseek prefix beats mid-sentence keywords', () => {
    expect(routeMessage('ds andy, write code').model).toBe('deepseek');
  });

  it('gem prefix routes to gemini even when other keywords appear mid-sentence', () => {
    expect(routeMessage('gem what would andy say').model).toBe('gemini');
  });

  it('vault prefix routes to ollama even with claude mid-sentence', () => {
    expect(routeMessage('vault compare claude and gpt').model).toBe('ollama');
  });
});

describe('routeMessage — leading whitespace tolerance', () => {
  it('tolerates leading spaces before ds', () => {
    expect(routeMessage('  ds quick code').model).toBe('deepseek');
  });

  it('tolerates leading spaces before gem', () => {
    expect(routeMessage('  gem summarize this').model).toBe('gemini');
  });
});
