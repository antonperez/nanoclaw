import type { NewMessage } from './types.js';
import {
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
} from './config.js';
import { logger } from './logger.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
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

  return 'success';
}
