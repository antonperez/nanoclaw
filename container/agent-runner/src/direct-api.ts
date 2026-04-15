/**
 * Direct Anthropic Messages API caller — bypasses the Claude Code CLI/SDK.
 * Eliminates ~12K tokens of built-in CLI system prompt overhead per API call.
 *
 * Implements: tool execution loop, MCP server lifecycle, session persistence.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

// --- Types ---

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface DirectQueryOptions {
  prompt: string;
  systemPrompt: string;
  sessionPath: string;
  mcpServerCommand: string;
  mcpServerArgs: string[];
  mcpServerEnv: Record<string, string>;
  maxTurns: number;
  maxBudgetUsd: number;
  model: string;
  maxHistoryTokens?: number;
  maxResponseTokens?: number;
  toolFilter?: (tool: ToolDef) => boolean;
  log: (msg: string) => void;
}

interface DirectQueryResult {
  text: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  costUsd: number;
  turns: number;
}

type Message = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlock;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
type ToolUseBlock = Anthropic.ToolUseBlock;

// --- Cost calculation ---

// Per-model pricing (per million tokens)
const SONNET_PRICING = {
  input: 3.0,
  output: 15.0,
  cache_read: 0.3,
  cache_creation: 3.75,
};

const OPUS_PRICING = {
  input: 15.0,
  output: 75.0,
  cache_read: 1.5,
  cache_creation: 18.75,
};

const HAIKU_PRICING = {
  input: 0.8,
  output: 4.0,
  cache_read: 0.08,
  cache_creation: 1.0,
};

function getPricing(model: string) {
  if (model.includes('opus')) return OPUS_PRICING;
  if (model.includes('haiku')) return HAIKU_PRICING;
  return SONNET_PRICING; // default
}

export function calcCost(usage: DirectQueryResult['usage'], model?: string): number {
  const p = model ? getPricing(model) : SONNET_PRICING;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_read_input_tokens * p.cache_read +
      usage.cache_creation_input_tokens * p.cache_creation) /
    1_000_000
  );
}

// --- Built-in tools ---

const BASH_TIMEOUT_MS = 30_000;
const BASH_MAX_OUTPUT = 50_000;

function execBash(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', command],
      { timeout: BASH_TIMEOUT_MS, maxBuffer: 1024 * 1024, cwd: '/workspace/group' },
      (error, stdout, stderr) => {
        let result = '';
        if (stdout) result += stdout;
        if (stderr) result += (result ? '\n' : '') + stderr;
        if (error && !result) result = error.message;
        resolve(result.slice(0, BASH_MAX_OUTPUT));
      },
    );
  });
}

function readFile(filePath: string, offset?: number, limit?: number): string {
  try {
    const resolved = path.resolve('/workspace/group', filePath);
    if (!resolved.startsWith('/workspace/')) {
      return 'Error: path must be within /workspace/';
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    const lines = content.split('\n');
    const start = offset ?? 0;
    const end = limit ? start + limit : lines.length;
    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join('\n');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function writeFile(filePath: string, content: string): string {
  try {
    const resolved = path.resolve('/workspace/group', filePath);
    if (!resolved.startsWith('/workspace/')) {
      return 'Error: path must be within /workspace/';
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);
    return `Written ${content.length} bytes to ${filePath}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: 'bash',
    description: 'Run shell command in /workspace/group. 30s timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file (numbered lines). Path relative to /workspace/group or absolute.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number', description: 'Start line (0-based)' },
        limit: { type: 'number', description: 'Max lines' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write file, creates dirs. Path relative to /workspace/group or absolute.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
];

export async function executeBuiltinTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  switch (name) {
    case 'bash':
      return execBash(input.command as string);
    case 'read_file':
      return readFile(
        input.file_path as string,
        input.offset as number | undefined,
        input.limit as number | undefined,
      );
    case 'write_file':
      return writeFile(input.file_path as string, input.content as string);
    default:
      return null;
  }
}

// --- MCP client ---

async function startMcpClient(
  command: string,
  args: string[],
  env: Record<string, string>,
  log: (msg: string) => void,
): Promise<{ client: Client; tools: ToolDef[]; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const client = new Client({ name: 'nanoclaw-direct', version: '1.0.0' });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();
  const tools: ToolDef[] = mcpTools.map((t) => ({
    name: `mcp__nanoclaw__${t.name}`,
    description: t.description || t.name,
    input_schema: (t.inputSchema as Record<string, unknown>) || {
      type: 'object',
      properties: {},
    },
  }));

  log(`MCP connected: ${tools.length} tools`);
  return {
    client,
    tools,
    close: async () => {
      await client.close();
    },
  };
}

async function callMcpTool(
  client: Client,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  // Strip mcp__nanoclaw__ prefix
  const mcpName = toolName.replace(/^mcp__nanoclaw__/, '');
  const result = await client.callTool({ name: mcpName, arguments: input });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');
  return text || JSON.stringify(result.content);
}

// --- Token estimation (module-scope for use in compression + truncation) ---

function estimateTokens(msg: Message): number {
  if (typeof msg.content === 'string') return Math.ceil(msg.content.length / 4);
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, block) => {
      if ('text' in block && typeof block.text === 'string') return sum + Math.ceil(block.text.length / 4);
      if ('content' in block && typeof block.content === 'string') return sum + Math.ceil(block.content.length / 4);
      return sum + 50; // tool_use blocks etc
    }, 0);
  }
  return 50;
}

// --- Sliding window history compression ---

async function compressHistory(
  messages: Message[],
  log: (msg: string) => void,
): Promise<{
  messages: Message[];
  compressed: boolean;
  tokensBefore: number;
  tokensAfter: number;
  compressionUsage?: { input_tokens: number; output_tokens: number };
}> {
  const THRESHOLD = 12;
  const KEEP_COUNT = 6;

  const tokensBefore = messages.reduce((s, m) => s + estimateTokens(m), 0);

  if (messages.length <= THRESHOLD) {
    return { messages, compressed: false, tokensBefore, tokensAfter: tokensBefore };
  }

  const toCompress = messages.slice(0, messages.length - KEEP_COUNT);
  const toKeep = messages.slice(messages.length - KEEP_COUNT);

  // Build a text transcript of old messages for the summarizer
  const transcript = toCompress.map((m) => {
    const role = m.role;
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b) => 'text' in b)
              .map((b) => (b as { text: string }).text)
              .join(' ')
          : '[non-text]';
    return `${role}: ${text.slice(0, 500)}`;
  }).join('\n');

  try {
    const haiku = new Anthropic({ maxRetries: 4 });
    const summaryResponse = await haiku.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation context. Preserve: names, numbers, dates, decisions, pending actions, file paths mentioned, and any commitments made. Use bullet points, not prose. Be concise but never drop actionable details.\n\n${transcript.slice(0, 3000)}`,
        },
      ],
    });

    const summaryText = summaryResponse.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join(' ');

    const summaryMessage: Message = {
      role: 'user',
      content: `[Previous conversation context]\n${summaryText}`,
    };

    const compressed = [summaryMessage, ...toKeep];
    const tokensAfter = compressed.reduce((s, m) => s + estimateTokens(m), 0);

    log(
      `History compressed: ${messages.length} msgs (~${tokensBefore} tok) → ${compressed.length} msgs (~${tokensAfter} tok)`,
    );

    return {
      messages: compressed,
      compressed: true,
      tokensBefore,
      tokensAfter,
      compressionUsage: {
        input_tokens: summaryResponse.usage.input_tokens,
        output_tokens: summaryResponse.usage.output_tokens,
      },
    };
  } catch (err) {
    log(`History compression warning: ${err instanceof Error ? err.message : String(err)} — skipping compression`);
    return { messages, compressed: false, tokensBefore, tokensAfter: tokensBefore };
  }
}

// --- Session persistence ---

export function loadSession(sessionPath: string): Message[] {
  if (!fs.existsSync(sessionPath)) return [];
  try {
    const lines = fs.readFileSync(sessionPath, 'utf-8').trim().split('\n');
    const messages = lines
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter((m): m is Message =>
        m !== null && typeof m === 'object' && 'role' in m &&
        (m.role === 'user' || m.role === 'assistant'),
      );
    return messages;
  } catch {
    return [];
  }
}

export function appendToSession(sessionPath: string, message: Message): void {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.appendFileSync(sessionPath, JSON.stringify(message) + '\n');
}

// --- Main query function ---

export async function directQuery(
  options: DirectQueryOptions,
): Promise<DirectQueryResult> {
  const { log } = options;
  const client = new Anthropic({ maxRetries: 4 });

  // Start MCP server
  const mcp = await startMcpClient(
    options.mcpServerCommand,
    options.mcpServerArgs,
    options.mcpServerEnv,
    log,
  );

  // Combine tool definitions, apply optional filter
  let allTools: ToolDef[] = [...BUILTIN_TOOLS, ...mcp.tools];
  if (options.toolFilter) {
    allTools = allTools.filter(options.toolFilter);
  }
  log(
    `Tools: ${allTools.length} loaded${options.toolFilter ? ' (filtered)' : ''}`,
  );

  // Load or start session
  const messages: Message[] = loadSession(options.sessionPath);
  messages.push({ role: 'user', content: options.prompt });
  appendToSession(options.sessionPath, {
    role: 'user',
    content: options.prompt,
  });

  // Accumulate usage across turns (declared early so compression cost can be added)
  const totalUsage: DirectQueryResult['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  // Running cost sum — tracks mixed-model turns accurately
  let totalCostUsd = 0;

  // Token-budget session truncation: estimate message tokens and trim from
  // the front when total history exceeds the budget. More accurate than a
  // flat message count since tool-result messages vary wildly in size.
  const MAX_HISTORY_TOKENS = options.maxHistoryTokens ?? 8000;

  // Sliding window compression: summarize old messages via Haiku before truncation.
  // Skip for scheduled tasks that use 0 history (stateless by design).
  if (MAX_HISTORY_TOKENS > 0) {
    const compression = await compressHistory(messages, log);
    if (compression.compressed) {
      messages.length = 0;
      messages.push(...compression.messages);
    }
    if (compression.compressionUsage) {
      totalUsage.input_tokens += compression.compressionUsage.input_tokens;
      totalUsage.output_tokens += compression.compressionUsage.output_tokens;
      const compressionCost = calcCost({
        input_tokens: compression.compressionUsage.input_tokens,
        output_tokens: compression.compressionUsage.output_tokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }, 'claude-haiku-4-5-20251001');
      totalCostUsd += compressionCost;
      log(`Compression cost: $${compressionCost.toFixed(4)} (Haiku)`);
    }
  }

  let historyTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  while (historyTokens > MAX_HISTORY_TOKENS && messages.length > 1) {
    historyTokens -= estimateTokens(messages[0]);
    messages.shift();
  }
  if (historyTokens > 0) {
    log(`Session history: ${messages.length} messages, ~${historyTokens} tokens`);
  }

  let turns = 0;
  let finalText: string | null = null;
  let lastStopReason: string | null = null;

  try {
    while (turns < options.maxTurns) {
      turns++;

      // Use the routed model for all turns. Tool-result turns require the
      // same reasoning quality as turn 1 — the model must interpret results,
      // decide next actions, and synthesize a response following complex system
      // prompt rules (filing, proactive connections, workspace scanning).
      const turnModel: string = options.model;

      log(`Turn ${turns}/${options.maxTurns}`);

      const response = await client.messages.create({
        model: turnModel,
        max_tokens: options.maxResponseTokens ?? 4096,
        system: [
          {
            type: 'text',
            text: options.systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: allTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        })),
        messages,
      });

      // Accumulate usage
      const u = response.usage;
      totalUsage.input_tokens += u.input_tokens;
      totalUsage.output_tokens += u.output_tokens;
      totalUsage.cache_read_input_tokens +=
        (u as unknown as Record<string, number>).cache_read_input_tokens ?? 0;
      totalUsage.cache_creation_input_tokens +=
        (u as unknown as Record<string, number>).cache_creation_input_tokens ?? 0;

      lastStopReason = response.stop_reason;

      // Accumulate per-turn cost using the actual model used for this turn
      const turnCost = calcCost({
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: (u as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: (u as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
      }, turnModel);
      totalCostUsd += turnCost;

      log(
        `API response: stop=${response.stop_reason} blocks=${response.content.length} input=${u.input_tokens} output=${u.output_tokens}`,
      );

      // Check budget
      if (totalCostUsd > options.maxBudgetUsd) {
        log(`Budget exceeded: $${totalCostUsd.toFixed(4)} > $${options.maxBudgetUsd}`);
        break;
      }

      // Extract text and tool_use blocks
      const textBlocks = response.content.filter(
        (b): b is ContentBlock & { type: 'text' } => b.type === 'text',
      );
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );

      if (textBlocks.length > 0) {
        finalText = textBlocks.map((b) => b.text).join('\n');
      }

      // Save assistant message to session
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content as Anthropic.ContentBlockParam[],
      };
      messages.push(assistantMsg);
      appendToSession(options.sessionPath, assistantMsg);

      // If no tool use, we're done
      if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
        break;
      }

      // Execute tools and collect results
      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const input = toolUse.input as Record<string, unknown>;
        log(`Tool call: ${toolUse.name}`);

        let result: string;
        try {
          if (toolUse.name.startsWith('mcp__nanoclaw__')) {
            result = await callMcpTool(mcp.client, toolUse.name, input);
          } else {
            const builtinResult = await executeBuiltinTool(toolUse.name, input);
            result = builtinResult ?? `Unknown tool: ${toolUse.name}`;
          }
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Truncate large results to save tokens
        const maxResultLen = 10_000;
        if (result.length > maxResultLen) {
          result = result.slice(0, maxResultLen) + `\n... (truncated from ${result.length} chars)`;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Add tool results as user message
      const toolResultMsg: Message = { role: 'user', content: toolResults };
      messages.push(toolResultMsg);
      appendToSession(options.sessionPath, toolResultMsg);
    }
  } finally {
    await mcp.close().catch(() => {});
  }

  return {
    text: finalText,
    usage: totalUsage,
    costUsd: totalCostUsd,
    turns,
  };
}
