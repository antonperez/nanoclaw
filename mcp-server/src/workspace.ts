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
