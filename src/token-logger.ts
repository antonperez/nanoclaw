import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

const HEADER =
  'timestamp,group,model,input_tokens,cached_tokens,output_tokens,total_tokens,cost_usd';

export function logUsage(
  group: string,
  model: string,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  totalTokens: number,
  costUsd: number,
  logDir?: string,
): void {
  try {
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const logPath = path.join(logDir ?? STORE_DIR, `tokens-${month}.csv`);
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, HEADER + '\n');
    }
    const line =
      `${new Date().toISOString()},${group},${model},` +
      `${inputTokens},${cachedTokens},${outputTokens},${totalTokens},${costUsd.toFixed(6)}\n`;
    fs.appendFileSync(logPath, line);
  } catch (err) {
    logger.warn({ err }, 'token log write failed');
  }
}
