#!/usr/bin/env bash
# backup.sh — Back up NanoClaw data and source to git.
# - Copies messages.db, crontab, and group CLAUDE.md files into telegram_main
# - Commits and pushes telegram_main
# - Commits and pushes nanoclaw source to GitHub

set -euo pipefail

NANOCLAW_DIR="/home/anton/nanoclaw"
GROUP_DIR="$NANOCLAW_DIR/groups/telegram_main"
GROUPS_BASE="/mnt/pi-data/nanoclaw/groups"

# --- telegram_main backup ---

# DB snapshot
mkdir -p "$GROUP_DIR/data/groups"
cp "$NANOCLAW_DIR/store/messages.db" "$GROUP_DIR/data/nanoclaw.db"

# Crontab snapshot
crontab -l > "$GROUP_DIR/data/crontab.bak"

# global and main group CLAUDE.md snapshots
for group in global main; do
  src="$GROUPS_BASE/$group/CLAUDE.md"
  if [ -f "$src" ]; then
    cp "$src" "$GROUP_DIR/data/groups/${group}-CLAUDE.md"
  fi
done

cd "$GROUP_DIR"
git add -A
git diff --cached --quiet || git commit -m "chore: daily backup $(date +%Y-%m-%d)"
git push origin main

# --- nanoclaw source backup ---

cd "$NANOCLAW_DIR"
git add scripts/backup.sh scripts/health-check.sh scripts/mount-watchdog.sh
# Stage any other tracked file changes
git diff --cached --quiet || git commit -m "chore: backup $(date +%Y-%m-%d)"
git push origin main
