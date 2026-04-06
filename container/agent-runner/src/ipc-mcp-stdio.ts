/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const EMAILS_DIR = path.join(IPC_DIR, 'emails');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

// Optional team chat JID — read from group workspace if configured.
// When set, send_message defaults to the team chat when a sender identity is specified.
const teamChatJidFile = path.join('/workspace/group', 'team-chat-jid');
const teamChatJid = fs.existsSync(teamChatJidFile)
  ? fs.readFileSync(teamChatJidFile, 'utf-8').trim()
  : undefined;

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    chat_jid: z.string().optional().describe('Target chat JID. Defaults to the current chat. Use to send to a different chat (e.g. a team group).'),
  },
  async (args) => {
    // If a sender (worker bot identity) is set and a team chat is configured,
    // default to the team chat so workers don't need to pass chat_jid explicitly.
    const resolvedChatJid =
      args.chat_jid ||
      (args.sender && teamChatJid ? teamChatJid : chatJid);
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: resolvedChatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    script: z.string().optional().describe('Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().optional().describe('New script for the task. Set to empty string to remove the script.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'send_email',
  'Send an email via iCloud SMTP. Use for notifications, summaries, or any content better delivered by email. Attachments can be any file previously saved to /workspace/group/files/ (e.g. from a Telegram upload).',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC email address(es), comma-separated'),
    bcc: z.string().optional().describe('BCC email address(es), comma-separated'),
    attachments: z
      .array(z.string())
      .optional()
      .describe('Absolute paths to files to attach, e.g. ["/workspace/group/files/report.pdf"]'),
  },
  async (args) => {
    const data: Record<string, string | string[] | undefined> = {
      type: 'send_email',
      to: args.to,
      subject: args.subject,
      body: args.body,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.cc) data.cc = args.cc;
    if (args.bcc) data.bcc = args.bcc;
    if (args.attachments?.length) data.attachments = args.attachments;

    writeIpcFile(EMAILS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Email queued to ${args.to}.` }] };
  },
);

// iCloud DAV tools — credentials are injected by the host credential proxy
const DAV_URL = process.env.NANOCLAW_DAV_URL;

async function davFetch(
  type: 'caldav' | 'carddav',
  method: string,
  path: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; text: string }> {
  if (!DAV_URL) throw new Error('NANOCLAW_DAV_URL not set');
  const url = `${DAV_URL}/${type}${path.startsWith('/') ? path : '/' + path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/xml; charset=utf-8',
    ...extraHeaders,
  };
  if (body) headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();
  return { status: resp.status, text };
}

server.tool(
  'caldav_request',
  `Make an authenticated CalDAV request to iCloud Calendar via the credential proxy.
Credentials (ICLOUD_EMAIL + ICLOUD_APP_PASSWORD) are injected automatically — never include them in requests.

Common operations:
• Discovery: PROPFIND /.well-known/caldav (Depth: 0) → find current-user-principal href
• Calendar home: PROPFIND <principal-path> (Depth: 0) → find calendar-home-set href
• List calendars: PROPFIND <calendar-home-path> (Depth: 1) → calendars with displayname
• Query events: REPORT <calendar-path> (Depth: 1) with calendar-query XML
• Create/update event: PUT <calendar-path>/<uid>.ics with iCal body (Content-Type: text/calendar)
• Delete event: DELETE <event-path>

Redirects are followed automatically.`,
  {
    method: z.enum(['PROPFIND', 'REPORT', 'GET', 'PUT', 'DELETE', 'MKCALENDAR']).describe('HTTP method'),
    path: z.string().describe('Path on caldav.icloud.com (e.g. /.well-known/caldav or /1234567890/calendars/)'),
    body: z.string().optional().describe('Request body — XML for PROPFIND/REPORT, iCal for PUT'),
    depth: z.enum(['0', '1', 'infinity']).optional().describe('DAV Depth header (for PROPFIND/REPORT)'),
    content_type: z.string().optional().describe('Content-Type override (default: application/xml). Use text/calendar for PUT with iCal data.'),
    etag: z.string().optional().describe('ETag for conditional updates (sets If-Match header)'),
  },
  async (args) => {
    try {
      const extra: Record<string, string> = {};
      if (args.depth) extra['Depth'] = args.depth;
      if (args.content_type) extra['Content-Type'] = args.content_type;
      if (args.etag) extra['If-Match'] = args.etag;
      const { status, text } = await davFetch('caldav', args.method, args.path, args.body, extra);
      return { content: [{ type: 'text' as const, text: `HTTP ${status}\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `CalDAV error: ${err}` }], isError: true };
    }
  },
);

server.tool(
  'carddav_request',
  `Make an authenticated CardDAV request to iCloud Contacts via the credential proxy.
Credentials are injected automatically.

Common operations:
• Discovery: PROPFIND /.well-known/carddav (Depth: 0) → find current-user-principal href
• Address book home: PROPFIND <principal-path> (Depth: 0) → find addressbook-home-set href
• List address books: PROPFIND <addressbook-home-path> (Depth: 1)
• Search contacts: REPORT <addressbook-path> (Depth: 1) with addressbook-query XML
• Get contact: GET <contact-path> → returns vCard data
• Create/update contact: PUT <addressbook-path>/<uid>.vcf with vCard body (Content-Type: text/vcard)
• Delete contact: DELETE <contact-path>

Redirects are followed automatically.`,
  {
    method: z.enum(['PROPFIND', 'REPORT', 'GET', 'PUT', 'DELETE']).describe('HTTP method'),
    path: z.string().describe('Path on contacts.icloud.com (e.g. /.well-known/carddav)'),
    body: z.string().optional().describe('Request body — XML for PROPFIND/REPORT, vCard for PUT'),
    depth: z.enum(['0', '1', 'infinity']).optional().describe('DAV Depth header'),
    content_type: z.string().optional().describe('Content-Type override (default: application/xml). Use text/vcard for PUT.'),
    etag: z.string().optional().describe('ETag for conditional updates (sets If-Match header)'),
  },
  async (args) => {
    try {
      const extra: Record<string, string> = {};
      if (args.depth) extra['Depth'] = args.depth;
      if (args.content_type) extra['Content-Type'] = args.content_type;
      if (args.etag) extra['If-Match'] = args.etag;
      const { status, text } = await davFetch('carddav', args.method, args.path, args.body, extra);
      return { content: [{ type: 'text' as const, text: `HTTP ${status}\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `CardDAV error: ${err}` }], isError: true };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
