import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each test resets modules so config.ts re-evaluates OLLAMA_CONFIGURED
// against whatever env var state is active at import time.

describe('OLLAMA_CONFIGURED', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('is false when OLLAMA_HOST is not set', async () => {
    const { OLLAMA_CONFIGURED } = await import('./config.js');
    expect(OLLAMA_CONFIGURED).toBe(false);
  });

  it('is true when OLLAMA_HOST is set via env var', async () => {
    vi.stubEnv('OLLAMA_HOST', 'http://192.168.1.50:11434');
    const { OLLAMA_CONFIGURED } = await import('./config.js');
    expect(OLLAMA_CONFIGURED).toBe(true);
  });

  it('OLLAMA_HOST falls back to localhost default when not configured', async () => {
    const { OLLAMA_HOST } = await import('./config.js');
    expect(OLLAMA_HOST).toBe('http://localhost:11434');
  });

  it('OLLAMA_HOST uses env var when set', async () => {
    vi.stubEnv('OLLAMA_HOST', 'http://pi4.local:11434');
    const { OLLAMA_HOST } = await import('./config.js');
    expect(OLLAMA_HOST).toBe('http://pi4.local:11434');
  });
});
