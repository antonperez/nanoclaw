#!/usr/bin/env bash
# mount-watchdog.sh — Alert via Telegram if /mnt/pi-data is not mounted.
# Silent on success. Runs every 15 minutes via cron.

set -euo pipefail

MOUNT="/mnt/pi-data"
ENV_FILE="/home/anton/nanoclaw/.env"
CHAT_ID_FILE="/home/anton/nanoclaw/groups/telegram_main/team-chat-jid"

_send_telegram() {
  local token chat_id msg="$1"
  token=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  chat_id=$(sed 's/^tg://' "$CHAT_ID_FILE")
  curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=${msg}" \
    > /dev/null
}

trap '_send_telegram "🔴 *mount-watchdog.sh crashed* at $(date +"%Y-%m-%d %H:%M:%S") (line ${LINENO})"' ERR

if mountpoint -q "$MOUNT"; then
  exit 0
fi

# Skip alert within 3 minutes of boot — drive may still be spinning up
UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)
if [ "$UPTIME_SECONDS" -lt 180 ]; then
  exit 0
fi

# Mount is down — send Telegram alert
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
_send_telegram "⚠️ *Mount alert*
${MOUNT} is NOT mounted at ${TIMESTAMP}.
NanoClaw data (store, logs, groups) is unavailable. Check USB drive."

exit 0
