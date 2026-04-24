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
  it('routes "vault" keyword to ollama', () => {
    expect(routeMessage("vault, what's 2+2?").model).toBe('ollama');
  });

  it('routes "ollama" keyword to ollama', () => {
    expect(routeMessage('ollama quick question').model).toBe('ollama');
  });

  it('routes "VAULT" (case-insensitive) to ollama', () => {
    expect(routeMessage('VAULT help me').model).toBe('ollama');
  });

  it('routes "Ollama" (case-insensitive) to ollama', () => {
    expect(routeMessage('Ollama, summarize this').model).toBe('ollama');
  });

  it('returns force-local reason', () => {
    expect(routeMessage('vault test').reason).toBe('force-local keyword');
  });
});

describe('routeMessage — Claude triggers', () => {
  it('routes "andy" keyword to claude', () => {
    expect(routeMessage('andy help me debug this').model).toBe('claude');
  });

  it('routes "Andy" (case-insensitive) to claude', () => {
    expect(routeMessage('Andy write a function').model).toBe('claude');
  });

  it('routes "ANDY" (case-insensitive) to claude', () => {
    expect(routeMessage('ANDY fix this bug').model).toBe('claude');
  });

  it('routes "claude" keyword to claude', () => {
    expect(routeMessage('claude, write me a script').model).toBe('claude');
  });

  it('routes "Claude" (case-insensitive) to claude', () => {
    expect(routeMessage('Claude write a function').model).toBe('claude');
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
});

describe('routeMessage — priority order', () => {
  it('deepseek prefix beats andy keyword', () => {
    expect(routeMessage('ds andy, write code').model).toBe('deepseek');
  });

  it('deepseek prefix beats ollama keyword', () => {
    expect(routeMessage('ds vault compare models').model).toBe('deepseek');
  });

  it('andy beats ollama keyword', () => {
    expect(routeMessage('andy using ollama locally').model).toBe('claude');
  });

  it('claude beats ollama keyword', () => {
    expect(routeMessage('claude using ollama locally').model).toBe('claude');
  });

  it('andy beats gemini prefix', () => {
    // andy is checked before gemini in priority order
    expect(routeMessage('gem andy do something').model).toBe('claude');
  });
});
