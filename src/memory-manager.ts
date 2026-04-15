import {
  addMemoryHot,
  getMemoryHot,
  getMemoryState,
  getMemoryWarm,
  purgeMemoryHot,
} from './db.js';
import { escapeXml } from './router.js';

// Maximum characters stored per hot event (keeps storage lean)
const HOT_EVENT_MAX_CHARS = 500;
// Hours of hot events injected as recent context
const HOT_CONTEXT_HOURS = 4;
// Days of warm summaries injected into context
const WARM_CONTEXT_DAYS = 7;

/**
 * Record an event to memory_hot. Truncates long content and opportunistically
 * purges expired entries on every write.
 */
export function recordHotEvent(
  groupFolder: string,
  eventType: 'user' | 'assistant' | 'task',
  content: string,
  sender?: string,
): void {
  const truncated =
    content.length > HOT_EVENT_MAX_CHARS
      ? content.slice(0, HOT_EVENT_MAX_CHARS - 3) + '...'
      : content;
  addMemoryHot(groupFolder, eventType, truncated, sender);
  purgeMemoryHot(); // opportunistic cleanup on each write
}

/**
 * Build the <memory> XML block injected before <messages> in every prompt.
 * Returns an empty string when there is no stored context yet.
 */
export function buildMemoryContext(groupFolder: string): string {
  const state = getMemoryState(groupFolder);
  const warmEntries = getMemoryWarm(groupFolder, WARM_CONTEXT_DAYS);
  const hotEvents = getMemoryHot(groupFolder, HOT_CONTEXT_HOURS);

  if (!state && warmEntries.length === 0 && hotEvents.length === 0) return '';

  const parts: string[] = [];

  if (state) {
    parts.push(`  <state>${escapeXml(state)}</state>`);
  }

  if (warmEntries.length > 0) {
    const dayLines = warmEntries
      .map((e) => `    <day date="${e.date}">${escapeXml(e.summary)}</day>`)
      .join('\n');
    parts.push(`  <recent_days>\n${dayLines}\n  </recent_days>`);
  }

  if (hotEvents.length > 0) {
    const hotLines = hotEvents
      .map((e) => {
        const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        });
        const senderAttr = e.sender ? ` from="${escapeXml(e.sender)}"` : '';
        return `    <event type="${e.event_type}"${senderAttr} time="${time}">${escapeXml(e.content)}</event>`;
      })
      .join('\n');
    parts.push(`  <recent_events>\n${hotLines}\n  </recent_events>`);
  }

  return `<memory>\n${parts.join('\n')}\n</memory>`;
}

/**
 * Build the dynamic prompt for the daily memory summary task.
 * Called by task-scheduler when it detects a __MEMORY_SUMMARY__ sentinel task.
 */
export function buildDailySummaryPrompt(groupFolder: string): string {
  const hotEvents = getMemoryHot(groupFolder, 24);
  const existingState = getMemoryState(groupFolder);

  const eventsText =
    hotEvents.length > 0
      ? hotEvents
          .map((e) => {
            const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const who =
              e.sender ??
              (e.event_type === 'assistant' ? 'NanoClaw' : 'User');
            return `[${time}] (${e.event_type}) ${who}: ${e.content}`;
          })
          .join('\n')
      : '(no events recorded today)';

  const stateBlock = existingState
    ? `\nCurrent state summary:\n${existingState}\n`
    : '';

  return `You are performing a daily memory consolidation for NanoClaw.${stateBlock}

Events from the past 24 hours:
${eventsText}

Complete both tasks below. Be concise.

Task 1 — Write a one-sentence summary of TODAY's activity (~80-100 tokens).
Task 2 — Write an updated "state of user" rolling summary (~300-500 tokens). Capture who the user is, what they're actively working on, their goals and preferences, and any important ongoing context. Update with today's activity but preserve important prior context.

Respond in exactly this format:
TODAY: <today's one-sentence summary>
STATE: <updated rolling state summary>`;
}
