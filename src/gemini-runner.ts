import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { NewMessage } from './types.js';
import {
  GEMINI_API_KEY,
  GEMINI_BASE_URL,
  GEMINI_CONFIGURED,
  GEMINI_MODEL,
} from './config.js';
import { getMemoryHot } from './db.js';
import { logger } from './logger.js';
import { GEMINI_MAX_TOOL_TURNS } from './config.js';

interface GeminiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface GeminiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface GeminiResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: GeminiUsage;
  error?: { message: string };
}

// Gemini 2.5 Flash pricing (USD per 1M tokens). Update if Google adjusts.
const GEMINI_FLASH_INPUT_USD_PER_M = 0.3;
const GEMINI_FLASH_CACHED_INPUT_USD_PER_M = 0.075;
const GEMINI_FLASH_OUTPUT_USD_PER_M = 2.5;

export function logGeminiUsage(
  groupDir: string,
  groupFolder: string,
  usage: GeminiUsage | undefined,
): void {
  if (!usage) return;
  try {
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const promptTotal = usage.prompt_tokens ?? 0;
    const uncachedInput = Math.max(promptTotal - cached, 0);
    const output = usage.completion_tokens ?? 0;
    const total = usage.total_tokens ?? promptTotal + output;
    const cost =
      (uncachedInput * GEMINI_FLASH_INPUT_USD_PER_M) / 1_000_000 +
      (cached * GEMINI_FLASH_CACHED_INPUT_USD_PER_M) / 1_000_000 +
      (output * GEMINI_FLASH_OUTPUT_USD_PER_M) / 1_000_000;

    const logPath = path.join(groupDir, 'notes', 'gemini-token-log.csv');
    if (!fs.existsSync(logPath)) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(
        logPath,
        'timestamp,group,model,input_tokens,cached_tokens,output_tokens,total_tokens,cost_usd\n',
      );
    }
    const line = `${new Date().toISOString()},${groupFolder},${GEMINI_MODEL},${uncachedInput},${cached},${output},${total},${cost.toFixed(6)}\n`;
    fs.appendFileSync(logPath, line);
  } catch (err) {
    logger.warn({ err }, 'Gemini token log write failed');
  }
}

interface FileIndexCache {
  index: string;
  cachedAt: number;
}
const fileIndexCache = new Map<string, FileIndexCache>();
const FILE_INDEX_TTL_MS = 30_000;

function buildFileIndex(groupDir: string): string {
  const now = Date.now();
  const cached = fileIndexCache.get(groupDir);
  if (cached && now - cached.cachedAt < FILE_INDEX_TTL_MS) return cached.index;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(groupDir, { withFileTypes: true });
  } catch {
    return '';
  }

  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile() && entry.name.endsWith('.md')) {
      lines.push(`- ${entry.name}`);
    } else if (entry.isDirectory()) {
      try {
        const count = fs
          .readdirSync(path.join(groupDir, entry.name), {
            recursive: true,
          } as Parameters<typeof fs.readdirSync>[1])
          .filter(
            (f) => typeof f === 'string' && (f as string).endsWith('.md'),
          ).length;
        if (count > 0)
          lines.push(
            `- ${entry.name}/  (${count} files — use list_files to browse)`,
          );
      } catch {
        lines.push(`- ${entry.name}/`);
      }
    }
  }
  const index = lines.join('\n');
  fileIndexCache.set(groupDir, { index, cachedAt: now });
  return index;
}

function listFilesInDir(groupDir: string, relativePath: string): string {
  const resolved = path.resolve(groupDir, relativePath || '.');
  const base = path.resolve(groupDir);
  if (!resolved.startsWith(base)) return 'Error: path outside workspace.';
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return (
      entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .filter((n) => n.endsWith('/') || n.endsWith('.md'))
        .join('\n') || '(empty)'
    );
  } catch {
    return `Error: cannot read directory "${relativePath}".`;
  }
}

function safeResolveMd(groupDir: string, relativePath: string): string | null {
  if (!relativePath.endsWith('.md')) return null;
  const resolved = path.resolve(groupDir, relativePath);
  if (
    !resolved.startsWith(path.resolve(groupDir) + path.sep) &&
    resolved !== path.resolve(groupDir)
  )
    return null;
  return resolved;
}

function readMdFile(groupDir: string, relativePath: string): string {
  const resolved = safeResolveMd(groupDir, relativePath);
  if (!resolved)
    return 'Error: only .md files inside the workspace are allowed.';
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return `Error: file not found: ${relativePath}`;
  }
}

const execAsync = promisify(exec);

const BASH_ALLOWED_CMDS = new Set([
  'curl',
  'markitdown',
  'nanoclaw-vision',
  'ls',
  'find',
  'cat',
  'head',
  'tail',
  'echo',
  'wc',
  'grep',
  'pwd',
  'stat',
  'file',
  'mkdir',
]);
const BASH_MAX_OUTPUT = 50_000;

function checkBashCommand(command: string): string | null {
  if (/\$\(/.test(command) || /`/.test(command))
    return 'command substitution not allowed';
  // Block shell output redirects (>) but not comparison operators inside quoted strings.
  // curl -o is a flag, not a redirect, so this check is safe.
  if (/ >/.test(command))
    return 'shell redirects not allowed; use curl -o for file output';
  const segments = command.split(/\s*(?:\|{1,2}|&&)\s*/);
  for (const seg of segments) {
    const first = seg.trim().split(/\s+/)[0]?.toLowerCase();
    if (!first) continue;
    if (!BASH_ALLOWED_CMDS.has(first))
      return `'${first}' not allowed. Permitted: ${[...BASH_ALLOWED_CMDS].join(', ')}`;
  }
  return null;
}

async function runBash(groupDir: string, command: string): Promise<string> {
  const err = checkBashCommand(command);
  if (err) return `Error: ${err}`;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: groupDir,
      timeout: 60_000,
      maxBuffer: BASH_MAX_OUTPUT,
    });
    const out = (stdout || '').slice(0, BASH_MAX_OUTPUT);
    return (
      out || (stderr ? `stderr: ${stderr.slice(0, 1_000)}` : '(no output)')
    );
  } catch (e: unknown) {
    const ex = e as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    const detail =
      ((ex.stderr ?? '').slice(0, 2_000) || ex.message) ?? String(e);
    return `Error (exit ${ex.code ?? 1}): ${detail}`;
  }
}

// Files the LLM must not overwrite — identity and schema files
const WRITE_PROTECTED = new Set(['CLAUDE.md', 'REFERENCE.md']);

function writeMdFile(
  groupDir: string,
  relativePath: string,
  content: string,
): string {
  const resolved = safeResolveMd(groupDir, relativePath);
  if (!resolved)
    return 'Error: only .md files inside the workspace are allowed.';
  if (WRITE_PROTECTED.has(path.basename(resolved)))
    return `Error: ${path.basename(resolved)} is write-protected and cannot be overwritten.`;
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
    return `OK: wrote ${relativePath}`;
  } catch (err) {
    return `Error: could not write file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List markdown files and subdirectories inside a workspace directory. Use this to browse before read_file when you need to find a specific file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Relative path to a directory (e.g. "crm/contacts" or "projects"). Leave empty for root.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a markdown file from the group workspace. Use this to recall notes, context, or memory.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the .md file (e.g. "MEMORY.md")',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write or update a markdown file in the group workspace. Use this to save notes, tasks, or memory. Always write the full file content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the .md file (e.g. "MEMORY.md")',
          },
          content: {
            type: 'string',
            description: 'Full markdown content to write to the file.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command in the group workspace directory. Use for: curl (fetch URLs/PDFs), markitdown (convert PDF/doc to markdown), nanoclaw-vision (describe images), ls/find/cat (file ops). Pipe (|) and && chaining supported. No shell redirects (>), no rm, no sudo.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Shell command to run. CWD is the group workspace. Allowed commands per segment: curl, markitdown, nanoclaw-vision, ls, find, cat, head, tail, echo, wc, grep, pwd, stat, file, mkdir.',
          },
        },
        required: ['command'],
      },
    },
  },
];

async function geminiChat(
  messages: GeminiMessage[],
  useTools: boolean,
  attempt = 0,
): Promise<GeminiResponse> {
  const url = `${GEMINI_BASE_URL}/chat/completions`;
  const body: Record<string, unknown> = {
    model: GEMINI_MODEL,
    messages,
  };
  if (useTools) {
    body.tools = TOOLS;
    body.tool_choice = 'auto';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GEMINI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  // Retry on transient 503 (high demand) up to 2 extra attempts with backoff
  if (response.status === 503 && attempt < 2) {
    const delay = (attempt + 1) * 3000;
    logger.warn(
      { attempt: attempt + 1, delayMs: delay },
      'Gemini 503 — retrying',
    );
    await new Promise((r) => setTimeout(r, delay));
    return geminiChat(messages, useTools, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    throw new Error(`Gemini HTTP ${response.status}: ${errText}`);
  }

  return response.json() as Promise<GeminiResponse>;
}

function buildSystemPrompt(assistantName: string, groupDir: string): string {
  // Always inject CLAUDE.md so Gemini has user context without a tool-call round trip
  let claudeMd = '';
  try {
    const claudePath = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      claudeMd = `\n\n---\n${fs.readFileSync(claudePath, 'utf8').trim()}\n---`;
    }
  } catch {
    // ignore
  }

  const index = buildFileIndex(groupDir);
  const fileIndex = index
    ? `\n\nWorkspace (use list_files to browse a folder, read_file to read, write_file to save):\n${index}`
    : '\n\nNo memory files yet. Use write_file to create notes or memory (e.g. "MEMORY.md").';

  return [
    `You are ${assistantName}, a proactive personal assistant. Be concise and direct. Connect the dots across context — notice patterns, surface relevant past notes, and anticipate what the user needs.`,
    'Format for WhatsApp/Telegram: use *single asterisks* for bold, _underscores_ for italic, • for bullets. No ## headings, no **double stars**, no [markdown links](url).',
    claudeMd,
    fileIndex,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const MAX_HISTORY_MESSAGES = 30;
const HOT_MEMORY_HOURS = 48;
const HOT_MEMORY_MAX = 30;

/**
 * Drop user messages already represented in hot memory and any from-me echoes.
 * Only dedupes against past user events — assistant events are excluded from the
 * set so a user message that happens to repeat wording from a prior reply still
 * gets through.
 */
export function dedupeUserMessages(
  recentMessages: NewMessage[],
  hotEvents: { event_type: string; content: string }[],
): NewMessage[] {
  const hotUserMsgSet = new Set(
    hotEvents.filter((e) => e.event_type === 'user').map((e) => e.content),
  );
  return recentMessages.filter(
    (m) => !m.is_from_me && !hotUserMsgSet.has(m.content),
  );
}

export async function runGeminiAgent(
  messages: NewMessage[],
  assistantName: string,
  groupDir: string,
  onOutput: (text: string) => Promise<void>,
): Promise<'success' | 'error'> {
  if (!GEMINI_CONFIGURED) {
    logger.error('GEMINI_API_KEY is not set');
    return 'error';
  }

  logger.info({ model: GEMINI_MODEL }, 'Routing to Gemini');

  // Build conversation history from hot memory (includes Gemini's own replies)
  const groupFolder = path.basename(groupDir);
  const hotEvents = getMemoryHot(groupFolder, HOT_MEMORY_HOURS)
    .slice(-HOT_MEMORY_MAX)
    .filter((e) => e.event_type === 'user' || e.event_type === 'assistant');

  // Cap unprocessed messages to avoid token bloat on first run
  const recentMessages = messages
    .filter((m) => m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES);

  const newUserMessages = dedupeUserMessages(recentMessages, hotEvents);

  const hotConversation: GeminiMessage[] = hotEvents.map((e) => ({
    role: (e.event_type === 'assistant'
      ? 'assistant'
      : 'user') as GeminiMessage['role'],
    content: e.content,
  }));

  const conversation: GeminiMessage[] = [
    { role: 'system', content: buildSystemPrompt(assistantName, groupDir) },
    ...hotConversation,
    ...newUserMessages.map((m) => ({
      role: 'user' as GeminiMessage['role'],
      content: m.content as string,
    })),
  ];

  for (let turn = 0; turn < GEMINI_MAX_TOOL_TURNS; turn++) {
    let data: GeminiResponse;
    try {
      data = await geminiChat(conversation, true);
    } catch (err) {
      logger.error({ err }, 'Gemini request failed');
      return 'error';
    }

    logGeminiUsage(groupDir, groupFolder, data.usage);

    if (data.error) {
      logger.error({ error: data.error.message }, 'Gemini API error');
      return 'error';
    }

    const choice = data.choices?.[0];
    if (!choice) {
      logger.error('Gemini returned no choices');
      return 'error';
    }

    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const result = (msg.content ?? '').trim();
      if (result) {
        await onOutput(result);
        logger.info(
          { chars: result.length, turns: turn + 1 },
          'Gemini response sent',
        );
      }
      return 'success';
    }

    // Include tool_calls in assistant message — required by OpenAI format so tool results can be matched
    conversation.push({
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    for (const call of msg.tool_calls) {
      const { name, arguments: argsJson } = call.function;
      let args: Record<string, string>;
      try {
        args = JSON.parse(argsJson) as Record<string, string>;
      } catch {
        args = {};
      }

      let toolResult: string;
      if (name === 'list_files') {
        toolResult = listFilesInDir(groupDir, args.path ?? '');
        logger.debug({ dir: args.path }, 'Gemini list_files');
      } else if (name === 'read_file') {
        toolResult = readMdFile(groupDir, args.path ?? '');
        logger.debug({ file: args.path }, 'Gemini read_file');
      } else if (name === 'write_file') {
        toolResult = writeMdFile(groupDir, args.path ?? '', args.content ?? '');
        logger.debug({ file: args.path }, 'Gemini write_file');
      } else if (name === 'bash') {
        toolResult = await runBash(groupDir, args.command ?? '');
        logger.debug({ cmd: args.command }, 'Gemini bash');
      } else {
        toolResult = `Error: unknown tool "${name}"`;
      }

      conversation.push({
        role: 'tool',
        content: toolResult,
        tool_call_id: call.id,
        name,
      });
    }
  }

  logger.warn(
    { turns: GEMINI_MAX_TOOL_TURNS },
    'Gemini hit max tool turns, forcing final response',
  );
  try {
    const data = await geminiChat(conversation, false);
    logGeminiUsage(groupDir, groupFolder, data.usage);
    const result = (data.choices?.[0]?.message?.content ?? '').trim();
    if (result) await onOutput(result);
  } catch (err) {
    logger.error({ err }, 'Gemini final response failed');
    return 'error';
  }
  return 'success';
}
