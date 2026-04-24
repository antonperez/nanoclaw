import fs from 'node:fs';
import path from 'node:path';
import type { NewMessage } from './types.js';
import {
  GEMINI_API_KEY,
  GEMINI_BASE_URL,
  GEMINI_CONFIGURED,
  GEMINI_MODEL,
} from './config.js';
import { logger } from './logger.js';

const MAX_TOOL_TURNS = 10;

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

interface GeminiResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  error?: { message: string };
}

function listMdFiles(groupDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(path.relative(groupDir, full));
      }
    }
  }
  walk(groupDir);
  return results;
}

function safeResolveMd(groupDir: string, relativePath: string): string | null {
  if (!relativePath.endsWith('.md')) return null;
  const resolved = path.resolve(groupDir, relativePath);
  if (!resolved.startsWith(path.resolve(groupDir) + path.sep) &&
      resolved !== path.resolve(groupDir)) return null;
  return resolved;
}

function readMdFile(groupDir: string, relativePath: string): string {
  const resolved = safeResolveMd(groupDir, relativePath);
  if (!resolved) return 'Error: only .md files inside the workspace are allowed.';
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return `Error: file not found: ${relativePath}`;
  }
}

function writeMdFile(groupDir: string, relativePath: string, content: string): string {
  const resolved = safeResolveMd(groupDir, relativePath);
  if (!resolved) return 'Error: only .md files inside the workspace are allowed.';
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
];

async function geminiChat(
  messages: GeminiMessage[],
  useTools: boolean,
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

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    throw new Error(`Gemini HTTP ${response.status}: ${errText}`);
  }

  return response.json() as Promise<GeminiResponse>;
}

function buildSystemPrompt(assistantName: string, groupDir: string): string {
  const mdFiles = listMdFiles(groupDir);
  const fileIndex =
    mdFiles.length > 0
      ? `\n\nAvailable memory files (use read_file to access):\n${mdFiles.map((f) => `- ${f}`).join('\n')}\n\nUse write_file to save notes, tasks, or anything worth remembering for next time.`
      : '\n\nNo memory files yet. Use write_file to create notes or memory (e.g. "MEMORY.md").';

  return [
    `You are ${assistantName}, a personal assistant. Be concise and direct.`,
    'Format for WhatsApp/Telegram: use *single asterisks* for bold, _underscores_ for italic, • for bullets. No ## headings, no **double stars**, no [markdown links](url).',
    fileIndex,
  ].join('\n\n');
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

  const conversation: GeminiMessage[] = [
    { role: 'system', content: buildSystemPrompt(assistantName, groupDir) },
    ...messages
      .filter((m) => m.content.trim())
      .map((m) => ({
        role: (m.is_from_me ? 'assistant' : 'user') as GeminiMessage['role'],
        content: m.content as string,
      })),
  ];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    let data: GeminiResponse;
    try {
      data = await geminiChat(conversation, true);
    } catch (err) {
      logger.error({ err }, 'Gemini request failed');
      return 'error';
    }

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
        logger.info({ chars: result.length, turns: turn + 1 }, 'Gemini response sent');
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
      if (name === 'read_file') {
        toolResult = readMdFile(groupDir, args.path ?? '');
        logger.debug({ file: args.path }, 'Gemini read_file');
      } else if (name === 'write_file') {
        toolResult = writeMdFile(groupDir, args.path ?? '', args.content ?? '');
        logger.debug({ file: args.path }, 'Gemini write_file');
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

  logger.warn({ turns: MAX_TOOL_TURNS }, 'Gemini hit max tool turns, forcing final response');
  try {
    const data = await geminiChat(conversation, false);
    const result = (data.choices?.[0]?.message?.content ?? '').trim();
    if (result) await onOutput(result);
  } catch (err) {
    logger.error({ err }, 'Gemini final response failed');
    return 'error';
  }
  return 'success';
}
