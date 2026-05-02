import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORKSPACE_ROOT = path.resolve(
  process.env.NANOCLAW_GROUP_DIR ||
    '/home/anton/nanoclaw/groups/telegram_main',
);

// store/ is a symlink at <project-root>/store → /mnt/pi/nanoclaw/store.
// Exposed under the virtual prefix "store/" in all MCP tools.
const PROJECT_ROOT = path.resolve(WORKSPACE_ROOT, '..', '..');
const STORE_ROOT = path.resolve(PROJECT_ROOT, 'store');

// Resolve real (post-symlink) roots once at startup for boundary checks.
const WORKSPACE_ROOT_REAL = (() => {
  try { return fs.realpathSync(WORKSPACE_ROOT); } catch { return WORKSPACE_ROOT; }
})();
const STORE_ROOT_REAL = (() => {
  try { return fs.realpathSync(STORE_ROOT); } catch { return STORE_ROOT; }
})();

/**
 * Exported for security tests.
 * Returns the absolute resolved path or null if:
 *  - the path contains '..' (traversal attempt)
 *  - after symlink resolution it escapes its root
 *
 * Two roots are allowed:
 *  - Everything under WORKSPACE_ROOT  (groups/telegram_main/)
 *  - Everything under STORE_ROOT      (store/, virtual prefix)
 */
export function safeResolve(relPath: string): string | null {
  const cleaned = relPath.replace(/^\/+/, '');
  if (cleaned.includes('..')) return null;

  // "store" and "store/..." are resolved against the project root so the
  // symlink traversal check can work against STORE_ROOT_REAL.
  const isStore = cleaned === 'store' || cleaned.startsWith('store/');
  const baseRoot = isStore ? PROJECT_ROOT : WORKSPACE_ROOT;
  const allowedReal = isStore ? STORE_ROOT_REAL : WORKSPACE_ROOT_REAL;

  const resolved = path.resolve(baseRoot, cleaned);

  // Pre-symlink check: must still be inside the base root.
  const baseAllowed = isStore ? STORE_ROOT : WORKSPACE_ROOT;
  if (!resolved.startsWith(baseAllowed)) return null;

  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(allowedReal)) return null;
    return real;
  } catch {
    // File doesn't exist yet — return unresolved path so callers can surface ENOENT.
    return resolved;
  }
}

export function listFiles(relPath: string): string {
  // Root listing: all non-hidden entries in WORKSPACE_ROOT + store/.
  if (!relPath || relPath === '/') {
    const wsEntries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    if (fs.existsSync(STORE_ROOT)) wsEntries.push('store/');
    return wsEntries.join('\n');
  }

  const resolved = safeResolve(relPath);
  if (!resolved) return `Error: path "${relPath}" not allowed`;
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function readFile(relPath: string): string {
  const resolved = safeResolve(relPath);
  if (!resolved) return `Error: path "${relPath}" not allowed`;
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > 200_000) {
      return `Error: file too large (${stat.size} bytes); use search instead`;
    }
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function searchWorkspace(query: string, maxResults = 30): string {
  if (!query || query.length < 2) return 'Error: query too short';
  const cmd = (() => {
    try { execFileSync('which', ['rg']); return 'rg'; } catch { return 'grep'; }
  })();

  // Search all of WORKSPACE_ROOT plus STORE_ROOT.
  const searchRoots = [WORKSPACE_ROOT, STORE_ROOT].filter((p) => fs.existsSync(p));

  const args =
    cmd === 'rg'
      ? ['--max-count=3', '--max-filesize=200k', '-i', '-l', query, ...searchRoots]
      : ['-rli', '--include=*.md', query, ...searchRoots];

  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 1_000_000,
      timeout: 10_000,
    });
    const files = out
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, maxResults)
      .map((p) => {
        // Show store/ paths with their virtual prefix.
        if (p.startsWith(STORE_ROOT_REAL)) {
          return 'store/' + path.relative(STORE_ROOT_REAL, p);
        }
        return path.relative(WORKSPACE_ROOT, p);
      });
    return files.length ? files.join('\n') : '(no matches)';
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    if (e.status === 1) return '(no matches)';
    return `Error: ${e.stderr || String(err)}`;
  }
}

export function queryDb(db: string, sql: string): string {
  const normalized = sql.trim().replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^SELECT\b/i.test(normalized)) {
    return 'Error: only SELECT statements are allowed';
  }

  const dbFile = db.endsWith('.db') ? db : `${db}.db`;
  const dbPath = path.join(STORE_ROOT, dbFile);
  if (!dbPath.startsWith(STORE_ROOT) || dbFile.includes('..')) {
    return 'Error: invalid db name';
  }
  if (!fs.existsSync(dbPath)) {
    const available = fs.readdirSync(STORE_ROOT).filter((f) => f.endsWith('.db')).join(', ');
    return `Error: "${db}" not found. Available: ${available}`;
  }

  try {
    const out = execFileSync('sqlite3', ['-readonly', '-csv', '-header', dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 2_000_000,
      timeout: 10_000,
    });
    return out.trim() || '(no rows)';
  } catch (err) {
    const e = err as { stderr?: string };
    return `Error: ${e.stderr || String(err)}`;
  }
}

/**
 * Write or append to a file in WORKSPACE_ROOT only (not store/).
 * Uses realpathSync on the parent directory to block symlink escapes.
 * Returns "ok" on success or an error string.
 */
export function writeFile(
  relPath: string,
  content: string,
  mode: 'overwrite' | 'append' = 'overwrite',
): string {
  const cleaned = relPath.replace(/^\/+/, '');
  if (cleaned.includes('..')) return `Error: path "${relPath}" not allowed`;
  if (cleaned === 'store' || cleaned.startsWith('store/')) {
    return 'Error: writes to store/ are not allowed';
  }
  if (content.length > 200_000) {
    return 'Error: content too large (max 200 KB)';
  }

  const resolved = path.resolve(WORKSPACE_ROOT, cleaned);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return `Error: path "${relPath}" not allowed`;
  }

  // Symlink escape check: resolve the parent (which must exist) and verify
  // it stays inside WORKSPACE_ROOT_REAL.
  const parentDir = path.dirname(resolved);
  try {
    const realParent = fs.realpathSync(parentDir);
    if (!realParent.startsWith(WORKSPACE_ROOT_REAL)) {
      return `Error: path "${relPath}" not allowed`;
    }
  } catch {
    // Parent doesn't exist yet — mkdirSync will create it below; the
    // string-prefix check above is sufficient for brand-new paths.
  }

  try {
    fs.mkdirSync(parentDir, { recursive: true });
    if (mode === 'append') {
      fs.appendFileSync(resolved, content, 'utf8');
    } else {
      fs.writeFileSync(resolved, content, 'utf8');
    }
    return 'ok';
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Delete a file or empty directory in WORKSPACE_ROOT only (not store/).
 * Uses realpathSync to block symlink escapes before unlinking.
 * Returns "ok" on success or an error string.
 */
export function deleteFile(relPath: string): string {
  const cleaned = relPath.replace(/^\/+/, '');
  if (cleaned.includes('..')) return `Error: path "${relPath}" not allowed`;
  if (cleaned === 'store' || cleaned.startsWith('store/')) {
    return 'Error: deletes in store/ are not allowed';
  }

  const resolved = path.resolve(WORKSPACE_ROOT, cleaned);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return `Error: path "${relPath}" not allowed`;
  }

  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(WORKSPACE_ROOT_REAL)) {
      return `Error: path "${relPath}" not allowed`;
    }
    const stat = fs.statSync(real);
    if (stat.isDirectory()) {
      fs.rmdirSync(real); // only removes empty dirs
    } else {
      fs.unlinkSync(real);
    }
    return 'ok';
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Sync bus ────────────────────────────────────────────────────────────────

const SYNCS_DB_PATH = path.join(STORE_ROOT, 'syncs.db');

const VALID_SYNC_PROJECTS = new Set(['bdo', 'investmentology', 'ai-sandbox', 'antonperez', 'anton7']);
const SYNC_PROJECT_NAMES: Record<string, string> = {
  bdo: 'DevSecOps BDO',
  investmentology: 'Investmentology',
  'ai-sandbox': 'AI Sandbox',
  antonperez: 'antonperez.com',
  anton7: 'Anton 7.0',
};

// SQLite single-quoted strings: only ' needs escaping (doubled to '').
// Backslash is NOT a special escape char in standard SQLite — no backslash handling needed.
function escSql(s: string): string {
  return s.replace(/\x00/g, '').replace(/'/g, "''");
}

export function initSyncsDb(): void {
  try {
    fs.mkdirSync(path.dirname(SYNCS_DB_PATH), { recursive: true });
    const ddl = `
      CREATE TABLE IF NOT EXISTS syncs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project    TEXT NOT NULL,
        slot1      TEXT NOT NULL,
        slot2      TEXT,
        slot3      TEXT,
        confidence TEXT NOT NULL DEFAULT 'HIGH',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_syncs_created_at ON syncs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_syncs_project    ON syncs(project, created_at DESC);
    `;
    execFileSync('sqlite3', [SYNCS_DB_PATH, ddl], { encoding: 'utf8', timeout: 5_000 });
  } catch (err) {
    console.warn('[syncs] init warning:', err instanceof Error ? err.message : String(err));
  }
}

export function syncWrite(
  project: string,
  slot1: string,
  slot2?: string,
  slot3?: string,
  confidence?: string,
): string {
  if (!VALID_SYNC_PROJECTS.has(project)) {
    return `Error: invalid project "${project}". Valid: ${[...VALID_SYNC_PROJECTS].join(', ')}`;
  }
  if (!slot1?.trim()) return 'Error: slot1 is required';
  if (slot1.length > 2000) return 'Error: slot1 too long (max 2000 chars)';
  if (slot2 && slot2.length > 2000) return 'Error: slot2 too long (max 2000 chars)';
  if (slot3 && slot3.length > 2000) return 'Error: slot3 too long (max 2000 chars)';

  const conf = (confidence ?? 'HIGH').toUpperCase();
  if (conf !== 'HIGH' && conf !== 'LOW') return `Error: confidence must be 'HIGH' or 'LOW'`;

  const s2 = slot2?.trim() ? `'${escSql(slot2.trim())}'` : 'NULL';
  const s3 = slot3?.trim() ? `'${escSql(slot3.trim())}'` : 'NULL';
  const sql = `PRAGMA busy_timeout=5000;
INSERT INTO syncs (project,slot1,slot2,slot3,confidence)
VALUES ('${escSql(project)}','${escSql(slot1.trim())}',${s2},${s3},'${conf}');`;

  try {
    execFileSync('sqlite3', [SYNCS_DB_PATH, sql], { encoding: 'utf8', timeout: 5_000 });
    const parts = [slot1.trim(), slot2?.trim(), slot3?.trim()].filter(Boolean);
    return `Synced [${project}]: ${parts.join(' · ')}`;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    // Re-init and retry once if the table was dropped while server was running
    if (String(e.stderr || e.message).includes('no such table')) {
      initSyncsDb();
      try {
        execFileSync('sqlite3', [SYNCS_DB_PATH, sql], { encoding: 'utf8', timeout: 5_000 });
        const parts = [slot1.trim(), slot2?.trim(), slot3?.trim()].filter(Boolean);
        return `Synced [${project}]: ${parts.join(' · ')}`;
      } catch (err2) {
        const e2 = err2 as { stderr?: string };
        return `Error: ${e2.stderr?.trim() || String(err2)}`;
      }
    }
    return `Error: ${e.stderr?.trim() || String(err)}`;
  }
}

export function syncRead(
  days?: number,
  project?: string,
  confidence?: string,
): string {
  const d = Math.max(1, Math.min(90, Math.round(days ?? 7)));
  const conf = (confidence ?? 'HIGH').toUpperCase();
  if (conf !== 'HIGH' && conf !== 'LOW') return `Error: confidence must be 'HIGH' or 'LOW'`;
  if (project && !VALID_SYNC_PROJECTS.has(project)) {
    return `Error: invalid project "${project}". Valid: ${[...VALID_SYNC_PROJECTS].join(', ')}`;
  }

  let where = `WHERE created_at > datetime('now', '-${d} days') AND confidence = '${conf}'`;
  if (project) where += ` AND project = '${escSql(project)}'`;

  const sql =
    `SELECT date(created_at) || char(1) || project || char(1) || slot1 ` +
    `|| char(1) || coalesce(slot2,'') || char(1) || coalesce(slot3,'') ` +
    `FROM syncs ${where} ORDER BY project ASC, created_at DESC;`;

  const runQuery = (): string => {
    const out = execFileSync('sqlite3', ['-readonly', SYNCS_DB_PATH, sql], {
      encoding: 'utf8',
      maxBuffer: 5_000_000,
      timeout: 10_000,
    });
    const lines = out.trim().split('\n').filter(Boolean);
    if (!lines.length) return `No syncs in the last ${d} days.`;

    const groups = new Map<string, string[]>();
    for (const line of lines) {
      const [dateStr, proj, s1, s2, s3] = line.split('\x01');
      const slots = [s1, s2, s3].filter(Boolean).join(' · ');
      if (!groups.has(proj)) groups.set(proj, []);
      groups.get(proj)!.push(`- ${dateStr}: ${slots}`);
    }

    const sections: string[] = [];
    for (const [proj, entries] of groups) {
      const name = SYNC_PROJECT_NAMES[proj] ?? proj;
      sections.push(`${name} (${entries.length}):\n${entries.join('\n')}`);
    }
    return sections.join('\n\n');
  };

  try {
    return runQuery();
  } catch (err) {
    const e = err as { stderr?: string; status?: number; message?: string };
    if (e.status === 1) return `No syncs in the last ${d} days.`;
    // Re-init and retry once if table was dropped while server was running
    if (String(e.stderr || e.message).includes('no such table')) {
      initSyncsDb();
      try { return runQuery(); } catch (err2) {
        const e2 = err2 as { stderr?: string };
        return `Error: ${(e2.stderr || String(err2)).trim()}`;
      }
    }
    return `Error: ${(e.stderr || String(err)).trim()}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export function getRecentCaptures(hours = 24, limit = 50): string {
  const dbPath = path.join(STORE_ROOT, 'messages.db');
  if (!fs.existsSync(dbPath)) return 'Error: messages.db not found';
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();
  const sql =
    `SELECT timestamp || char(1) || is_from_me || char(1) || substr(content, 1, 500) ` +
    `FROM messages WHERE timestamp > '${sinceIso.replace(/'/g, "''")}' ` +
    `ORDER BY timestamp DESC LIMIT ${Math.max(1, Math.min(limit, 200))};`;
  try {
    const out = execFileSync('sqlite3', ['-readonly', dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 5_000_000,
      timeout: 10_000,
    });
    return out
      .trim()
      .split('\n')
      .reverse()
      .map((line) => {
        const [ts, isFromMe, content] = line.split('\x01');
        return `[${ts}] ${isFromMe === '1' ? 'assistant' : 'anton'}: ${content ?? ''}`;
      })
      .join('\n\n');
  } catch (err) {
    return `Error reading captures: ${err instanceof Error ? err.message : String(err)}`;
  }
}
