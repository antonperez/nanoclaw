#!/usr/bin/env bash
# mount-watchdog.sh — Alert via Telegram if critical mounts are down.
# Silent on success. Runs every 15 minutes via cron.

set -euo pipefail

MOUNTS=("/mnt/pi" "/mnt/pi/gdrive/aa")
LABELS=("USB drive (NanoClaw data)" "Google Drive A&A (tennis bot logs)")
ENV_FILE="/home/anton/nanoclaw/.env"
CHAT_ID_FILE="/home/anton/nanoclaw/groups/telegram_main/team-chat-jid"

_send_telegram() {
  local token chat_id msg="$1"
  token=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  chat_id=$(sed 's/^tg://' "$CHAT_ID_FILE")
  curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage"     -d "chat_id=${chat_id}"     -d "parse_mode=Markdown"     --data-urlencode "text=${msg}"     > /dev/null
}

trap '_send_telegram "🔴 *mount-watchdog.sh crashed* at $(date +"%Y-%m-%d %H:%M:%S") (line ${LINENO})"' ERR

# Skip within 3 minutes of boot
UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)
if [ "$UPTIME_SECONDS" -lt 180 ]; then
  exit 0
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

for i in "${!MOUNTS[@]}"; do
  if ! mountpoint -q "${MOUNTS[$i]}"; then
    _send_telegram "⚠️ *Mount alert*
${MOUNTS[$i]} is NOT mounted at ${TIMESTAMP}.
${LABELS[$i]} is unavailable."
  fi
done

exit 0
