/**
 * Tests for workspace path safety and the sync bus (syncWrite / syncRead).
 *
 * Directory layout used by tests:
 *   PROJ_ROOT/                   ← isolated temp dir
 *     groups/telegram_main/      ← WORKSPACE_ROOT (via NANOCLAW_GROUP_DIR)
 *     store/                     ← STORE_ROOT (derived: WORKSPACE_ROOT/../../store)
 *
 * This ensures SYNCS_DB_PATH → PROJ_ROOT/store/syncs.db (fully isolated).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// ── Test root setup ───────────────────────────────────────────────────────────

const PROJ_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-test-'));
const TEST_ROOT = path.join(PROJ_ROOT, 'groups', 'telegram_main');
const TEST_STORE = path.join(PROJ_ROOT, 'store');
const SYNCS_DB = path.join(TEST_STORE, 'syncs.db');

fs.mkdirSync(TEST_ROOT, { recursive: true });
fs.mkdirSync(TEST_STORE, { recursive: true });
process.env.NANOCLAW_GROUP_DIR = TEST_ROOT;

// ── Workspace fixture ─────────────────────────────────────────────────────────

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_ROOT, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'crm', 'contacts'), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(TEST_ROOT, 'notes', 'a.md'), '# A');
  fs.writeFileSync(path.join(TEST_ROOT, 'crm', 'contacts', 'p.md'), '# P');
  fs.writeFileSync(path.join(TEST_ROOT, 'CLAUDE.md'), '# group ctx');

  // Secret file outside the workspace (escape target for symlink attack test)
  fs.writeFileSync(path.join(TEST_ROOT, '..', 'secret.txt'), 'should not be read');

  // Symlink under notes/ pointing outside the workspace — the attack vector
  fs.symlinkSync(
    path.join(TEST_ROOT, '..', 'secret.txt'),
    path.join(TEST_ROOT, 'notes', 'evil-link.md'),
  );
});

afterAll(() => {
  fs.rmSync(PROJ_ROOT, { recursive: true, force: true });
});

// Import AFTER env is set so workspace.ts picks up the correct roots
const { safeResolve, initSyncsDb, syncWrite, syncRead } = await import('./workspace.js');

// ── safeResolve ───────────────────────────────────────────────────────────────

describe('safeResolve — workspace paths', () => {
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

  it('returns a valid path for a non-existent file inside the workspace', () => {
    const r = safeResolve('notes/does-not-exist-yet.md');
    expect(r).not.toBeNull();
    expect(r!.includes('does-not-exist-yet.md')).toBe(true);
  });
});

describe('safeResolve — path traversal (must always block)', () => {
  it('blocks paths with ../ traversal even if first segment looks valid', () => {
    expect(safeResolve('notes/../../secret.txt')).toBeNull();
  });

  it('blocks bare ..', () => {
    expect(safeResolve('..')).toBeNull();
  });
});

describe('safeResolve — symlink escape (the audit fix)', () => {
  it('rejects a symlink that resolves outside the workspace', () => {
    expect(safeResolve('notes/evil-link.md')).toBeNull();
  });
});

// ── Sync bus — initSyncsDb ────────────────────────────────────────────────────

describe('initSyncsDb', () => {
  it('creates syncs table on first call', () => {
    if (fs.existsSync(SYNCS_DB)) fs.rmSync(SYNCS_DB);
    initSyncsDb();
    expect(fs.existsSync(SYNCS_DB)).toBe(true);
    const schema = execFileSync('sqlite3', [SYNCS_DB, '.schema syncs'], { encoding: 'utf8' });
    expect(schema).toContain('CREATE TABLE');
    expect(schema).toContain('slot1');
    expect(schema).toContain('confidence');
  });

  it('is idempotent — second call does not throw or corrupt', () => {
    initSyncsDb();
    initSyncsDb();
    const schema = execFileSync('sqlite3', [SYNCS_DB, '.schema syncs'], { encoding: 'utf8' });
    expect(schema).toContain('CREATE TABLE');
  });
});

// ── Sync bus — syncWrite ──────────────────────────────────────────────────────

describe('syncWrite', () => {
  beforeEach(() => {
    initSyncsDb();
    execFileSync('sqlite3', [SYNCS_DB, 'DELETE FROM syncs;']);
  });

  it('all slots — returns correct format', () => {
    const result = syncWrite('ai-sandbox', 'decision A', 'consequence B', 'change C', 'HIGH');
    expect(result).toBe('Synced [ai-sandbox]: decision A · consequence B · change C');
  });

  it('slot1 only — omits empty slots from output', () => {
    const result = syncWrite('bdo', 'only a decision');
    expect(result).toBe('Synced [bdo]: only a decision');
  });

  it('slot1 + slot2, no slot3 — only two parts', () => {
    const result = syncWrite('anton7', 'decision', 'consequence');
    expect(result).toBe('Synced [anton7]: decision · consequence');
  });

  it('LOW confidence — accepted and written', () => {
    const result = syncWrite('ai-sandbox', 'low confidence thing', undefined, undefined, 'LOW');
    expect(result).toBe('Synced [ai-sandbox]: low confidence thing');
    const rows = execFileSync('sqlite3', [SYNCS_DB, "SELECT confidence FROM syncs;"], { encoding: 'utf8' }).trim();
    expect(rows).toBe('LOW');
  });

  it('defaults confidence to HIGH when omitted', () => {
    syncWrite('bdo', 'something');
    const rows = execFileSync('sqlite3', [SYNCS_DB, "SELECT confidence FROM syncs;"], { encoding: 'utf8' }).trim();
    expect(rows).toBe('HIGH');
  });

  it('persists all fields to DB', () => {
    syncWrite('antonperez', 's1', 's2', 's3', 'HIGH');
    const row = execFileSync('sqlite3', [SYNCS_DB, "SELECT project,slot1,slot2,slot3,confidence FROM syncs;"], { encoding: 'utf8' }).trim();
    expect(row).toBe('antonperez|s1|s2|s3|HIGH');
  });

  it('stores NULL for omitted slot2/slot3', () => {
    syncWrite('investmentology', 'only s1');
    const row = execFileSync('sqlite3', ['-nullvalue', 'NULL', SYNCS_DB, "SELECT slot2,slot3 FROM syncs;"], { encoding: 'utf8' }).trim();
    expect(row).toBe('NULL|NULL');
  });

  it('rejects invalid project', () => {
    const result = syncWrite('unknown-project', 'test');
    expect(result).toMatch(/^Error:/);
    expect(result).toContain('invalid project');
  });

  it('rejects invalid confidence', () => {
    const result = syncWrite('bdo', 'test', undefined, undefined, 'MEDIUM');
    expect(result).toMatch(/^Error:/);
    expect(result).toContain('confidence');
  });

  it('rejects empty slot1', () => {
    const result = syncWrite('bdo', '   ');
    expect(result).toMatch(/^Error:/);
  });

  it('rejects slot1 over 2000 chars', () => {
    const result = syncWrite('bdo', 'x'.repeat(2001));
    expect(result).toMatch(/^Error:.*slot1 too long/);
  });

  it('rejects slot2 over 2000 chars', () => {
    const result = syncWrite('bdo', 'ok', 'x'.repeat(2001));
    expect(result).toMatch(/^Error:.*slot2 too long/);
  });

  it('rejects slot3 over 2000 chars', () => {
    const result = syncWrite('bdo', 'ok', undefined, 'x'.repeat(2001));
    expect(result).toMatch(/^Error:.*slot3 too long/);
  });

  it("SQL injection in slot1 — stored as literal, doesn't break query", () => {
    const payload = "x'); DROP TABLE syncs; --";
    const result = syncWrite('bdo', payload);
    expect(result).toContain('Synced [bdo]');
    // Table still exists and has the row with the literal payload
    const row = execFileSync('sqlite3', [SYNCS_DB, 'SELECT slot1 FROM syncs;'], { encoding: 'utf8' }).trim();
    expect(row).toBe(payload);
  });

  it('lazy re-init after DROP TABLE — recovers and writes', () => {
    execFileSync('sqlite3', [SYNCS_DB, 'DROP TABLE syncs;']);
    const result = syncWrite('bdo', 'after drop');
    expect(result).toBe('Synced [bdo]: after drop');
    const count = execFileSync('sqlite3', [SYNCS_DB, 'SELECT count(*) FROM syncs;'], { encoding: 'utf8' }).trim();
    expect(count).toBe('1');
  });
});

// ── Sync bus — syncRead ───────────────────────────────────────────────────────

describe('syncRead', () => {
  beforeEach(() => {
    initSyncsDb();
    execFileSync('sqlite3', [SYNCS_DB, 'DELETE FROM syncs;']);
  });

  it('returns no-results message when DB is empty', () => {
    expect(syncRead()).toBe('No syncs in the last 7 days.');
  });

  it('uses days parameter in no-results message', () => {
    expect(syncRead(30)).toBe('No syncs in the last 30 days.');
  });

  it('shows written entry under correct project name', () => {
    syncWrite('bdo', 'Datum toolchain unblocked');
    const result = syncRead();
    expect(result).toContain('DevSecOps BDO (1):');
    expect(result).toContain('Datum toolchain unblocked');
  });

  it('maps all project slugs to display names', () => {
    syncWrite('bdo', 'a');
    syncWrite('investmentology', 'b');
    syncWrite('ai-sandbox', 'c');
    syncWrite('antonperez', 'd');
    syncWrite('anton7', 'e');
    const result = syncRead();
    expect(result).toContain('DevSecOps BDO');
    expect(result).toContain('Investmentology');
    expect(result).toContain('AI Sandbox');
    expect(result).toContain('antonperez.com');
    expect(result).toContain('Anton 7.0');
  });

  it('includes slot2 and slot3 in output when present', () => {
    syncWrite('ai-sandbox', 'S1', 'S2', 'S3');
    const result = syncRead();
    expect(result).toContain('S1 · S2 · S3');
  });

  it('omits empty slots from output line', () => {
    syncWrite('ai-sandbox', 'only one');
    const result = syncRead();
    expect(result).toContain('only one');
    expect(result).not.toContain(' · ');
  });

  it('defaults to HIGH confidence only — LOW entries hidden', () => {
    syncWrite('bdo', 'high entry', undefined, undefined, 'HIGH');
    syncWrite('bdo', 'low entry', undefined, undefined, 'LOW');
    const result = syncRead();
    expect(result).toContain('high entry');
    expect(result).not.toContain('low entry');
  });

  it('explicit LOW confidence — shows LOW, hides HIGH', () => {
    syncWrite('bdo', 'high entry', undefined, undefined, 'HIGH');
    syncWrite('bdo', 'low entry', undefined, undefined, 'LOW');
    const result = syncRead(7, undefined, 'LOW');
    expect(result).toContain('low entry');
    expect(result).not.toContain('high entry');
  });

  it('project filter — returns only matching project', () => {
    syncWrite('bdo', 'bdo entry');
    syncWrite('ai-sandbox', 'sandbox entry');
    const result = syncRead(7, 'bdo');
    expect(result).toContain('DevSecOps BDO');
    expect(result).not.toContain('AI Sandbox');
    expect(result).not.toContain('sandbox entry');
  });

  it('project filter — no results returns no-results message', () => {
    syncWrite('bdo', 'something');
    const result = syncRead(7, 'anton7');
    expect(result).toBe('No syncs in the last 7 days.');
  });

  it('count in project header is correct', () => {
    syncWrite('bdo', 'entry one');
    syncWrite('bdo', 'entry two');
    const result = syncRead();
    expect(result).toContain('DevSecOps BDO (2):');
  });

  it('rejects invalid project', () => {
    const result = syncRead(7, 'not-a-project');
    expect(result).toMatch(/^Error:/);
  });

  it('rejects invalid confidence', () => {
    const result = syncRead(7, undefined, 'MEDIUM');
    expect(result).toMatch(/^Error:/);
  });

  it('clamps days to minimum of 1', () => {
    // Should not throw — just returns no-results for tiny window
    const result = syncRead(0);
    expect(result).toMatch(/No syncs in the last 1 days\./);
  });

  it('lazy re-init after DROP TABLE — recovers and returns empty', () => {
    execFileSync('sqlite3', [SYNCS_DB, 'DROP TABLE syncs;']);
    const result = syncRead();
    expect(result).toBe('No syncs in the last 7 days.');
  });
});
