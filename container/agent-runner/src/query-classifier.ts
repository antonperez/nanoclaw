/**
 * Query classification and conditional tool loading.
 * Extracted for testability.
 */

const SONNET = 'claude-sonnet-4-6';

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
 * Classify a query to select the model. Sonnet is the default for all cases.
 */
export function classifyQuery(
  _prompt: string,
  _isScheduledTask: boolean,
): { model: string; reason: string } {
  return { model: SONNET, reason: 'default-sonnet' };
}

/**
 * Build a tool filter based on prompt content.
 * Always includes core tools; adds specialized tools only when keywords match.
 * When routingReason is 'simple-pattern', only send_message is loaded.
 */
export function buildToolFilter(
  prompt: string,
  isMain: boolean,
  routingReason?: string,
): (tool: { name: string }) => boolean {
  if (routingReason === 'simple-pattern') {
    return (tool) => tool.name === 'mcp__nanoclaw__send_message';
  }
  const allowed = new Set(CORE_TOOLS);
  for (const { pattern, tools } of TOOL_TRIGGERS) {
    if (pattern.test(prompt)) {
      for (const t of tools) allowed.add(t);
    }
  }
  if (!isMain) allowed.delete('mcp__nanoclaw__register_group');
  return (tool) => allowed.has(tool.name);
}
