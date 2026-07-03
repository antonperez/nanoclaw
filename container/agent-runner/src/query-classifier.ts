/**
 * Query classification and conditional tool loading.
 * Extracted for testability.
 */

const SONNET = 'claude-sonnet-4-6';
const OPUS = 'claude-opus-4-8';

// q: prefix — user-controlled Sonnet override for any message type
// (quick queries, ingest, source, note, wiki ops, etc.)
const Q_PREFIX = /^\s*q:/i;

// r: prefix — explicit memory write. Strips prefix, tells Andy to persist the fact.
// Accepts: "r:", "r :", "remember:", "remember "
const R_PREFIX = /^\s*r(?:emember)?[: ]/i;

// Core tools always loaded
const CORE_TOOLS = new Set([
  'bash', 'read_file', 'write_file',
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
 * Opus is the default; Sonnet is used for structured/mechanical tasks.
 */
export function classifyQuery(
  prompt: string,
  isScheduledTask: boolean,
): { model: string; reason: string } {
  if (isScheduledTask) return { model: SONNET, reason: 'scheduled-task' };
  if (Q_PREFIX.test(prompt)) return { model: SONNET, reason: 'q-prefix' };
  if (R_PREFIX.test(prompt)) return { model: SONNET, reason: 'r-prefix' };
  return { model: OPUS, reason: 'default-opus' };
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

/**
 * Build a tool filter based on prompt content.
 * Delegates to getAllowedTools — kept for test compatibility.
 */
export function buildToolFilter(
  prompt: string,
  isMain: boolean,
  routingReason?: string,
): (tool: { name: string }) => boolean {
  const allowed = new Set(getAllowedTools(prompt, isMain, routingReason));
  return (tool) => allowed.has(tool.name);
}
