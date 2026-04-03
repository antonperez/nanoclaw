#!/usr/bin/env bash
# health-check.sh — Ensure pm2 and nanoclaw are running. Restart if down.
# Sends Telegram alert only on failure/recovery. Silent on success.

set -euo pipefail

export PATH="/home/anton/.nvm/versions/node/v20.20.2/bin:$PATH"
PM2="/home/anton/.nvm/versions/node/v20.20.2/bin/pm2"
ENV_FILE="/home/anton/nanoclaw/.env"
CHAT_ID_FILE="/home/anton/nanoclaw/groups/telegram_main/team-chat-jid"

send_alert() {
  local msg="$1"
  local bot_token chat_id
  bot_token=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  chat_id=$(tr -d 'tg:' < "$CHAT_ID_FILE")
  curl -s -X POST "https://api.telegram.org/bot${bot_token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=${msg}" \
    > /dev/null
}

trap 'send_alert "🔴 *health-check.sh crashed* at $(date +"%Y-%m-%d %H:%M:%S") (line ${LINENO})"' ERR

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Check pm2 daemon
if ! "$PM2" ping > /dev/null 2>&1; then
  "$PM2" resurrect > /dev/null 2>&1 || true
  sleep 5
  if "$PM2" ping > /dev/null 2>&1; then
    send_alert "✅ *NanoClaw health check*
pm2 daemon was down at ${TIMESTAMP} — resurrected successfully."
  else
    send_alert "🔴 *NanoClaw health check*
pm2 daemon was down at ${TIMESTAMP} — resurrection failed. Manual intervention needed."
  fi
  exit 0
fi

# Check nanoclaw process status
STATUS=$("$PM2" show nanoclaw 2>/dev/null | grep -c "online" || echo 0)

if [ "$STATUS" -eq 0 ]; then
  "$PM2" restart nanoclaw > /dev/null 2>&1 || true
  sleep 5
  STATUS_AFTER=$("$PM2" show nanoclaw 2>/dev/null | grep -c "online" || echo 0)
  if [ "$STATUS_AFTER" -gt 0 ]; then
    send_alert "✅ *NanoClaw health check*
nanoclaw was down at ${TIMESTAMP} — restarted successfully."
  else
    send_alert "🔴 *NanoClaw health check*
nanoclaw was down at ${TIMESTAMP} — restart failed. Manual intervention needed."
  fi
fi

# Check error threshold — alert if >=3 ERRORs in the last 5 minutes
ERROR_LOG="/home/anton/.pm2/logs/nanoclaw-error.log"
ERROR_THRESHOLD=3
WINDOW_MINUTES=5
CUTOFF=$(date -d "${WINDOW_MINUTES} minutes ago" '+%H:%M:%S')
RECENT_COUNT=$(awk -v cutoff="$CUTOFF" '
  /ERROR/ { match($0, /\[([0-9]{2}:[0-9]{2}:[0-9]{2})/, t); if (t[1] >= cutoff) count++ }
  END { print count+0 }
' "$ERROR_LOG" 2>/dev/null || echo 0)

if [ "$RECENT_COUNT" -ge "$ERROR_THRESHOLD" ]; then
  send_alert "⚠️ *NanoClaw error threshold*
${RECENT_COUNT} errors in the last ${WINDOW_MINUTES} minutes at ${TIMESTAMP}."
fi

exit 0
