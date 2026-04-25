import path from 'node:path';
import type { NewMessage } from './types.js';
import {
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
} from './config.js';
import { logger } from './logger.js';
import { logUsage } from './token-logger.js';

// DeepSeek-V3 (deepseek-chat) pricing USD per 1M tokens. Update if pricing changes.
const DS_INPUT_USD_PER_M = 0.27;
const DS_CACHED_USD_PER_M = 0.07;
const DS_OUTPUT_USD_PER_M = 1.1;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  usage?: AnthropicUsage;
  error?: { message: string };
}

function buildSystemPrompt(assistantName: string, _groupDir: string): string {
  return [
    `You are ${assistantName}, a personal assistant. Be concise and direct.`,
    'Format for WhatsApp/Telegram: use *single asterisks* for bold, _underscores_ for italic, • for bullets. No ## headings, no **double stars**, no [markdown links](url).',
  ].join('\n\n');
}

export async function runDeepSeekAgent(
  messages: NewMessage[],
  assistantName: string,
  groupDir: string,
  onOutput: (text: string) => Promise<void>,
): Promise<'success' | 'error'> {
  logger.info({ model: DEEPSEEK_MODEL }, 'Routing to DeepSeek');

  if (!DEEPSEEK_API_KEY) {
    logger.error('DEEPSEEK_API_KEY is not set');
    return 'error';
  }

  const conversation: AnthropicMessage[] = messages
    .filter((m) => m.content.trim())
    .map((m) => ({
      role: (m.is_from_me ? 'assistant' : 'user') as AnthropicMessage['role'],
      content: m.content,
    }));

  const url = `${DEEPSEEK_BASE_URL}/v1/messages`;
  const body = {
    model: DEEPSEEK_MODEL,
    max_tokens: 8192,
    system: buildSystemPrompt(assistantName, groupDir),
    messages: conversation,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': DEEPSEEK_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.error({ err }, 'DeepSeek request failed');
    return 'error';
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    logger.error(
      { status: response.status, err: errText },
      'DeepSeek HTTP error',
    );
    return 'error';
  }

  const data = (await response.json()) as AnthropicResponse;

  if (data.error) {
    logger.error({ error: data.error.message }, 'DeepSeek API error');
    return 'error';
  }

  const result = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (result) {
    await onOutput(result);
    logger.info({ chars: result.length }, 'DeepSeek response sent');
  }

  if (data.usage) {
    const u = data.usage;
    const input = u.input_tokens ?? 0;
    const cached = u.cache_read_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const total = input + cached + output;
    const cost =
      (input * DS_INPUT_USD_PER_M) / 1_000_000 +
      (cached * DS_CACHED_USD_PER_M) / 1_000_000 +
      (output * DS_OUTPUT_USD_PER_M) / 1_000_000;
    logUsage(
      path.basename(groupDir),
      DEEPSEEK_MODEL,
      input,
      cached,
      output,
      total,
      cost,
    );
  }

  return 'success';
}
