#!/usr/bin/env bash
# claude-session-marker.sh — Stop-hook target for Claude Code.
#
# Claude Code Stop hooks fire every time the assistant finishes responding
# (per turn, NOT per /exit). To avoid 50+ markers per session, this script
# dedupes by session_id: first turn of a session writes a marker; subsequent
# turns of the same session are no-ops.
#
# Hook input arrives as JSON on stdin with fields:
#   session_id, transcript_path, cwd, hook_event_name
#
# Wired in: ~/.claude/settings.json hooks.Stop[]

set -eu

PENDING="/home/anton/nanoclaw/groups/telegram_main/notes/captures-pending.md"

# Read JSON from stdin, extract session_id and cwd via python (no jq dep).
INPUT="$(cat)"
PARSED="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("session_id", "unknown"))
    print(d.get("cwd", ""))
except Exception:
    print("unknown")
    print("")
' 2>/dev/null || printf 'unknown\n\n')"

SESSION_ID="$(printf '%s' "$PARSED" | sed -n '1p')"
PROJECT_DIR="$(printf '%s' "$PARSED" | sed -n '2p')"
[ -z "$PROJECT_DIR" ] && PROJECT_DIR="$(pwd)"
TS="$(date '+%Y-%m-%d %H:%M')"

mkdir -p "$(dirname "$PENDING")"

# Dedupe: skip if this session already has a marker.
# (First turn of a session creates the marker; later turns are no-ops.)
if [ "$SESSION_ID" != "unknown" ] && [ -f "$PENDING" ]; then
  if grep -q "session $SESSION_ID" "$PENDING" 2>/dev/null; then
    exit 0
  fi
fi

{
  printf '\n## %s — session %s\n- cwd: %s\n' "$TS" "$SESSION_ID" "$PROJECT_DIR"
} >> "$PENDING" 2>/dev/null || true

exit 0
