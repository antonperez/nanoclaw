export type ModelBackend = 'ollama' | 'claude' | 'deepseek' | 'gemini';

export interface RoutingDecision {
  model: ModelBackend;
  reason: string;
}

// All triggers are prefix-only: keyword must be the first word of the message
// (case-insensitive, leading whitespace tolerated). Mid-sentence mentions are
// ignored so messages like "what did andy say" or "compare claude vs gemini"
// stay on the default Claude path instead of accidentally routing.
const FORCE_DEEPSEEK: RegExp[] = [/^\s*ds\b/i, /^\s*deepseek\b/i];
const FORCE_LOCAL: RegExp[] = [/^\s*vault\b/i, /^\s*ollama\b/i];
const FORCE_GEMINI: RegExp[] = [/^\s*gem\b/i, /^\s*gemini\b/i];

/**
 * Decide which AI backend to use based on the latest user message.
 *
 * Priority order (all prefix-only):
 *  1. "ds" / "deepseek"   → DeepSeek
 *  2. "vault" / "ollama"  → Ollama (local)
 *  3. "gem" / "gemini"    → Gemini (explicit override)
 *  4. Anything else       → Claude container agent (default)
 */
export function routeMessage(lastUserMessage: string): RoutingDecision {
  for (const pattern of FORCE_DEEPSEEK) {
    if (pattern.test(lastUserMessage)) {
      return { model: 'deepseek', reason: 'force-deepseek keyword' };
    }
  }

  for (const pattern of FORCE_LOCAL) {
    if (pattern.test(lastUserMessage)) {
      return { model: 'ollama', reason: 'force-local keyword' };
    }
  }

  for (const pattern of FORCE_GEMINI) {
    if (pattern.test(lastUserMessage)) {
      return { model: 'gemini', reason: 'force-gemini keyword' };
    }
  }

  return { model: 'claude', reason: 'default' };
}
