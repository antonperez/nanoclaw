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
  // Note-taking & file ops
  /\b(save|append|jot|add)\s+(a\s+)?(quick\s+)?(note|notes)\b/i,
  /\bappend\s+to\b.{0,30}\.(md|txt)\b/i,
  // Read-back
  /\bwhat('?s|\s+is)\s+in\s+my\b/i,
  /\bread\s+(back|me)\b.{0,20}\b(file|note|list|tasks)\b/i,
  // Simple reminders
  /\bremind\s+me\b/i,
  /\bset\s+(a\s+)?reminder\b/i,
  // Formatting & cleanup
  /\b(format|clean\s*up|reformat|tidy\s*up)\s+(this|the|my)?\s*(text|paragraph|copy|message)\b/i,
  // Math & unit conversions
  /\bconvert\s+\d/i,
  /\bhow\s+many\s+\w+\s+(in|to|is|are)\b/i,
  // Summarize short inline text
  /\bsummariz(e|ing)\s+(this|the\s+following|below)\b/i,
  // CRM template fill-in
  /\b(fill\s+(in|out)?|complete)\s+(a\s+|the\s+|my\s+)?(crm)\b/i,
  /\bcrm\s+template\b/i,
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
  // Scheduling / calendar (complex — needs tools; simple reminders handled in FORCE_LOCAL)
  /\bschedule\b.{0,30}\b(task|reminder|meeting|event)\b/i,
  /\badd\s+(to\s+)?(calendar|todo|task)\b/i,
  // External actions
  /\bsend\s+(a\s+)?(email|message|text|telegram|whatsapp|slack)\b/i,
  /\b(draft|write|compose)\s+(a\s+)?(email|mail)\b/i,
  // Code tasks (non-trivial)
  /\bwrite\s+(a\s+)?(script|code|program|function|class|module)\b/i,
  /\bdebug\b.{0,20}\b(this|the|code|error|bug)\b/i,
  /\brefactor\b/i,
  // Strategy, planning, prioritization
  /\b(strategy|strategic|stress.test)\b/i,
  /\bplan\s+(for|out|my)\b/i,
  /\bprioritiz(e|ing)\b/i,
  /\bwhat\s+should\s+I\b/i,
  // Swarm / agent coordination
  /\bswarm\b/i,
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
