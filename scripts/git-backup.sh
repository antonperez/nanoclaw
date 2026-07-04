#!/bin/bash
# Daily auto-commit + push of antoplex repo to GitHub.
# Cron: 0 2 * * *  (2 AM PHT, after rsync-to-icloud)
# Skips silently when there are no changes.

set -e

REPO=/mnt/pi/nanoclaw/groups/telegram_main
LOG=/mnt/pi/nanoclaw/logs/git-backup.log
NOTIFY=/home/anton/nanoclaw/scripts/notify.sh

exec >>"$LOG" 2>&1

trap '"$NOTIFY" "❌ *antoplex git backup* failed at $(date +%H:%M) — see /mnt/pi/nanoclaw/logs/git-backup.log"' ERR

echo ""
echo "=== $(date -Iseconds) ==="

cd "$REPO"

# Detect any working-tree changes (modified, staged, OR untracked)
if git diff --quiet && git diff --cached --quiet \
   && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "no changes — skipping"
  "$NOTIFY" "💾 *antoplex git backup* — no changes to commit"
  exit 0
fi

git add -A

# After staging, double-check
if git diff --cached --quiet; then
  echo "nothing staged after add — skipping"
  "$NOTIFY" "💾 *antoplex git backup* — nothing staged after add"
  exit 0
fi

DATE=$(date '+%Y-%m-%d')
COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')
git commit -m "chore: auto-backup $DATE" --no-gpg-sign
git push origin main

echo "pushed"
"$NOTIFY" "💾 *antoplex git backup* — pushed $COUNT files (commit $DATE)"
