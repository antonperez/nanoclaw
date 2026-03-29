import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/**
 * Download a Telegram file by file_id and save it under the group's files/ directory.
 * Returns the saved absolute path, or null on failure.
 */
async function downloadTelegramFile(
  api: Api,
  botToken: string,
  fileId: string,
  groupFolder: string,
  filename: string,
): Promise<string | null> {
  try {
    const fileInfo = await api.getFile(fileId);
    if (!fileInfo.file_path) {
      logger.warn({ fileId }, 'Telegram file has no file_path');
      return null;
    }

    const dir = path.join(GROUPS_DIR, groupFolder, 'files');
    fs.mkdirSync(dir, { recursive: true });

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 15); // YYYYMMDDHHmmss + fraction → trim to 14 chars + 1 digit
    const safeTimestamp = timestamp.replace(/\..+$/, ''); // drop ms
    const destPath = path.join(dir, `${safeTimestamp}-${filename}`);

    await new Promise<void>((resolve, reject) => {
      const url = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
      const file = fs.createWriteStream(destPath);
      https
        .get(url, (res) => {
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        })
        .on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
    });

    logger.info({ destPath, fileId }, 'Telegram file saved');
    return destPath;
  } catch (err) {
    logger.error({ err, fileId }, 'Failed to download Telegram file');
    return null;
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Lowercase usernames of pool bots (index matches poolApis)
const poolBotUsernames: string[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;
// Main bot API reference — set when TelegramChannel connects, used as pool fallback
let mainBotApi: Api | null = null;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      poolBotUsernames.push((me.username || '').toLowerCase());
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot
    if (mainBotApi) {
      const numericId = chatId.replace(/^tg:/, '');
      await sendTelegramMessage(mainBotApi, numericId, text);
    }
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    // Identity routing: if sender matches a pool bot's own username, use that
    // bot directly without renaming (bot already has the right name).
    const senderLower = sender.toLowerCase().replace(/^@/, '');
    const identityIdx = poolBotUsernames.indexOf(senderLower);
    if (identityIdx !== -1) {
      idx = identityIdx;
      senderBotMap.set(key, idx);
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned pool bot by identity (no rename)',
      );
    } else {
      // Fallback: round-robin assignment with rename
      idx = nextPoolIndex % poolApis.length;
      nextPoolIndex++;
      senderBotMap.set(key, idx);
      try {
        await poolApis[idx].setMyName(sender);
        await new Promise((r) => setTimeout(r, 2000));
        logger.info(
          { sender, groupFolder, poolIndex: idx },
          'Assigned and renamed pool bot',
        );
      } catch (err) {
        logger.warn(
          { sender, err },
          'Failed to rename pool bot (sending anyway)',
        );
      }
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands (allow /reset through for onMessage handler)
      if (
        ctx.message.text.startsWith('/') &&
        !ctx.message.text.trim().startsWith('/reset')
      )
        return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files to group's files/ dir, store message with path
    const handleMediaMessage = async (
      ctx: any,
      fileId: string | null,
      filename: string,
      placeholder: string,
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = `${placeholder}${caption}`;

      if (fileId && this.bot) {
        const savedPath = await downloadTelegramFile(
          this.bot.api,
          this.botToken,
          fileId,
          group.folder,
          filename,
        );
        if (savedPath) {
          content = `${placeholder} → saved to ${savedPath}${caption}`;
          // Confirm to sender
          try {
            await ctx.reply(`Saved: \`${savedPath}\``, {
              parse_mode: 'Markdown',
            });
          } catch (err) {
            logger.debug({ err }, 'Failed to send file-save confirmation');
          }
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => {
      // Photos come as array of sizes — take the largest (last)
      const photos = ctx.message.photo || [];
      const largest = photos[photos.length - 1];
      const fileId = largest?.file_id || null;
      const uniqueId = largest?.file_unique_id || Date.now().toString();
      handleMediaMessage(ctx, fileId, `photo-${uniqueId}.jpg`, '[Photo]');
    });
    this.bot.on('message:video', (ctx) => {
      const video = ctx.message.video;
      const filename =
        video?.file_name || `video-${video?.file_unique_id || Date.now()}.mp4`;
      handleMediaMessage(ctx, video?.file_id || null, filename, '[Video]');
    });
    this.bot.on('message:voice', (ctx) => {
      const voice = ctx.message.voice;
      handleMediaMessage(
        ctx,
        voice?.file_id || null,
        `voice-${voice?.file_unique_id || Date.now()}.ogg`,
        '[Voice message]',
      );
    });
    this.bot.on('message:audio', (ctx) => {
      const audio = ctx.message.audio;
      const filename =
        audio?.file_name || `audio-${audio?.file_unique_id || Date.now()}.mp3`;
      handleMediaMessage(ctx, audio?.file_id || null, filename, '[Audio]');
    });
    this.bot.on('message:document', (ctx) => {
      const doc = ctx.message.document;
      const displayName = doc?.file_name || 'file';
      const filename =
        doc?.file_name || `file-${doc?.file_unique_id || Date.now()}`;
      handleMediaMessage(
        ctx,
        doc?.file_id || null,
        filename,
        `[Document: ${displayName}]`,
      );
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      handleMediaMessage(ctx, null, '', `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) =>
      handleMediaMessage(ctx, null, '', '[Location]'),
    );
    this.bot.on('message:contact', (ctx) =>
      handleMediaMessage(ctx, null, '', '[Contact]'),
    );

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          mainBotApi = this.bot!.api;
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
