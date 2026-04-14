#!/bin/bash
#
# Archive stale session .jsonl files and clean up other session artifacts.
# Safe to run while NanoClaw is live — active interactive session is read from DB.
#
# Behaviour:
#   - Active interactive session .jsonl: never touched
#   - Session .jsonl files older than 7 days: moved to archived/
#   - Files already in archived/ older than 30 days: deleted
#   - Debug logs / telemetry older than 3 days: deleted
#   - Group log files older than 7 days: deleted
#
# Usage:  ./scripts/cleanup-sessions.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

SESSIONS_DIR="$PROJECT_ROOT/data/sessions"
GROUPS_DIR="$PROJECT_ROOT/groups"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

TOTAL_FREED=0

log() { echo "[cleanup] $*"; }

remove() {
  local target="$1"
  local size
  if [ -d "$target" ]; then
    size=$(du -sk "$target" 2>/dev/null | cut -f1 || echo 0)
  else
    size=$(( $(stat -c%s "$target" 2>/dev/null || echo 0) / 1024 ))
  fi
  TOTAL_FREED=$((TOTAL_FREED + size))
  if $DRY_RUN; then
    log "would remove: $target (${size}K)"
  else
    rm -rf "$target"
  fi
}

move_to_archive() {
  local src="$1"
  local archive_dir="$2"
  local dest="$archive_dir/$(date +%s)-$(basename "$src")"
  if $DRY_RUN; then
    log "would archive: $src → $dest"
  else
    mkdir -p "$archive_dir"
    mv "$src" "$dest"
    log "archived: $(basename "$src") → archived/"
  fi
}

# --- Collect active interactive session IDs ---
# The main DB is store/messages.db. Source='interactive' filters out any task sessions.
MAIN_DB="$PROJECT_ROOT/store/messages.db"
ACTIVE_IDS=""
if [ -f "$MAIN_DB" ]; then
  ACTIVE_IDS=$(sqlite3 "$MAIN_DB" \
    "SELECT session_id FROM sessions WHERE source = 'interactive';" 2>/dev/null || true)
fi

is_active() {
  local id="$1"
  for active in $ACTIVE_IDS; do
    [ "$active" = "$id" ] && return 0
  done
  return 1
}

log "Active interactive sessions: ${ACTIVE_IDS:-none}"

# --- Archive session .jsonl files older than 7 days ---

for group_dir in "$SESSIONS_DIR"/*/; do
  [ -d "$group_dir" ] || continue
  group_name=$(basename "$group_dir")
  jsonl_dir="$group_dir/.claude/projects/-workspace-group"
  archive_dir="$group_dir/archived"
  [ -d "$jsonl_dir" ] || continue

  for jsonl in "$jsonl_dir"/*.jsonl; do
    [ -f "$jsonl" ] || continue
    id=$(basename "$jsonl" .jsonl)

    # Never touch the active interactive session
    if is_active "$id"; then
      log "skipping active session: $id ($group_name)"
      continue
    fi

    # Archive if older than 7 days
    if find "$jsonl" -mtime +7 -print -quit 2>/dev/null | grep -q .; then
      move_to_archive "$jsonl" "$archive_dir"
      # Remove matching tool-results dir if present
      tool_results="$jsonl_dir/$id"
      [ -d "$tool_results" ] && remove "$tool_results"
    fi
  done

  # Delete archived files older than 30 days (archives are not indefinite)
  if [ -d "$archive_dir" ]; then
    while IFS= read -r -d '' old_file; do
      remove "$old_file"
    done < <(find "$archive_dir" -type f -mtime +30 -print0 2>/dev/null)
  fi
done

# --- Prune debug logs (>3 days) ---

for group_dir in "$SESSIONS_DIR"/*/; do
  debug_dir="$group_dir/.claude/debug"
  [ -d "$debug_dir" ] || continue
  while IFS= read -r -d '' f; do
    remove "$f"
  done < <(find "$debug_dir" -type f -mtime +3 -print0 2>/dev/null)
done

# --- Prune telemetry (>3 days) ---

for group_dir in "$SESSIONS_DIR"/*/; do
  telem_dir="$group_dir/.claude/telemetry"
  [ -d "$telem_dir" ] || continue
  while IFS= read -r -d '' f; do
    remove "$f"
  done < <(find "$telem_dir" -type f -mtime +3 -print0 2>/dev/null)
done

# --- Prune group logs (>7 days) ---

while IFS= read -r -d '' f; do
  remove "$f"
done < <(find "$GROUPS_DIR"/*/logs -type f -mtime +7 -print0 2>/dev/null)

# --- Summary ---

if $DRY_RUN; then
  log "DRY RUN complete — would free ~${TOTAL_FREED}K"
else
  log "Done — freed ~${TOTAL_FREED}K"
fi
