/**
 * Query classification and conditional tool loading.
 * Extracted for testability.
 */

const SONNET = 'claude-sonnet-5';
const OPUS   = 'claude-opus-4-8';
const HAIKU  = 'claude-haiku-4-5-20251001';

// o: prefix — user-controlled Opus override
const O_PREFIX = /^\s*o:/i;

// h: prefix — user-controlled Haiku override (cheap lookups, status checks, formatting)
const H_PREFIX = /^\s*h:/i;

// r: prefix — explicit memory write. Strips prefix, tells Andy to persist the fact.
// Accepts: "r:", "r :", "remember:", "remember "
const R_PREFIX = /^\s*r(?:emember)?[: ]/i;

// Core tools always loaded. Built-in Claude CLI tool names are PascalCase (Bash, Read, Write).
const CORE_TOOLS = new Set([
  'Bash', 'Read', 'Write',
  'mcp__nanoclaw__send_message', 'mcp__nanoclaw__web_fetch',
]);

const TOOL_TRIGGERS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /schedul|task|remind|recur|cron|timer/i, tools: [
    'mcp__nanoclaw__manage_tasks',
  ]},
  { pattern: /email|mail|send.*to|draft|smtp/i, tools: ['mcp__nanoclaw__send_email'] },
  { pattern: /calendar|event|meeting|appointment|caldav/i, tools: [
    'mcp__nanoclaw__dav_request',
    'mcp__nanoclaw__manage_tasks',
  ]},
  { pattern: /contact|phone|address|vcard|carddav/i, tools: ['mcp__nanoclaw__dav_request'] },
  { pattern: /register|new group|add group/i, tools: ['mcp__nanoclaw__register_group'] },
];

/**
 * Classify a query to select the model.
 * Sonnet is the default; use o: prefix to force Opus.
 */
export function classifyQuery(
  prompt: string,
  isScheduledTask: boolean,
): { model: string; reason: string } {
  // Explicit prefixes override scheduled-task default so skills can request Haiku
  // for cheap verification passes or Opus for heavyweight scheduled synthesis.
  if (O_PREFIX.test(prompt)) return { model: OPUS,   reason: 'o-prefix' };
  if (H_PREFIX.test(prompt)) return { model: HAIKU,  reason: 'h-prefix' };
  if (isScheduledTask)        return { model: SONNET, reason: 'scheduled-task' };
  if (R_PREFIX.test(prompt)) return { model: SONNET, reason: 'r-prefix' };
  return { model: SONNET, reason: 'default-sonnet' };
}

/** Returns true when the prompt starts with r:/remember: prefix. */
export function isRPrefix(prompt: string): boolean {
  return R_PREFIX.test(prompt);
}

/** Strip the r:/remember: prefix and return the bare content. */
export function stripRPrefix(prompt: string): string {
  return prompt.replace(R_PREFIX, '').trim();
}

/**
 * Return the allowed tool names for a query.
 * Always includes core tools; adds specialized tools only when keywords match.
 * When routingReason is 'simple-pattern', only send_message is loaded.
 */
export function getAllowedTools(
  prompt: string,
  isMain: boolean,
  routingReason?: string,
): string[] {
  if (routingReason === 'simple-pattern') {
    return ['mcp__nanoclaw__send_message'];
  }
  const allowed = new Set(CORE_TOOLS);
  for (const { pattern, tools } of TOOL_TRIGGERS) {
    if (pattern.test(prompt)) {
      for (const t of tools) allowed.add(t);
    }
  }
  if (!isMain) allowed.delete('mcp__nanoclaw__register_group');
  return [...allowed];
}
