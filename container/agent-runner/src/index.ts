/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { directQuery } from './direct-api.js';
import { runDailyBrief } from './daily-brief.js';
import { classifyQuery, buildToolFilter } from './query-classifier.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

const TOKEN_LOG_PATH = '/workspace/group/notes/token-log.csv';

function logTokenUsage(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  costUsd: number,
): void {
  try {
    const timestamp = new Date().toISOString();
    const totalInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
    const totalTokens = totalInputTokens + outputTokens;

    const needsHeader = !fs.existsSync(TOKEN_LOG_PATH);
    if (needsHeader) {
      fs.mkdirSync(path.dirname(TOKEN_LOG_PATH), { recursive: true });
      fs.writeFileSync(
        TOKEN_LOG_PATH,
        'timestamp,session_id,input_tokens,cache_read_tokens,cache_creation_tokens,output_tokens,total_tokens,cost_usd\n',
      );
    }

    const line = `${timestamp},${sessionId},${inputTokens},${cacheReadTokens},${cacheCreationTokens},${outputTokens},${totalTokens},${costUsd.toFixed(6)}\n`;
    fs.appendFileSync(TOKEN_LOG_PATH, line);
    log(
      `Token usage: input=${inputTokens} cache_read=${cacheReadTokens} cache_creation=${cacheCreationTokens} output=${outputTokens} total=${totalTokens} cost=$${costUsd.toFixed(4)}`,
    );
  } catch (err) {
    log(`Token log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Build the system prompt from template + group CLAUDE.md.
 */
function buildSystemPrompt(assistantName?: string): string {
  const groupClaudeMdPath = '/workspace/group/CLAUDE.md';
  let groupClaudeMd = '';
  if (fs.existsSync(groupClaudeMdPath)) {
    groupClaudeMd = fs.readFileSync(groupClaudeMdPath, 'utf-8');
  }

  return [
    `You are ${assistantName || 'Andy'}, a personal AI assistant running inside NanoClaw.`,
    'Format for chat: *bold*, _italic_, `code`, ```blocks```. No ## headings or [links](url).',
    'Be direct and concise. Answer from memory when possible — each tool call costs a round-trip.',
    groupClaudeMd ? `\n---\n\n${groupClaudeMd}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Run a single query using the direct Anthropic Messages API.
 * Bypasses the Claude Code CLI/SDK to eliminate ~12K tokens of overhead.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
): Promise<{
  newSessionId?: string;
  closedDuringQuery: boolean;
}> {
  const systemPrompt = buildSystemPrompt(containerInput.assistantName);
  log(`System prompt: ${systemPrompt.length} chars (~${Math.round(systemPrompt.length / 4)} tokens)`);

  // Session path — reuse SDK-compatible location so host session tracking works
  const sessionDir = '/home/node/.claude/projects/-workspace-group';
  const sid = sessionId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionPath = path.join(sessionDir, `${sid}.jsonl`);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Smart model routing — classify query to pick cheapest adequate model
  const hasSession = !!sessionId;
  const routing = classifyQuery(prompt, containerInput.isScheduledTask ?? false, hasSession);

  // Allow CLAUDE_MODEL env to override routing (e.g. force opus for testing)
  const envModel = process.env.CLAUDE_MODEL;
  const MODEL_ALIASES: Record<string, string> = {
    sonnet: 'claude-sonnet-4-20250514',
    opus: 'claude-opus-4-20250514',
    haiku: 'claude-haiku-4-5-20251001',
  };
  const model = envModel ? (MODEL_ALIASES[envModel] || envModel) : routing.model;
  log(`Model routing: ${model} (reason: ${envModel ? 'env-override' : routing.reason})`);

  // Detect daily brief and use parallel pipeline instead of single query
  const isDailyBrief = (containerInput.isScheduledTask ?? false) &&
    /daily\s*brief|morning\s*brief|daily\s*digest/i.test(prompt);

  if (isDailyBrief) {
    log('Detected daily brief — using parallel section pipeline');
    const briefResult = await runDailyBrief(log);

    logTokenUsage(
      sid,
      briefResult.totalInputTokens,
      briefResult.totalOutputTokens,
      0,
      0,
      briefResult.costUsd,
    );

    writeOutput({
      status: 'success',
      result: briefResult.text,
      newSessionId: sid,
    });

    log(`Daily brief done. Tokens: ${briefResult.totalInputTokens + briefResult.totalOutputTokens}`);
    return { newSessionId: sid, closedDuringQuery: false };
  }

  // Conditional tool loading — only include tools the prompt actually needs
  const toolFilter = buildToolFilter(prompt, containerInput.isMain, routing.reason);

  // D: Zero history for scheduled tasks (stateless), E: lower max_tokens for simple queries
  const isScheduled = containerInput.isScheduledTask ?? false;
  const isSimple = routing.reason === 'simple-pattern' || routing.reason === 'short-no-history';

  const result = await directQuery({
    prompt,
    systemPrompt,
    sessionPath,
    mcpServerCommand: 'node',
    mcpServerArgs: [mcpServerPath],
    mcpServerEnv: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
    maxTurns: isScheduled ? 8 : 15,
    maxBudgetUsd: isScheduled ? 0.10 : 0.25,
    model,
    maxHistoryTokens: isScheduled ? 0 : 4000,
    maxResponseTokens: isSimple ? 512 : 4096,
    toolFilter,
    log,
  });

  // Log token usage
  logTokenUsage(
    sid,
    result.usage.input_tokens,
    result.usage.output_tokens,
    result.usage.cache_read_input_tokens,
    result.usage.cache_creation_input_tokens,
    result.costUsd,
  );

  // Emit result
  writeOutput({
    status: 'success',
    result: result.text,
    newSessionId: sid,
  });

  log(`Query done. Turns: ${result.turns}, cost: $${result.costUsd.toFixed(4)}`);

  // Check for close sentinel that may have arrived during the query
  const closedDuringQuery = shouldClose();
  return { newSessionId: sid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
