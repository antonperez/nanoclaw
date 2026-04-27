#!/bin/bash
# Sync NanoClaw workspace data → Mac iCloud-synced folder.
# Cron: 30 1 * * *  (1:30 AM PHT, before nightly git-backup)
# Skips silently when no source files changed since last successful sync.

set -e

SRC=/home/anton/nanoclaw/groups/telegram_main
DEST_HOST=anton@amp-macbook.local
DEST_PATH=/Users/anton/iCloudSource/nanoclaw-data
STAMP=/mnt/pi/nanoclaw/data/.last-rsync.stamp
LOG=/mnt/pi/nanoclaw/logs/rsync.log
SSH_KEY=/home/anton/.ssh/id_ed25519
NOTIFY=/home/anton/nanoclaw/scripts/notify.sh

WATCHED=(
  archives conversations crm drafts health journal knowledgebase
  medical notes personal profiles projects properties research
  travel wiki work
)

exec >>"$LOG" 2>&1

trap '"$NOTIFY" "❌ *rsync to iCloud* failed at $(date +%H:%M) — see /mnt/pi/nanoclaw/logs/rsync.log"' ERR

echo ""
echo "=== $(date -Iseconds) ==="

# Delta check
if [ -f "$STAMP" ]; then
  changed=0
  for d in "${WATCHED[@]}"; do
    if [ -d "$SRC/$d" ]; then
      if find "$SRC/$d" -newer "$STAMP" -type f -print -quit 2>/dev/null | grep -q .; then
        changed=1
        break
      fi
    fi
  done
  if [ "$changed" -eq 0 ] && [ -f "$SRC/CLAUDE.md" ] && [ "$SRC/CLAUDE.md" -nt "$STAMP" ]; then
    changed=1
  fi
  if [ "$changed" -eq 0 ]; then
    echo "no changes since last sync — skipping"
    "$NOTIFY" "🌙 *rsync to iCloud* — no changes to sync"
    exit 0
  fi
fi

INCLUDE_ARGS=()
for d in "${WATCHED[@]}"; do
  INCLUDE_ARGS+=("--include=$d/***")
done

rsync -azm \
  "${INCLUDE_ARGS[@]}" \
  --include='CLAUDE.md' \
  --include='*/' \
  --exclude='*' \
  -e "ssh -i $SSH_KEY -o ConnectTimeout=10 -o BatchMode=yes" \
  "$SRC/" \
  "$DEST_HOST:$DEST_PATH/"

echo "rsync done"
touch "$STAMP"

"$NOTIFY" "🌙 *rsync to iCloud* — synced workspace to Mac"
