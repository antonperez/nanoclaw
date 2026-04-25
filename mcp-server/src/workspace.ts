import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORKSPACE_ROOT = path.resolve(
  process.env.NANOCLAW_GROUP_DIR ||
    '/home/anton/nanoclaw/groups/telegram_main',
);

// Folders / file patterns the MCP server is allowed to read.
// Whitelist: anything matching these prefixes is readable. Everything else is blocked.
const ALLOWED_PREFIXES = [
  'notes/',
  'crm/',
  'wiki/',
  'knowledgebase/',
  'journal/',
  'projects/',
  'work/',
  'archives/',
  'CLAUDE.md',
];

/** Exported for security tests. Returns absolute resolved path or null if blocked. */
export function safeResolve(relPath: string): string | null {
  const cleaned = relPath.replace(/^\/+/, '');
  if (cleaned.includes('..')) return null;
  if (!ALLOWED_PREFIXES.some((p) => cleaned.startsWith(p) || cleaned === p)) {
    return null;
  }
  const resolved = path.resolve(WORKSPACE_ROOT, cleaned);
  if (!resolved.startsWith(WORKSPACE_ROOT)) return null;

  // Resolve symlinks and verify the *real* path is still inside the workspace.
  // Without this, a symlink under e.g. notes/ pointing at /etc would let a
  // crafted read_file leak host files. realpath fails for non-existent paths,
  // which is fine — those return null and the caller surfaces "path not allowed".
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(WORKSPACE_ROOT)) return null;
    return real;
  } catch {
    // Path doesn't exist yet — that's an error for read tools, but we let the
    // caller produce the actual ENOENT message. Return the unresolved path; it
    // hasn't escaped the prefix check above.
    return resolved;
  }
}

export function listFiles(relPath: string): string {
  const resolved = safeResolve(relPath || '');
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
  // Use ripgrep if available for speed, fall back to grep.
  const cmd = (() => {
    try {
      execFileSync('which', ['rg']);
      return 'rg';
    } catch {
      return 'grep';
    }
  })();

  const args =
    cmd === 'rg'
      ? [
          '--max-count=3',
          '--max-filesize=200k',
          '-i',
          '-l',
          query,
          ...ALLOWED_PREFIXES.map((p) => path.join(WORKSPACE_ROOT, p)).filter(
            (p) => fs.existsSync(p),
          ),
        ]
      : [
          '-rli',
          '--include=*.md',
          query,
          ...ALLOWED_PREFIXES.map((p) => path.join(WORKSPACE_ROOT, p)).filter(
            (p) => fs.existsSync(p),
          ),
        ];

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
      .map((p) => path.relative(WORKSPACE_ROOT, p));
    return files.length ? files.join('\n') : '(no matches)';
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    if (e.status === 1) return '(no matches)';
    return `Error: ${e.stderr || String(err)}`;
  }
}

export function getRecentCaptures(hours = 24, limit = 50): string {
  const dbPath = path.resolve(WORKSPACE_ROOT, '..', '..', 'store/messages.db');
  if (!fs.existsSync(dbPath)) return 'Error: messages.db not found';
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();
  // Use sqlite3 CLI (no native deps, already installed on the Pi).
  // Fields are joined with char(1) (SOH, 0x01) — a real byte the JS split below
  // matches on. The earlier version wrote the literal text '' which never
  // matched the SOH in the JS split, returning garbage.
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
        const [ts, isFromMe, content] = line.split('');
        return `[${ts}] ${isFromMe === '1' ? 'assistant' : 'anton'}: ${content ?? ''}`;
      })
      .join('\n\n');
  } catch (err) {
    return `Error reading captures: ${err instanceof Error ? err.message : String(err)}`;
  }
}
