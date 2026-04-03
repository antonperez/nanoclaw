#!/usr/bin/env bash
# mount-watchdog.sh — Alert via Telegram if /mnt/pi-data is not mounted.
# Silent on success. Runs every 15 minutes via cron.

set -euo pipefail

MOUNT="/mnt/pi-data"
ENV_FILE="/home/anton/nanoclaw/.env"
CHAT_ID_FILE="/home/anton/nanoclaw/groups/telegram_main/team-chat-jid"

if mountpoint -q "$MOUNT"; then
  exit 0
fi

# Mount is down — send Telegram alert
BOT_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_ID=$(cat "$CHAT_ID_FILE" | tr -d 'tg:')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

MSG="⚠️ *Mount alert*
${MOUNT} is NOT mounted at ${TIMESTAMP}.
NanoClaw data (store, logs, groups) is unavailable. Check USB drive."

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=${MSG}" \
  > /dev/null

exit 0
