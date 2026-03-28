export type ModelBackend = 'ollama' | 'claude' | 'deepseek';

export interface RoutingDecision {
  model: ModelBackend;
  reason: string;
}

// Keywords that always force DeepSeek (checked before Claude/Ollama)
const FORCE_DEEPSEEK: RegExp[] = [/^\s*ds\b/i, /^\s*deepseek\b/i];

// Keywords that always force Claude (container agent)
const FORCE_CLAUDE: RegExp[] = [/\bclaude\b/i, /\bandy\b/i];

// Keywords that always force local Ollama model
const FORCE_LOCAL: RegExp[] = [/\bvault\b/i, /\bollama\b/i];

/**
 * Decide which AI backend to use based on the latest user message.
 *
 * Priority order:
 *  1. Force-deepseek prefix ("ds", "deepseek") → DeepSeek
 *  2. Force-claude keywords ("claude", "andy") → Claude
 *  3. Force-local keywords ("vault", "ollama") → Ollama
 *  4. Default → Claude
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

  return { model: 'claude', reason: 'default' };
}
