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
  log: (msg: string) => void;
}

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

// --- Cost calculation (kept for token logging compatibility) ---

const SONNET_PRICING = { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_creation: 3.75  };
const OPUS_PRICING   = { input: 15.0, output: 75.0, cache_read: 1.5,  cache_creation: 18.75 };
const HAIKU_PRICING  = { input: 0.8,  output: 4.0,  cache_read: 0.08, cache_creation: 1.0   };

function getPricing(model: string) {
  if (model.includes('opus'))  return OPUS_PRICING;
  if (model.includes('haiku')) return HAIKU_PRICING;
  return SONNET_PRICING;
}

export function calcCost(
  usage: DirectQueryResult['usage'],
  model?: string,
): number {
  const p = model ? getPricing(model) : SONNET_PRICING;
  return (
    (usage.input_tokens                * p.input          +
     usage.output_tokens               * p.output         +
     usage.cache_read_input_tokens     * p.cache_read     +
     usage.cache_creation_input_tokens * p.cache_creation) /
    1_000_000
  );
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

  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
  fs.writeFileSync(systemPromptPath, options.systemPrompt);

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

  args.push(options.prompt);

  log(`Claude CLI: model=${options.model} session=${options.sessionId ?? 'new'} turns≤${options.maxTurns}`);

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      env: { ...process.env },
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
      try { fs.unlinkSync(mcpConfigPath);    } catch { /* ignore */ }
      try { fs.unlinkSync(systemPromptPath); } catch { /* ignore */ }

      if (code !== 0 && !resultText) {
        log(`Claude CLI exited ${code} with no result`);
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
      try { fs.unlinkSync(mcpConfigPath);    } catch { /* ignore */ }
      try { fs.unlinkSync(systemPromptPath); } catch { /* ignore */ }
      log(`Claude CLI spawn error: ${err.message}`);
      resolve({ text: null, usage: totalUsage, costUsd: 0, turns: 0 });
    });
  });
}
