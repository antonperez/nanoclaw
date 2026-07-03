import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import nodemailer from 'nodemailer';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { sendPoolMessage } from './channels/telegram.js';
import { readEnvFile } from './env.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { ensureWithinBase, isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

/** Reset singleton for tests. */
export function _resetIpcWatcher(): void {
  ipcWatcherRunning = false;
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  txt: 'text/plain',
};

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function resolveAttachments(
  containerPaths: string[],
  groupFolder: string,
): { filename: string; path: string; contentType: string }[] {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  return containerPaths
    .flatMap((p) => {
      // Map /workspace/group/... → groups/{groupFolder}/...
      const relative = p.replace(/^\/workspace\/group\//, '');
      const hostPath = path.resolve(groupDir, relative);
      try {
        ensureWithinBase(groupDir, hostPath);
      } catch {
        return []; // silently drop paths that escape the group directory
      }
      return [{ filename: path.basename(p), path: hostPath, contentType: mimeForPath(p) }];
    })
    .filter((a) => fs.existsSync(a.path));
}

function createEmailTransporter() {
  const env = readEnvFile(['ICLOUD_EMAIL', 'ICLOUD_APP_PASSWORD']);
  const user = process.env.ICLOUD_EMAIL || env.ICLOUD_EMAIL;
  const pass = process.env.ICLOUD_APP_PASSWORD || env.ICLOUD_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: 'smtp.mail.me.com',
    port: 587,
    secure: false,
    auth: { user, pass },
  });
}

async function processIpcDir(
  baseDir: string,
  dir: string,
  label: string,
  sourceGroup: string,
  handler: (data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (!fs.existsSync(dir)) return;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    logger.error({ err, sourceGroup }, `Error reading IPC ${label} directory`);
    return;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      await handler(data);
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, `Error processing IPC ${label}`);
      const errorDir = path.join(baseDir, 'errors');
      fs.mkdirSync(errorDir, { recursive: true });
      try {
        fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
      } catch {
        // file may have already been removed
      }
    }
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      const emailsDir = path.join(ipcBaseDir, sourceGroup, 'emails');

      await processIpcDir(
        ipcBaseDir,
        messagesDir,
        'message',
        sourceGroup,
        async (data) => {
          if (data.type === 'message' && data.chatJid && data.text) {
            const targetGroup = registeredGroups[data.chatJid as string];
            if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
              if (data.sender && (data.chatJid as string).startsWith('tg:')) {
                await sendPoolMessage(
                  data.chatJid as string,
                  data.text as string,
                  data.sender as string,
                  sourceGroup,
                );
              } else {
                await deps.sendMessage(
                  data.chatJid as string,
                  data.text as string,
                );
              }
              logger.info(
                { chatJid: data.chatJid, sourceGroup },
                'IPC message sent',
              );
            } else {
              logger.warn(
                { chatJid: data.chatJid, sourceGroup },
                'Unauthorized IPC message attempt blocked',
              );
            }
          }
        },
      );

      await processIpcDir(
        ipcBaseDir,
        tasksDir,
        'task',
        sourceGroup,
        async (data) => {
          await processTaskIpc(
            data as Parameters<typeof processTaskIpc>[0],
            sourceGroup,
            isMain,
            deps,
          );
        },
      );

      await processIpcDir(
        ipcBaseDir,
        emailsDir,
        'email',
        sourceGroup,
        async (data) => {
          if (
            data.type === 'send_email' &&
            data.to &&
            data.subject &&
            data.body
          ) {
            const transporter = createEmailTransporter();
            if (!transporter) {
              logger.warn(
                { sourceGroup },
                'Email IPC received but ICLOUD_EMAIL/ICLOUD_APP_PASSWORD not configured',
              );
            } else {
              const env = readEnvFile(['ICLOUD_EMAIL']);
              const from = process.env.ICLOUD_EMAIL || env.ICLOUD_EMAIL;
              const resolved =
                Array.isArray(data.attachments) &&
                (data.attachments as string[]).length
                  ? resolveAttachments(
                      data.attachments as string[],
                      sourceGroup,
                    )
                  : [];
              const attachments = resolved.length ? resolved : undefined;
              await transporter.sendMail({
                from,
                to: data.to as string,
                cc: data.cc as string | undefined,
                bcc: data.bcc as string | undefined,
                subject: data.subject as string,
                text: data.body as string,
                attachments,
              });
              logger.info(
                {
                  to: data.to,
                  cc: data.cc,
                  bcc: data.bcc,
                  subject: data.subject,
                  attachments: attachments?.map((a) => a.filename),
                  sourceGroup,
                },
                'Email sent via iCloud SMTP',
              );
            }
          }
        },
      );
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;

    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Cron tasks notify the group chat if a cron-notify-jid file is present.
        const cronNotifyFile = path.join(
          GROUPS_DIR,
          targetFolder,
          'cron-notify-jid',
        );
        const effectiveChatJid =
          scheduleType === 'cron' && fs.existsSync(cronNotifyFile)
            ? fs.readFileSync(cronNotifyFile, 'utf8').trim()
            : targetJid;
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: effectiveChatJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: 'isolated',
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
