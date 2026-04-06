import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock variables so they're available inside vi.mock factories
const {
  mockSendMail,
  mockCreateTransport,
  mockReaddir,
  mockStat,
  mockExistsSync,
  mockReadFileSync,
  mockUnlinkSync,
  mockMkdirSync,
} = vi.hoisted(() => {
  const mockSendMail = vi.fn().mockResolvedValue({});
  return {
    mockSendMail,
    mockCreateTransport: vi.fn(() => ({ sendMail: mockSendMail })),
    mockReaddir: vi.fn(),
    mockStat: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockUnlinkSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-ipc-test',
  IPC_POLL_INTERVAL: 100,
  TIMEZONE: 'UTC',
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./channels/telegram.js', () => ({
  sendPoolMessage: vi.fn(),
  initBotPool: vi.fn(),
}));

vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
}));

vi.mock('./container-runner.js', () => ({
  writeGroupsSnapshot: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: mockMkdirSync,
      readdirSync: mockReaddir,
      statSync: mockStat,
      existsSync: mockExistsSync,
      readFileSync: mockReadFileSync,
      unlinkSync: mockUnlinkSync,
    },
  };
});

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return { ...actual, default: actual };
});

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    ICLOUD_EMAIL: 'test@icloud.com',
    ICLOUD_APP_PASSWORD: 'test-password',
  })),
}));

import { startIpcWatcher, _resetIpcWatcher, IpcDeps } from './ipc.js';

function makeDeps(): IpcDeps {
  return {
    sendMessage: vi.fn(async () => {}),
    registeredGroups: () => ({
      'group@g.us': {
        name: 'Test',
        folder: 'test_group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
  };
}

async function pollWithEmailFile(
  emailData: object,
  existsCheck?: (p: string) => boolean,
): Promise<void> {
  mockReaddir.mockImplementation((dir: unknown) => {
    if (String(dir).endsWith('/ipc')) return ['test_group'];
    if (String(dir).endsWith('/emails')) return ['email-001.json'];
    return [];
  });
  mockStat.mockReturnValue({ isDirectory: () => true });
  mockExistsSync.mockImplementation((p: unknown) => {
    const s = String(p);
    return existsCheck ? existsCheck(s) : s.includes('/emails');
  });
  mockReadFileSync.mockReturnValue(JSON.stringify(emailData));
  // Advance by one poll interval to trigger exactly one cycle
  await vi.advanceTimersByTimeAsync(150);
}

describe('send_email IPC — cc and bcc forwarding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetIpcWatcher();
    mockSendMail.mockClear();
    mockReaddir.mockReset();
    mockStat.mockReset();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    mockUnlinkSync.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes cc to sendMail when present in IPC data', async () => {
    startIpcWatcher(makeDeps());
    await pollWithEmailFile({
      type: 'send_email',
      to: 'recipient@example.com',
      cc: 'cc@example.com',
      subject: 'Test',
      body: 'Hello',
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ cc: 'cc@example.com' }),
    );
  });

  it('passes bcc to sendMail when present in IPC data', async () => {
    startIpcWatcher(makeDeps());
    await pollWithEmailFile({
      type: 'send_email',
      to: 'recipient@example.com',
      bcc: 'hidden@example.com',
      subject: 'Test',
      body: 'Hello',
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ bcc: 'hidden@example.com' }),
    );
  });

  it('passes both cc and bcc together', async () => {
    startIpcWatcher(makeDeps());
    await pollWithEmailFile({
      type: 'send_email',
      to: 'recipient@example.com',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      subject: 'Test subject',
      body: 'Body text',
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'recipient@example.com',
        cc: 'cc@example.com',
        bcc: 'bcc@example.com',
        subject: 'Test subject',
        text: 'Body text',
      }),
    );
  });

  it('sends without cc/bcc when neither is present', async () => {
    startIpcWatcher(makeDeps());
    await pollWithEmailFile({
      type: 'send_email',
      to: 'recipient@example.com',
      subject: 'Plain email',
      body: 'No cc or bcc',
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'recipient@example.com',
        subject: 'Plain email',
      }),
    );
    const call = mockSendMail.mock.calls[0][0];
    expect(call.cc).toBeUndefined();
    expect(call.bcc).toBeUndefined();
  });

  it('skips sending when ICLOUD credentials are missing', async () => {
    const { readEnvFile } = await import('./env.js');
    vi.mocked(readEnvFile).mockReturnValueOnce({});
    startIpcWatcher(makeDeps());
    await pollWithEmailFile({
      type: 'send_email',
      to: 'recipient@example.com',
      subject: 'Test',
      body: 'Hello',
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe('send_email IPC — attachments', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetIpcWatcher();
    mockSendMail.mockClear();
    mockReaddir.mockReset();
    mockStat.mockReset();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    mockUnlinkSync.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a single attachment and passes it to sendMail', async () => {
    startIpcWatcher(makeDeps());
    await pollWithEmailFile(
      {
        type: 'send_email',
        to: 'boss@example.com',
        subject: 'Q1 Report',
        body: 'See attached.',
        attachments: ['/workspace/group/files/report.pdf'],
      },
      (p) => p.includes('/emails') || p.includes('report.pdf'),
    );
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({
            filename: 'report.pdf',
            contentType: 'application/pdf',
          }),
        ]),
      }),
    );
  });

  it('resolves multiple attachments with correct MIME types', async () => {
    startIpcWatcher(makeDeps());
    await pollWithEmailFile(
      {
        type: 'send_email',
        to: 'boss@example.com',
        subject: 'Files',
        body: 'Attached.',
        attachments: [
          '/workspace/group/files/photo.jpg',
          '/workspace/group/files/sheet.xlsx',
          '/workspace/group/files/doc.docx',
        ],
      },
      (p) => p.includes('/emails') || p.includes('files/'),
    );
    const call = mockSendMail.mock.calls[0][0];
    expect(call.attachments).toHaveLength(3);
    expect(call.attachments[0]).toMatchObject({ filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(call.attachments[1]).toMatchObject({ filename: 'sheet.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(call.attachments[2]).toMatchObject({ filename: 'doc.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  });

  it('skips attachments that do not exist on the host', async () => {
    startIpcWatcher(makeDeps());
    // existsCheck: emails dir exists, but the attachment file does not
    await pollWithEmailFile(
      {
        type: 'send_email',
        to: 'boss@example.com',
        subject: 'Missing file',
        body: 'Body.',
        attachments: ['/workspace/group/files/ghost.pdf'],
      },
      (p) => p.includes('/emails'),
    );
    const call = mockSendMail.mock.calls[0][0];
    expect(call.attachments).toBeUndefined();
  });

  it('sends without attachments field when none provided', async () => {
    startIpcWatcher(makeDeps());
    await pollWithEmailFile({
      type: 'send_email',
      to: 'boss@example.com',
      subject: 'No attachments',
      body: 'Plain text only.',
    });
    const call = mockSendMail.mock.calls[0][0];
    expect(call.attachments).toBeUndefined();
  });

  it('uses application/octet-stream for unknown extensions', async () => {
    startIpcWatcher(makeDeps());
    await pollWithEmailFile(
      {
        type: 'send_email',
        to: 'boss@example.com',
        subject: 'Binary',
        body: 'Body.',
        attachments: ['/workspace/group/files/data.bin'],
      },
      (p) => p.includes('/emails') || p.includes('data.bin'),
    );
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({ contentType: 'application/octet-stream' }),
        ]),
      }),
    );
  });
});
