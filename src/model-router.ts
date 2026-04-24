export type ModelBackend = 'ollama' | 'claude' | 'deepseek' | 'gemini';

export interface RoutingDecision {
  model: ModelBackend;
  reason: string;
}

// Keywords that always force DeepSeek (checked before others)
const FORCE_DEEPSEEK: RegExp[] = [/^\s*ds\b/i, /^\s*deepseek\b/i];

// "claude" or "andy" forces the full Claude container agent
const FORCE_CLAUDE: RegExp[] = [/\bclaude\b/i, /\bandy\b/i];

// Keywords that always force local Ollama model
const FORCE_LOCAL: RegExp[] = [/\bvault\b/i, /\bollama\b/i];

// Keywords that explicitly force Gemini (already the default, but useful for overriding force- prefixes)
const FORCE_GEMINI: RegExp[] = [/^\s*gem\b/i, /^\s*gemini\b/i];

/**
 * Decide which AI backend to use based on the latest user message.
 *
 * Priority order:
 *  1. Force-deepseek prefix ("ds", "deepseek") → DeepSeek
 *  2. Force-claude keyword ("andy") → Claude container agent
 *  3. Force-local keywords ("vault", "ollama") → Ollama
 *  4. Force-gemini prefix ("gem", "gemini") → Gemini
 *  5. Default → Gemini
 */
export function routeMessage(lastUserMessage: string): RoutingDecision {
  for (const pattern of FORCE_DEEPSEEK) {
    if (pattern.test(lastUserMessage)) {
      return { model: 'deepseek', reason: 'force-deepseek keyword' };
    }
  }

  for (const pattern of FORCE_CLAUDE) {
    if (pattern.test(lastUserMessage)) {
      return { model: 'claude', reason: 'force-claude keyword' };
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

  return { model: 'gemini', reason: 'default' };
}
