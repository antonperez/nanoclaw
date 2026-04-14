/**
 * Query classification and conditional tool loading.
 * Extracted for testability.
 */

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-20250514';

/**
 * Classify a query to select the cheapest adequate model.
 */
export function classifyQuery(
  prompt: string,
  isScheduledTask: boolean,
  hasSession: boolean,
): { model: string; reason: string } {
  if (isScheduledTask) {
    return { model: HAIKU, reason: 'scheduled-task' };
  }
  if (!hasSession && prompt.length < 200) {
    return { model: HAIKU, reason: 'short-no-history' };
  }
  const simplePatterns = /^(hi|hello|hey|good morning|good evening|what time|what day|what date|thank|thanks|ok|okay|gm|gn)\b/i;
  if (simplePatterns.test(prompt.trim())) {
    return { model: HAIKU, reason: 'simple-pattern' };
  }
  return { model: SONNET, reason: 'default-sonnet' };
}

// Core tools always loaded
const CORE_TOOLS = new Set([
  'bash', 'read_file', 'write_file',
  'mcp__nanoclaw__send_message', 'mcp__nanoclaw__web_fetch',
]);

const TOOL_TRIGGERS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /schedul|task|remind|recur|cron|timer/i, tools: [
    'mcp__nanoclaw__schedule_task', 'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__task_action', 'mcp__nanoclaw__update_task',
  ]},
  { pattern: /email|mail|send.*to|draft|smtp/i, tools: ['mcp__nanoclaw__send_email'] },
  { pattern: /calendar|event|meeting|appointment|caldav/i, tools: [
    'mcp__nanoclaw__caldav_request',
    'mcp__nanoclaw__schedule_task', 'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__task_action', 'mcp__nanoclaw__update_task',
  ]},
  { pattern: /contact|phone|address|vcard|carddav/i, tools: ['mcp__nanoclaw__carddav_request'] },
  { pattern: /register|new group|add group/i, tools: ['mcp__nanoclaw__register_group'] },
];

/**
 * Build a tool filter based on prompt content.
 * Always includes core tools; adds specialized tools only when keywords match.
 */
export function buildToolFilter(prompt: string, isMain: boolean): (tool: { name: string }) => boolean {
  const allowed = new Set(CORE_TOOLS);
  for (const { pattern, tools } of TOOL_TRIGGERS) {
    if (pattern.test(prompt)) {
      for (const t of tools) allowed.add(t);
    }
  }
  if (!isMain) allowed.delete('mcp__nanoclaw__register_group');
  return (tool) => allowed.has(tool.name);
}
