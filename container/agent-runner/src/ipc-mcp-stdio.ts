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
  'Send a message to the user/group.',
  {
    text: z.string().describe('Message text'),
    sender: z.string().optional().describe('Bot identity name, e.g. "Researcher"'),
    chat_jid: z.string().optional().describe('Target chat JID (default: current chat)'),
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
  'Schedule a recurring or one-time task. All times LOCAL (no Z suffix).',
  {
    prompt: z.string().describe('Task prompt with full context'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron | interval (ms) | once'),
    schedule_value: z.string().describe('cron: "0 9 * * *" | interval: "300000" | once: "2026-02-01T15:30:00"'),
    target_group_jid: z.string().optional().describe('Target group JID (main only)'),
    script: z.string().optional().describe('Bash script; must output JSON: {"wakeAgent":bool,"data":any}'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: 'isolated',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  'List scheduled tasks for this group.',
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.schedule_type}: ${t.schedule_value} — ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'task_action',
  'Pause, resume, or cancel a scheduled task.',
  {
    task_id: z.string().describe('Task ID'),
    action: z.enum(['pause', 'resume', 'cancel']).describe('Action to perform'),
  },
  async (args) => {
    const data = {
      type: `${args.action}_task`,
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} ${args.action} requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update a scheduled task. Only provided fields change.',
  {
    task_id: z.string().describe('Task ID'),
    prompt: z.string().optional().describe('New prompt'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New type'),
    schedule_value: z.string().optional().describe('New schedule value'),
    script: z.string().optional().describe('New script (empty string to remove)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
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
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  'Register a new chat/group (main group only).',
  {
    jid: z.string().describe('Chat JID'),
    name: z.string().describe('Display name'),
    folder: z.string().describe('Channel-prefixed folder, e.g. "telegram_dev-team"'),
    trigger: z.string().describe('Trigger word, e.g. "@Andy"'),
    requiresTrigger: z.boolean().optional().describe('Require trigger word (default: false)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'send_email',
  'Send an email via iCloud SMTP.',
  {
    to: z.string().describe('Recipient'),
    subject: z.string().describe('Subject'),
    body: z.string().describe('Body (plain text)'),
    cc: z.string().optional().describe('CC (comma-separated)'),
    bcc: z.string().optional().describe('BCC (comma-separated)'),
    attachments: z.array(z.string()).optional().describe('File paths to attach'),
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
  'Authenticated CalDAV request to iCloud Calendar.',
  {
    method: z.enum(['PROPFIND', 'REPORT', 'GET', 'PUT', 'DELETE', 'MKCALENDAR']).describe('HTTP method'),
    path: z.string().describe('CalDAV path'),
    body: z.string().optional().describe('XML or iCal body'),
    depth: z.enum(['0', '1', 'infinity']).optional().describe('Depth header'),
    content_type: z.string().optional().describe('Content-Type override'),
    etag: z.string().optional().describe('If-Match ETag'),
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
  'Authenticated CardDAV request to iCloud Contacts.',
  {
    method: z.enum(['PROPFIND', 'REPORT', 'GET', 'PUT', 'DELETE']).describe('HTTP method'),
    path: z.string().describe('CardDAV path'),
    body: z.string().optional().describe('XML or vCard body'),
    depth: z.enum(['0', '1', 'infinity']).optional().describe('Depth header'),
    content_type: z.string().optional().describe('Content-Type override'),
    etag: z.string().optional().describe('If-Match ETag'),
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

// ---------------------------------------------------------------------------
// web_fetch — truncated web fetcher replacing the built-in WebFetch tool.
// Max ~500 tokens (~2000 chars) per source. News gets headline+sentence only;
// weather gets structured data only; general pages get the first 2000 chars.
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractWeatherJson(json: unknown): string {
  if (typeof json !== 'object' || json === null) return JSON.stringify(json).slice(0, 500);
  const j = json as Record<string, unknown>;
  // OpenWeatherMap structure
  if (j.main || j.weather) {
    const m = (j.main || {}) as Record<string, unknown>;
    const w = Array.isArray(j.weather) ? (j.weather[0] as Record<string, unknown>) : {};
    const wind = (j.wind || {}) as Record<string, unknown>;
    return JSON.stringify({
      temp_c: m.temp != null ? +(Number(m.temp) - 273.15).toFixed(1) : undefined,
      feels_like_c: m.feels_like != null ? +(Number(m.feels_like) - 273.15).toFixed(1) : undefined,
      humidity_pct: m.humidity,
      description: w.description,
      wind_kph: wind.speed != null ? +(Number(wind.speed) * 3.6).toFixed(1) : undefined,
    });
  }
  // wttr.in or generic structure — just truncate
  return JSON.stringify(json).slice(0, 800);
}

function extractNewsHtml(html: string): string {
  // Try to pull <h1> + first <p>
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const headline = h1 ? stripHtml(h1[1]).trim() : '';
  const para = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const firstPara = para ? stripHtml(para[1]).trim() : '';
  const firstSentence = firstPara.split(/(?<=[.!?])\s/)[0] ?? firstPara;
  if (headline) return `${headline}\n${firstSentence}`.slice(0, 500);
  return stripHtml(html).slice(0, 500);
}

server.tool(
  'web_fetch',
  'Fetch a URL. Returns truncated text (~500 tokens).',
  {
    url: z.string().describe('URL to fetch'),
  },
  async (args) => {
    const MAX_CHARS = 2000;
    try {
      const response = await fetch(args.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
          Accept: 'text/html,application/json,*/*',
        },
        signal: AbortSignal.timeout(12000),
      });

      const contentType = response.headers.get('content-type') ?? '';
      const urlLower = args.url.toLowerCase();
      const isWeather =
        urlLower.includes('weather') ||
        urlLower.includes('forecast') ||
        urlLower.includes('openweather') ||
        urlLower.includes('wttr.in') ||
        urlLower.includes('meteo');
      const isNews =
        urlLower.includes('/news/') ||
        urlLower.includes('/article') ||
        urlLower.includes('bbc.') ||
        urlLower.includes('reuters.') ||
        urlLower.includes('cnn.') ||
        urlLower.includes('rappler.') ||
        urlLower.includes('inquirer.') ||
        urlLower.includes('abs-cbn.');

      let result: string;

      if (contentType.includes('application/json')) {
        const json = await response.json();
        result = isWeather ? extractWeatherJson(json) : JSON.stringify(json).slice(0, MAX_CHARS);
      } else {
        const html = await response.text();
        if (isNews) {
          result = extractNewsHtml(html);
        } else if (isWeather) {
          result = stripHtml(html).slice(0, 600);
        } else {
          result = stripHtml(html).slice(0, MAX_CHARS);
        }
      }

      const byteLen = Buffer.byteLength(result, 'utf8');
      return {
        content: [
          {
            type: 'text' as const,
            text: `[web_fetch: ${args.url} — ${byteLen} bytes returned]\n\n${result}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `web_fetch error for ${args.url}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
