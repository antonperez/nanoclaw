export type ModelBackend = 'ollama' | 'claude';

export interface RoutingDecision {
  model: ModelBackend;
  reason: string;
}

// Keywords that always force Claude (container agent)
const FORCE_CLAUDE: RegExp[] = [
  /\bclaude\b/i,
  /\bandy\b/i,
];

// Keywords that always force local Ollama model
const FORCE_LOCAL: RegExp[] = [
  /\bvault\b/i,
  /\buse\s+local\b/i,
  /\bprivate\b/i,
  /\buse\s+anton-?vault\b/i,
  /\buse\s+ollama\b/i,
  /\buse\s+qwen\b/i,
];

// Patterns that need Claude's full agent capabilities (tools, external knowledge, reasoning)
const NEEDS_CLAUDE: RegExp[] = [
  // Web & external knowledge
  /\bweb\s*search\b/i,
  /\bsearch\s+(the\s+)?web\b/i,
  /\blook\s+(it\s+)?up\s+online\b/i,
  /\bbrowse\b.{0,20}\bweb\b/i,
  /\blatest\s+news\b/i,
  /\bcurrent\s+(price|weather|score|news)\b/i,
  // Scheduling / calendar / reminders
  /\bschedule\b.{0,30}\b(task|reminder|meeting|event)\b/i,
  /\bremind\s+me\b/i,
  /\bset\s+(a\s+)?reminder\b/i,
  /\badd\s+(to\s+)?(calendar|todo|task)\b/i,
  // External actions
  /\bsend\s+(a\s+)?(email|message|text|telegram|whatsapp|slack)\b/i,
  // Code tasks (non-trivial)
  /\bwrite\s+(a\s+)?(script|code|program|function|class|module)\b/i,
  /\bdebug\b.{0,20}\b(this|the|code|error|bug)\b/i,
  /\brefactor\b/i,
  // Multi-step reasoning hints
  /\bstep.by.step\b/i,
  /\bcomprehensive\b/i,
  /\banalyze\s+.{20,}/i,
];

const COMPLEXITY_WORD_THRESHOLD = 100;

/**
 * Decide which AI backend to use based on the latest user message.
 *
 * Priority order:
 *  1. Force-local keywords ("vault", "use local", "private") → Ollama
 *  2. Tool-use / external-knowledge patterns → Claude
 *  3. Message too long for a local model → Claude
 *  4. Default → Ollama
 */
export function routeMessage(lastUserMessage: string): RoutingDecision {
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

  for (const pattern of NEEDS_CLAUDE) {
    if (pattern.test(lastUserMessage)) {
      return { model: 'claude', reason: 'tool/complexity pattern' };
    }
  }

  const wordCount = lastUserMessage.trim().split(/\s+/).length;
  if (wordCount > COMPLEXITY_WORD_THRESHOLD) {
    return { model: 'claude', reason: `length (${wordCount} words)` };
  }

  return { model: 'ollama', reason: 'default' };
}
