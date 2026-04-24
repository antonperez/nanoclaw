import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'OLLAMA_HOST',
  'OLLAMA_MODEL',
  'RESET_DEFAULT_WINDOW',
  'TELEGRAM_BOT_POOL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY =
  process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const DEFAULT_TRIGGER =
  process.env.TRIGGER || envConfig.TRIGGER || '@Andy';

export function buildTriggerPattern(trigger: string | undefined): RegExp {
  const t = trigger ?? DEFAULT_TRIGGER;
  return new RegExp(`^${escapeRegex(t.trim())}\\b`, 'i');
}

/** Alias used by upstream — keeps compatibility after rename. */
export const getTriggerPattern = buildTriggerPattern;

/** Default trigger regex built from DEFAULT_TRIGGER — for callers that don't have a per-group trigger. */
export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// DeepSeek — Anthropic-compatible external model backend
export const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL ||
  envConfig.DEEPSEEK_BASE_URL ||
  'https://api.deepseek.com/anthropic';
export const DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || envConfig.DEEPSEEK_API_KEY || '';
export const DEEPSEEK_MODEL =
  process.env.DEEPSEEK_MODEL || envConfig.DEEPSEEK_MODEL || 'deepseek-chat';

// Gemini — OpenAI-compatible default backend
export const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ||
  envConfig.GEMINI_BASE_URL ||
  'https://generativelanguage.googleapis.com/v1beta/openai';
export const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || envConfig.GEMINI_API_KEY || '';
export const GEMINI_MODEL =
  process.env.GEMINI_MODEL || envConfig.GEMINI_MODEL || 'gemini-2.5-flash';
export const GEMINI_CONFIGURED = !!GEMINI_API_KEY;

// Ollama — local model backend (explicit opt-in via "vault" or "ollama" keywords)
export const OLLAMA_HOST =
  process.env.OLLAMA_HOST || envConfig.OLLAMA_HOST || 'http://localhost:11434';
export const OLLAMA_DEFAULT_MODEL =
  process.env.OLLAMA_MODEL || envConfig.OLLAMA_MODEL || 'anton-vault';
// True only when OLLAMA_HOST is explicitly configured; false when falling back to localhost default
export const OLLAMA_CONFIGURED = !!(
  process.env.OLLAMA_HOST || envConfig.OLLAMA_HOST
);

// /reset command — clear Claude session and reload N messages of context
export const RESET_DEFAULT_WINDOW = parseInt(
  process.env.RESET_DEFAULT_WINDOW || envConfig.RESET_DEFAULT_WINDOW || '5',
  10,
);

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
