import { describe, it, expect, vi } from 'vitest';

const { mockMkdirSync, mockCreateWriteStream } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockCreateWriteStream: vi.fn(),
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  TELEGRAM_BOT_POOL: '',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: mockMkdirSync,
      createWriteStream: mockCreateWriteStream,
      unlink: vi.fn((_p: string, cb: () => void) => cb()),
    },
  };
});

vi.mock('https', () => {
  function Agent() {}
  const mod = { get: vi.fn(), Agent };
  return { ...mod, default: mod };
});

import { fileTypePrefix } from './telegram.js';

// --- fileTypePrefix ---

describe('fileTypePrefix', () => {
  it('returns "img" for image extensions', () => {
    expect(fileTypePrefix('photo.jpg')).toBe('img');
    expect(fileTypePrefix('photo.jpeg')).toBe('img');
    expect(fileTypePrefix('photo.png')).toBe('img');
    expect(fileTypePrefix('photo.gif')).toBe('img');
    expect(fileTypePrefix('photo.webp')).toBe('img');
    expect(fileTypePrefix('photo.heic')).toBe('img');
    expect(fileTypePrefix('photo.heif')).toBe('img');
  });

  it('returns "vid" for video extensions', () => {
    expect(fileTypePrefix('video.mp4')).toBe('vid');
    expect(fileTypePrefix('video.mov')).toBe('vid');
    expect(fileTypePrefix('video.avi')).toBe('vid');
    expect(fileTypePrefix('video.mkv')).toBe('vid');
    expect(fileTypePrefix('video.webm')).toBe('vid');
  });

  it('returns "aud" for audio extensions', () => {
    expect(fileTypePrefix('voice.mp3')).toBe('aud');
    expect(fileTypePrefix('voice.m4a')).toBe('aud');
    expect(fileTypePrefix('voice.ogg')).toBe('aud');
    expect(fileTypePrefix('voice.wav')).toBe('aud');
    expect(fileTypePrefix('voice.aac')).toBe('aud');
    expect(fileTypePrefix('voice.flac')).toBe('aud');
  });

  it('returns "doc" for documents and unknown types', () => {
    expect(fileTypePrefix('file.pdf')).toBe('doc');
    expect(fileTypePrefix('file.docx')).toBe('doc');
    expect(fileTypePrefix('file.txt')).toBe('doc');
    expect(fileTypePrefix('file.zip')).toBe('doc');
    expect(fileTypePrefix('noextension')).toBe('doc');
  });

  it('is case-insensitive', () => {
    expect(fileTypePrefix('PHOTO.JPG')).toBe('img');
    expect(fileTypePrefix('video.MP4')).toBe('vid');
    expect(fileTypePrefix('voice.M4A')).toBe('aud');
  });

  it('uses only the last extension for multi-dot filenames', () => {
    expect(fileTypePrefix('archive.tar.gz')).toBe('doc');
    expect(fileTypePrefix('photo.backup.jpg')).toBe('img');
  });
});

// --- Saved filename format ---

describe('saved filename format', () => {
  it('embeds the type prefix before timestamp and original name', () => {
    const filename = 'voice.ogg';
    const prefix = fileTypePrefix(filename);
    const timestamp = '20260330120000';
    expect(`${prefix}-${timestamp}-${filename}`).toBe(
      'aud-20260330120000-voice.ogg',
    );
  });

  it('produces a correctly structured path for images', () => {
    const saved = `${fileTypePrefix('photo.jpg')}-20260330120000-photo.jpg`;
    expect(saved).toMatch(/^img-\d{14}-photo\.jpg$/);
  });

  it('produces a correctly structured path for documents', () => {
    const saved = `${fileTypePrefix('report.pdf')}-20260330120000-report.pdf`;
    expect(saved).toMatch(/^doc-\d{14}-report\.pdf$/);
  });
});
