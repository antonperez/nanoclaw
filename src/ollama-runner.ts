import fs from 'node:fs';
import path from 'node:path';
import type { NewMessage } from './types.js';
import { OLLAMA_DEFAULT_MODEL, OLLAMA_HOST } from './config.js';
import { logger } from './logger.js';

const MAX_TOOL_TURNS = 10;

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, string> };
}

interface OllamaResponse {
  message: OllamaMessage;
  done: boolean;
  error?: string;
}

/** List all .md files under groupDir, relative to groupDir. */
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

/** Read a .md file; restricted to groupDir, .md only. */
function readMdFile(groupDir: string, relativePath: string): string {
  if (!relativePath.endsWith('.md')) {
    return 'Error: only .md files can be read.';
  }
  const resolved = path.resolve(groupDir, relativePath);
  if (!resolved.startsWith(path.resolve(groupDir))) {
    return 'Error: path traversal not allowed.';
  }
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return `Error: file not found: ${relativePath}`;
  }
}

function buildSystemPrompt(assistantName: string, groupDir: string): string {
  const mdFiles = listMdFiles(groupDir);
  const index =
    mdFiles.length > 0
      ? `\n\nAvailable memory files (use read_file to read any of them):\n${mdFiles.map((f) => `- ${f}`).join('\n')}`
      : '';
  // Always inject CLAUDE.md directly so rules are always visible
  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
  } catch {
    /* no CLAUDE.md */
  }
  const rules = claudeMd ? `\n\n---\n# CLAUDE.md (rules)\n${claudeMd}` : '';
  return `You are ${assistantName}, a helpful personal assistant. Be concise and direct.${rules}${index}`;
}

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read a markdown file from the group workspace. Use this to recall notes, tasks, or knowledge.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the .md file (e.g. "notes/TASKS.md")',
        },
      },
      required: ['path'],
    },
  },
};

async function ollamaChat(
  messages: OllamaMessage[],
  tools: boolean,
): Promise<OllamaResponse> {
  const url = `${OLLAMA_HOST}/api/chat`;
  const body: Record<string, unknown> = {
    model: OLLAMA_DEFAULT_MODEL,
    messages,
    stream: false,
  };
  if (tools) body.tools = [READ_FILE_TOOL];

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => 'unknown');
    throw new Error(`Ollama HTTP ${response.status}: ${err}`);
  }

  return response.json() as Promise<OllamaResponse>;
}

/**
 * Run a query against the local Ollama instance with read_file tool support.
 * Loops until Ollama stops calling tools, then calls onOutput with the final text.
 */
export async function runOllamaAgent(
  messages: NewMessage[],
  assistantName: string,
  groupDir: string,
  onOutput: (text: string) => Promise<void>,
): Promise<'success' | 'error'> {
  logger.info({ model: OLLAMA_DEFAULT_MODEL }, 'Routing to Ollama');

  const conversation: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt(assistantName, groupDir) },
    ...messages.map((m) => ({
      role: (m.is_from_me ? 'assistant' : 'user') as OllamaMessage['role'],
      content: m.content,
    })),
  ];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    let data: OllamaResponse;
    try {
      data = await ollamaChat(conversation, true);
    } catch (err) {
      logger.error({ err }, 'Ollama request failed');
      return 'error';
    }

    if (data.error) {
      logger.error({ error: data.error }, 'Ollama error');
      return 'error';
    }

    const msg = data.message;
    conversation.push(msg);

    // No tool calls — final text response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const result = (msg.content ?? '').trim();
      if (result) {
        await onOutput(result);
        logger.info(
          { chars: result.length, turns: turn + 1 },
          'Ollama response sent',
        );
      }
      return 'success';
    }

    // Execute tool calls
    for (const call of msg.tool_calls) {
      const { name, arguments: args } = call.function;
      let toolResult: string;
      if (name === 'read_file') {
        const filePath = args.path ?? '';
        toolResult = readMdFile(groupDir, filePath);
        logger.debug({ file: filePath }, 'Ollama read_file tool call');
      } else {
        toolResult = `Error: unknown tool "${name}"`;
      }
      conversation.push({ role: 'tool', content: toolResult });
    }
  }

  logger.warn(
    { turns: MAX_TOOL_TURNS },
    'Ollama hit max tool turns, forcing final response',
  );
  // Force a final answer without tools
  try {
    const data = await ollamaChat(conversation, false);
    const result = (data.message?.content ?? '').trim();
    if (result) await onOutput(result);
  } catch (err) {
    logger.error({ err }, 'Ollama final response failed');
    return 'error';
  }
  return 'success';
}
