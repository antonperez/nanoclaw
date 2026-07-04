/**
 * Claude Code CLI runner.
 * Replaces direct @anthropic-ai/sdk calls with `claude --print --output-format stream-json`.
 * OAuth authentication is handled by the credential proxy (oauth mode) or ANTHROPIC_API_KEY.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Types ---

export interface DirectQueryOptions {
  prompt: string;
  systemPrompt: string;
  sessionId?: string;          // CLI UUID for --resume; undefined starts a new session
  mcpServerCommand: string;
  mcpServerArgs: string[];
  mcpServerEnv: Record<string, string>;
  maxTurns: number;
  model: string;
  allowedTools?: string[];     // Restrict Claude to these tools (omit = all tools)
  timeoutMs?: number;          // Kill CLI if it hasn't exited (default 8 min)
  log: (msg: string) => void;
}

export const QUERY_TIMEOUT_SENTINEL = '__QUERY_TIMEOUT__';
export const QUERY_CRASH_SENTINEL   = '__QUERY_CRASH__';

export interface DirectQueryResult {
  text: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  costUsd: number;
  turns: number;
  sessionId?: string;          // CLI UUID returned for next --resume
}

// --- Main query function ---

export async function directQuery(
  options: DirectQueryOptions,
): Promise<DirectQueryResult> {
  const { log } = options;

  // MCP config tells the CLI how to start the nanoclaw tool server
  const mcpConfig = {
    mcpServers: {
      nanoclaw: {
        command: options.mcpServerCommand,
        args: options.mcpServerArgs,
        env: {
          ...options.mcpServerEnv,
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '/home/node',
          ...(process.env.ANTHROPIC_BASE_URL
            ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }
            : {}),
          ...(process.env.ANTHROPIC_API_KEY
            ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
            : {}),
          ...(process.env.CLAUDE_CODE_OAUTH_TOKEN
            ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
            : {}),
        },
      },
    },
  };

  const tag = `${process.pid}-${Date.now()}`;
  const mcpConfigPath    = path.join(os.tmpdir(), `nanoclaw-mcp-${tag}.json`);
  const systemPromptPath = path.join(os.tmpdir(), `nanoclaw-sys-${tag}.txt`);

  // Write temp files; clean up both if either write fails so credentials don't linger on disk.
  try {
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
    fs.writeFileSync(systemPromptPath, options.systemPrompt);
  } catch (err) {
    try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    try { fs.unlinkSync(systemPromptPath); } catch { /* ignore */ }
    throw err;
  }

  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', options.model,
    '--system-prompt', `@${systemPromptPath}`,
    '--mcp-config', mcpConfigPath,
    '--max-turns', String(options.maxTurns),
    '--dangerously-skip-permissions',
  ];

  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','));
  }

  args.push('--', options.prompt); // '--' stops option parsing; prevents prompts like '--help' being treated as flags

  log(`Claude CLI: model=${options.model} session=${options.sessionId ?? 'new'} turns≤${options.maxTurns}`);

  const queryTimeoutMs = options.timeoutMs ?? 8 * 60_000; // 8 minutes default

  // Whitelist only what the Claude CLI itself needs — NANOCLAW_* vars belong
  // to the MCP server subprocess (already scoped in mcpServerEnv) and must
  // not leak into the CLI process.
  const cliEnv: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TERM', 'LANG', 'USER', 'LOGNAME']) {
    if (process.env[key]) cliEnv[key] = process.env[key]!;
  }
  if (process.env.ANTHROPIC_API_KEY)       cliEnv.ANTHROPIC_API_KEY       = process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_AUTH_TOKEN)    cliEnv.ANTHROPIC_AUTH_TOKEN    = process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.ANTHROPIC_BASE_URL)      cliEnv.ANTHROPIC_BASE_URL      = process.env.ANTHROPIC_BASE_URL;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) cliEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      env: cliEnv,
      cwd: '/workspace/group',
    });

    const totalUsage: DirectQueryResult['usage'] = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    let resultText: string | null = null;
    let costUsd = 0;
    let turns = 0;
    let cliSessionId: string | undefined;
    let lineBuffer = '';
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      log(`Claude CLI timeout after ${queryTimeoutMs}ms — killing process`);
      proc.kill('SIGKILL');
    }, queryTimeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;

          if (event.type === 'assistant') {
            const msg = event.message as Record<string, unknown> | undefined;
            const usage = msg?.usage as Record<string, number> | undefined;
            if (usage) {
              totalUsage.input_tokens                += usage.input_tokens                ?? 0;
              totalUsage.output_tokens               += usage.output_tokens               ?? 0;
              totalUsage.cache_read_input_tokens     += usage.cache_read_input_tokens     ?? 0;
              totalUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
            }
          }

          if (event.type === 'result') {
            resultText   = (event.result    as string | null) ?? null;
            costUsd      = (event.cost_usd  as number)       ?? 0;
            turns        = (event.num_turns as number)        ?? 0;
            cliSessionId = event.session_id as string | undefined;
            log(`Claude CLI done: turns=${turns} cost=$${costUsd.toFixed(4)} session=${cliSessionId ?? '?'}`);
          }
        } catch {
          // Non-JSON line (debug output) — ignore
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log(`[claude] ${text.slice(0, 300)}`);
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      try { fs.unlinkSync(mcpConfigPath);    } catch { /* ignore */ }
      try { fs.unlinkSync(systemPromptPath); } catch { /* ignore */ }

      if (timedOut) {
        log(`Claude CLI killed after ${queryTimeoutMs}ms timeout`);
        resolve({ text: QUERY_TIMEOUT_SENTINEL, usage: totalUsage, costUsd: 0, turns: 0 });
        return;
      }

      if (code !== 0 && !resultText) {
        log(`Claude CLI exited ${code} with no result — treating as crash`);
        resolve({ text: QUERY_CRASH_SENTINEL, usage: totalUsage, costUsd: 0, turns: 0 });
        return;
      }

      resolve({
        text: resultText,
        usage: totalUsage,
        costUsd,
        turns,
        sessionId: cliSessionId,
      });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(killTimer);
      try { fs.unlinkSync(mcpConfigPath);    } catch { /* ignore */ }
      try { fs.unlinkSync(systemPromptPath); } catch { /* ignore */ }
      log(`Claude CLI spawn error: ${err.message}`);
      resolve({ text: null, usage: totalUsage, costUsd: 0, turns: 0 });
    });
  });
}
