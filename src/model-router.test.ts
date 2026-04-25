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
      'gemini',
    );
  });

  it('does not route mid-sentence "ollama" to ollama', () => {
    expect(routeMessage('compare ollama with deepseek').model).toBe('gemini');
  });

  it('returns force-local reason', () => {
    expect(routeMessage('vault test').reason).toBe('force-local keyword');
  });
});

describe('routeMessage — Claude triggers', () => {
  it('routes "andy" prefix to claude', () => {
    expect(routeMessage('andy help me debug this').model).toBe('claude');
  });

  it('routes "Andy" (case-insensitive) to claude', () => {
    expect(routeMessage('Andy write a function').model).toBe('claude');
  });

  it('routes "ANDY" (case-insensitive) to claude', () => {
    expect(routeMessage('ANDY fix this bug').model).toBe('claude');
  });

  it('routes "andy," (with comma) to claude', () => {
    expect(routeMessage('andy, read me on Tejas').model).toBe('claude');
  });

  it('routes "claude" prefix to claude', () => {
    expect(routeMessage('claude, write me a script').model).toBe('claude');
  });

  it('routes "Claude" (case-insensitive) to claude', () => {
    expect(routeMessage('Claude write a function').model).toBe('claude');
  });

  it('does not route mid-sentence "andy" to claude', () => {
    expect(routeMessage('what did andy say yesterday').model).toBe('gemini');
  });

  it('does not route mid-sentence "claude" to claude', () => {
    expect(routeMessage('compare claude.ai vs gemini').model).toBe('gemini');
  });

  it('does not route "claude" inside another word to claude', () => {
    // "claude" appears, but the message starts with another word
    expect(routeMessage('I think Claude is the best model').model).toBe(
      'gemini',
    );
  });

  it('returns force-claude reason', () => {
    expect(routeMessage('andy hello').reason).toBe('force-claude keyword');
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

describe('routeMessage — default routing', () => {
  it('defaults to gemini for plain messages', () => {
    expect(routeMessage('what is the weather today?').model).toBe('gemini');
  });

  it('defaults to gemini for empty string', () => {
    expect(routeMessage('').model).toBe('gemini');
  });

  it('returns default reason', () => {
    expect(routeMessage('hello').reason).toBe('default');
  });

  it('defaults to gemini when discussing models without a prefix', () => {
    expect(
      routeMessage('I want to compare andy claude vault and ollama').model,
    ).toBe('gemini');
  });
});

describe('routeMessage — priority order', () => {
  it('deepseek prefix beats andy keyword (both at start = ds wins by priority)', () => {
    expect(routeMessage('ds andy, write code').model).toBe('deepseek');
  });

  it('andy prefix beats mid-sentence ollama mention', () => {
    expect(routeMessage('andy using ollama locally').model).toBe('claude');
  });

  it('claude prefix beats mid-sentence ollama mention', () => {
    expect(routeMessage('claude using ollama locally').model).toBe('claude');
  });

  it('gem prefix routes to gemini even when andy appears mid-sentence', () => {
    expect(routeMessage('gem what would andy say').model).toBe('gemini');
  });
});

describe('routeMessage — leading whitespace tolerance', () => {
  it('tolerates leading spaces before andy', () => {
    expect(routeMessage('   andy what do you think').model).toBe('claude');
  });

  it('tolerates leading spaces before ds', () => {
    expect(routeMessage('  ds quick code').model).toBe('deepseek');
  });
});
