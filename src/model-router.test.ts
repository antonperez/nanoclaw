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
    expect(routeMessage('compare claude and deepseek').model).not.toBe(
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
  it('routes "claude" keyword to claude', () => {
    expect(routeMessage('claude, write me a script').model).toBe('claude');
  });

  it('routes "andy" keyword to claude', () => {
    expect(routeMessage('andy help me debug this').model).toBe('claude');
  });

  it('routes "Claude" (case-insensitive) to claude', () => {
    expect(routeMessage('Claude write a function').model).toBe('claude');
  });

  it('returns force-claude reason', () => {
    expect(routeMessage('andy hello').reason).toBe('force-claude keyword');
  });
});

describe('routeMessage — default routing', () => {
  it('defaults to claude for plain messages', () => {
    expect(routeMessage('what is the weather today?').model).toBe('claude');
  });

  it('defaults to claude for empty string', () => {
    expect(routeMessage('').model).toBe('claude');
  });

  it('returns default reason', () => {
    expect(routeMessage('hello').reason).toBe('default');
  });
});

describe('routeMessage — priority order', () => {
  it('deepseek prefix beats claude keyword', () => {
    // "ds andy" — deepseek prefix takes priority over "andy"
    expect(routeMessage('ds andy, write code').model).toBe('deepseek');
  });

  it('deepseek prefix beats ollama keyword', () => {
    expect(routeMessage('ds vault compare models').model).toBe('deepseek');
  });

  it('claude keyword beats ollama keyword', () => {
    // "claude vault" — claude check runs before ollama check
    expect(routeMessage('claude using ollama locally').model).toBe('claude');
  });
});
