/**
 * Security tests for workspace path safety.
 *
 * The MCP server exposes file reads to claude.ai, so safeResolve() is the
 * boundary that prevents path traversal and symlink-escape attacks. These
 * tests cover the cases that nearly slipped through during the audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
process.env.NANOCLAW_GROUP_DIR = TEST_ROOT;

// Set up a synthetic workspace mirroring the real layout
beforeAll(() => {
  fs.mkdirSync(path.join(TEST_ROOT, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'crm', 'contacts'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(TEST_ROOT, 'notes', 'a.md'), '# A');
  fs.writeFileSync(path.join(TEST_ROOT, 'crm', 'contacts', 'p.md'), '# P');
  fs.writeFileSync(path.join(TEST_ROOT, 'CLAUDE.md'), '# group ctx');

  // External (escape target) file outside the workspace
  fs.writeFileSync(path.join(TEST_ROOT, '..', 'secret.txt'), 'should not be read');

  // A symlink under notes/ pointing OUTSIDE the workspace — the attack vector
  fs.symlinkSync(
    path.join(TEST_ROOT, '..', 'secret.txt'),
    path.join(TEST_ROOT, 'notes', 'evil-link.md'),
  );
});

afterAll(() => {
  fs.rmSync(path.join(TEST_ROOT, '..', 'secret.txt'), { force: true });
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// Import AFTER env is set so workspace.ts picks up the test root
const { safeResolve } = await import('./workspace.js');

describe('safeResolve — allowed prefixes', () => {
  it('allows notes/ subpaths', () => {
    const r = safeResolve('notes/a.md');
    expect(r).not.toBeNull();
    expect(r!.startsWith(TEST_ROOT)).toBe(true);
  });

  it('allows crm/contacts/ deep paths', () => {
    expect(safeResolve('crm/contacts/p.md')).not.toBeNull();
  });

  it('allows the bare CLAUDE.md file', () => {
    expect(safeResolve('CLAUDE.md')).not.toBeNull();
  });
});

describe('safeResolve — disallowed prefixes', () => {
  it('blocks a top-level file outside the whitelist', () => {
    expect(safeResolve('secret.txt')).toBeNull();
  });

  it('blocks a directory outside the whitelist', () => {
    expect(safeResolve('etc/passwd')).toBeNull();
  });

  it('blocks paths with ../ traversal even if first segment looks valid', () => {
    expect(safeResolve('notes/../../secret.txt')).toBeNull();
  });

  it('blocks bare ..', () => {
    expect(safeResolve('..')).toBeNull();
  });
});

describe('safeResolve — symlink escape (the audit fix)', () => {
  it('rejects a symlink that resolves outside the workspace', () => {
    // This is the attack: an attacker (or LLM) places a symlink under notes/
    // pointing at /etc/passwd. Without realpath, safeResolve only checks the
    // pre-resolution prefix and would return the symlink path. With realpath,
    // the resolved real path escapes WORKSPACE_ROOT and the function returns null.
    expect(safeResolve('notes/evil-link.md')).toBeNull();
  });
});

describe('safeResolve — non-existent paths', () => {
  it('still returns a valid path for a future write target inside the whitelist', () => {
    // safeResolve is also used as a pre-write check; non-existent paths within
    // a whitelisted prefix should return the unresolved path so the caller can
    // produce the actual ENOENT/permission error from the read attempt.
    const r = safeResolve('notes/does-not-exist-yet.md');
    expect(r).not.toBeNull();
    expect(r!.includes('does-not-exist-yet.md')).toBe(true);
  });
});
