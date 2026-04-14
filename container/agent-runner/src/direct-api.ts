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

// Sonnet 4 pricing (per million tokens)
const COST_PER_M = {
  input: 3.0,
  output: 15.0,
  cache_read: 0.3,
  cache_creation: 3.75,
};

function calcCost(usage: DirectQueryResult['usage']): number {
  return (
    (usage.input_tokens * COST_PER_M.input +
      usage.output_tokens * COST_PER_M.output +
      usage.cache_read_input_tokens * COST_PER_M.cache_read +
      usage.cache_creation_input_tokens * COST_PER_M.cache_creation) /
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
    description:
      'Run a shell command. Working directory is /workspace/group. Timeout: 30s.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file. Returns numbered lines. Path is relative to /workspace/group or absolute.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to read' },
        offset: {
          type: 'number',
          description: 'Start line (0-based). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Max lines to read. Optional.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write content to a file. Creates directories as needed. Path relative to /workspace/group or absolute.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to write' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['file_path', 'content'],
    },
  },
];

async function executeBuiltinTool(
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

// --- Session persistence ---

function loadSession(sessionPath: string): Message[] {
  if (!fs.existsSync(sessionPath)) return [];
  try {
    const lines = fs.readFileSync(sessionPath, 'utf-8').trim().split('\n');
    return lines
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Message);
  } catch {
    return [];
  }
}

function appendToSession(sessionPath: string, message: Message): void {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.appendFileSync(sessionPath, JSON.stringify(message) + '\n');
}

// --- Main query function ---

export async function directQuery(
  options: DirectQueryOptions,
): Promise<DirectQueryResult> {
  const { log } = options;
  const client = new Anthropic();

  // Start MCP server
  const mcp = await startMcpClient(
    options.mcpServerCommand,
    options.mcpServerArgs,
    options.mcpServerEnv,
    log,
  );

  // Combine tool definitions
  const allTools: ToolDef[] = [...BUILTIN_TOOLS, ...mcp.tools];
  log(
    `Tools: ${allTools.length} (${BUILTIN_TOOLS.length} built-in + ${mcp.tools.length} MCP)`,
  );

  // Load or start session
  const messages: Message[] = loadSession(options.sessionPath);
  messages.push({ role: 'user', content: options.prompt });
  appendToSession(options.sessionPath, {
    role: 'user',
    content: options.prompt,
  });

  // Accumulate usage across turns
  const totalUsage: DirectQueryResult['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  let turns = 0;
  let finalText: string | null = null;

  try {
    while (turns < options.maxTurns) {
      turns++;
      log(`Turn ${turns}/${options.maxTurns}`);

      const response = await client.messages.create({
        model: options.model,
        max_tokens: 4096,
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

      log(
        `API response: stop=${response.stop_reason} blocks=${response.content.length} input=${u.input_tokens} output=${u.output_tokens}`,
      );

      // Check budget
      const costSoFar = calcCost(totalUsage);
      if (costSoFar > options.maxBudgetUsd) {
        log(`Budget exceeded: $${costSoFar.toFixed(4)} > $${options.maxBudgetUsd}`);
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
    costUsd: calcCost(totalUsage),
    turns,
  };
}
