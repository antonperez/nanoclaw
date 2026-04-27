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
    text: z.string(),
    sender: z.string().optional().describe('Bot identity name'),
    chat_jid: z.string().optional(),
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
  'manage_tasks',
  'Manage scheduled tasks. Local times, no Z suffix.',
  {
    action: z.enum(['create', 'list', 'update', 'pause', 'resume', 'cancel']),
    task_id: z.string().optional(),
    prompt: z.string().optional().describe('Task instructions'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
    schedule_value: z.string().optional().describe('Cron/ms/ISO datetime'),
    script: z.string().optional().describe('Guard script → JSON {wakeAgent,data}'),
    target_group_jid: z.string().optional(),
  },
  async (args) => {
    if (args.action === 'list') {
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
    }

    if (args.action === 'pause' || args.action === 'resume' || args.action === 'cancel') {
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
    }

    if (args.action === 'update') {
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
    }

    // action === 'create'
    if (!args.prompt || !args.schedule_type || !args.schedule_value) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'create action requires prompt, schedule_type, and schedule_value.',
          },
        ],
        isError: true,
      };
    }

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
  'register_group',
  'Register a new chat/group (main group only).',
  {
    jid: z.string(),
    name: z.string(),
    folder: z.string().describe('Channel-prefixed, e.g. "telegram_dev-team"'),
    trigger: z.string().describe('e.g. "@Andy"'),
    requiresTrigger: z.boolean().optional(),
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
    to: z.string(),
    subject: z.string(),
    body: z.string().describe('Plain text'),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    attachments: z.array(z.string()).optional().describe('File paths'),
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
  'dav_request',
  'CalDAV/CardDAV request to iCloud.',
  {
    type: z.enum(['caldav', 'carddav']),
    method: z.enum(['PROPFIND', 'REPORT', 'GET', 'PUT', 'DELETE', 'MKCALENDAR']),
    path: z.string(),
    body: z.string().optional().describe('XML or iCal/vCard'),
    depth: z.enum(['0', '1', 'infinity']).optional(),
    content_type: z.string().optional(),
    etag: z.string().optional().describe('If-Match'),
  },
  async (args) => {
    try {
      const extra: Record<string, string> = {};
      if (args.depth) extra['Depth'] = args.depth;
      if (args.content_type) extra['Content-Type'] = args.content_type;
      if (args.etag) extra['If-Match'] = args.etag;
      const { status, text } = await davFetch(args.type, args.method, args.path, args.body, extra);
      return { content: [{ type: 'text' as const, text: `HTTP ${status}\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `DAV error: ${err}` }], isError: true };
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
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; } })
    .replace(/\s+/g, ' ')
    .trim();
}

async function readCapped(r: Response, maxBytes = 2_000_000): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return (await r.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try { await reader.cancel(); } catch { /* noop */ }
  return new TextDecoder('utf-8', { fatal: false }).decode(
    Buffer.concat(chunks.map(c => Buffer.from(c)))
  ).slice(0, maxBytes);
}

function isSafeUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'only http/https allowed' };
  const host = u.hostname.toLowerCase();
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(host)) return { ok: false, reason: 'private IP blocked' };
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return { ok: false, reason: 'private IP blocked' };
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.internal')) return { ok: false, reason: 'local host blocked' };
  if (host === '::1' || host.startsWith('[::1]') || host.startsWith('[fc') || host.startsWith('[fd')) return { ok: false, reason: 'IPv6 local blocked' };
  return { ok: true, url: u };
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

const MEDIUM_DOMAINS = new Set([
  'medium.com',
  'levelup.gitconnected.com',
  'uxdesign.cc',
  'uxplanet.org',
  'codeburst.io',
  'itnext.io',
]);

function isMediumNetwork(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^amp\./, '');
    if (MEDIUM_DOMAINS.has(host)) return true;
    if (host.endsWith('.medium.com')) return true;
    return false;
  } catch { return false; }
}

function toScribeUrl(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^amp\./, '');
  const sub = host.match(/^([a-z0-9-]+)\.medium\.com$/);
  if (sub && sub[1] !== 'cdn-images' && sub[1] !== 'miro') {
    u.pathname = `/@${sub[1]}${u.pathname}`;
  }
  u.hostname = 'scribe.rip';
  u.protocol = 'https:';
  u.port = '';
  ['source', 'gi', 'sk', '_branch_match_id', '_branch_referrer'].forEach(p => u.searchParams.delete(p));
  return u.toString();
}

function pickLongest(html: string, tag: 'article' | 'main'): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!best || m[1].length > best.length) best = m[1];
  }
  return best;
}

function extractArticleBody(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]) : '';
  let body = pickLongest(html, 'article') ?? pickLongest(html, 'main') ?? html;
  body = body
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ');
  const text = stripHtml(body);
  return title ? `${title}\n\n${text}` : text;
}

function cleanJinaMarkdown(md: string): string {
  const contentIdx = md.indexOf('Markdown Content:');
  let body = contentIdx >= 0 ? md.slice(contentIdx + 'Markdown Content:'.length).trimStart() : md;
  body = body
    .replace(/^\[Open in app\][^\n]*\n+/gm, '')
    .replace(/^\[?Sign in\]?[^\n]*\n+/gm, '')
    .replace(/^Sign up\s*$/gm, '')
    .replace(/^(Follow|Listen|Share|Save)\s*$/gm, '')
    .replace(/^\[Get unlimited access[^\]]*\][^\n]*\n+/gm, '')
    .replace(/^!\[[^\]]*\]\(https?:\/\/(miro|cdn-images-\d+)\.medium\.com[^)]*\)\s*$/gm, '')
    .replace(/^\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  const titleMatch = md.match(/^Title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';
  return title ? `${title}\n\n${body}` : body;
}

async function fetchMediumArticle(originalUrl: string, maxChars: number): Promise<string | null> {
  const u = new URL(originalUrl);
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^amp\./, '');
  const scribeCompatible = host === 'medium.com' || host.endsWith('.medium.com');

  const tryScribe = async (): Promise<string> => {
    const scribeUrl = toScribeUrl(originalUrl);
    const r = await fetch(scribeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`scribe HTTP ${r.status}`);
    const html = await readCapped(r);
    const extracted = extractArticleBody(html);
    const looksLikePaywall =
      /member[- ]only story/i.test(extracted) ||
      /sign up to (read|discover)/i.test(extracted.slice(0, 1500)) ||
      /you've read all your free/i.test(extracted);
    const looksLikeHomepage = /^Medium\b/i.test(extracted) && extracted.length < 2000;
    if (!extracted || extracted.length <= 400 || looksLikePaywall || looksLikeHomepage) throw new Error('scribe returned wall/homepage');
    return extracted.slice(0, maxChars);
  };

  const tryJina = async (): Promise<string> => {
    const r = await fetch(`https://r.jina.ai/${originalUrl}`, {
      headers: {
        'User-Agent': 'NanoClaw/1.0',
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`jina HTTP ${r.status}`);
    const md = await readCapped(r);
    const cleaned = cleanJinaMarkdown(md);
    const isWalled =
      /^Title:\s*Medium\s*$/m.test(md.slice(0, 300)) ||
      cleaned.length < 400 ||
      /sign up to (continue|read|discover)/i.test(cleaned.slice(0, 1500)) ||
      /member[- ]only story/i.test(cleaned.slice(0, 1500)) ||
      /^Get unlimited access/m.test(cleaned.slice(0, 800));
    if (isWalled) throw new Error('jina returned wall');
    return cleaned.slice(0, maxChars);
  };

  const sources: Promise<string>[] = scribeCompatible ? [tryScribe(), tryJina()] : [tryJina()];
  try {
    return await Promise.any(sources);
  } catch (e) {
    console.error(`[web_fetch] all sources failed for ${originalUrl}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

server.tool(
  'web_fetch',
  'Fetch a URL. Returns truncated text: ~2000 chars for general pages, ~8000 chars for Medium articles (auto-routed via scribe.rip / r.jina.ai). News pages return headline + first sentence. Weather pages return structured JSON.',
  {
    url: z.string(),
  },
  async (args) => {
    const MAX_CHARS = 2000;
    const MAX_CHARS_ARTICLE = 8000;

    const safe = isSafeUrl(args.url);
    if (!safe.ok) {
      return { content: [{ type: 'text' as const, text: `web_fetch refused: ${safe.reason}` }], isError: true };
    }

    try {
      if (isMediumNetwork(args.url)) {
        const article = await fetchMediumArticle(args.url, MAX_CHARS_ARTICLE);
        if (article) {
          return { content: [{ type: 'text' as const, text: `[web_fetch: ${args.url}]\n\n${article}` }] };
        }
        return {
          content: [{ type: 'text' as const, text: `[web_fetch: ${args.url}]\n\nUnable to retrieve article (scribe.rip and r.jina.ai both failed or returned a paywall). Try again later.` }],
          isError: true,
        };
      }

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
        const html = await readCapped(response);
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
