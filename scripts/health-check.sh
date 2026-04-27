#!/usr/bin/env bash
# health-check.sh — Ensure pm2 and nanoclaw are running. Restart if down.
# Sends Telegram alert only on failure/recovery. Silent on success.

set -euo pipefail

export PATH="/home/anton/.nvm/versions/node/v20.20.2/bin:$PATH"
PM2="/home/anton/.nvm/versions/node/v20.20.2/bin/pm2"
ENV_FILE="/home/anton/nanoclaw/.env"
CHAT_ID_FILE="/home/anton/nanoclaw/groups/telegram_main/team-chat-jid"
ERROR_LOG="/mnt/pi/nanoclaw/logs/nanoclaw.log"
STATE_FILE="${XDG_RUNTIME_DIR:-/tmp}/nanoclaw-health-state"
RESTART_COUNT_FILE="${XDG_RUNTIME_DIR:-/tmp}/nanoclaw-restart-count"
ALERT_COOLDOWN_FILE="${XDG_RUNTIME_DIR:-/tmp}/nanoclaw-alert-cooldown"
SUSTAINED_FILE="${XDG_RUNTIME_DIR:-/tmp}/nanoclaw-error-sustained"

# Skip within 2 minutes of boot — pm2 may still be starting up
UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)
if [ "$UPTIME_SECONDS" -lt 120 ]; then
  exit 0
fi

send_alert() {
  local msg="$1"
  local bot_token chat_id
  bot_token=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  chat_id=$(sed 's/^tg://' "$CHAT_ID_FILE")
  # || true: don't fail if internet is down — alert is best-effort
  curl -s --max-time 10 -X POST "https://api.telegram.org/bot${bot_token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=${msg}" \
    > /dev/null || true
}

trap 'send_alert "🔴 *health-check.sh crashed* at $(date +"%Y-%m-%d %H:%M:%S") (line ${LINENO})"' ERR

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# --- pm2 daemon check ---
if ! "$PM2" ping > /dev/null 2>&1; then
  "$PM2" resurrect > /dev/null 2>&1 || true
  sleep 5
  if "$PM2" ping > /dev/null 2>&1; then
    "$PM2" save > /dev/null 2>&1 || true
    send_alert "✅ *NanoClaw health check*
pm2 daemon was down at ${TIMESTAMP} — resurrected successfully."
  else
    send_alert "🔴 *NanoClaw health check*
pm2 daemon was down at ${TIMESTAMP} — resurrection failed. Manual intervention needed."
    exit 0
  fi
fi

# --- nanoclaw process check ---
STATUS=$("$PM2" show nanoclaw 2>/dev/null | grep -c "online" || echo 0)

if [ "$STATUS" -eq 0 ]; then
  "$PM2" restart nanoclaw > /dev/null 2>&1 || true
  sleep 5
  STATUS_AFTER=$("$PM2" show nanoclaw 2>/dev/null | grep -c "online" || echo 0)
  if [ "$STATUS_AFTER" -gt 0 ]; then
    "$PM2" save > /dev/null 2>&1 || true
    send_alert "✅ *NanoClaw health check*
nanoclaw was down at ${TIMESTAMP} — restarted successfully."
  else
    send_alert "🔴 *NanoClaw health check*
nanoclaw was down at ${TIMESTAMP} — restart failed. Manual intervention needed."
  fi
fi

# --- PM2 auto-restart detection ---
# Detects when PM2 restarted nanoclaw on its own (crash recovery), not via this script.
# Only fires when nanoclaw was already online — health-check-triggered restarts are
# reported by the block above.
if [ "$STATUS" -gt 0 ]; then
  CURRENT_RESTARTS=$("$PM2" jlist 2>/dev/null | python3 -c "
import json,sys
data=json.load(sys.stdin)
nc=next((p for p in data if p.get('name')=='nanoclaw'),None)
print(nc.get('pm2_env',{}).get('restart_time',0) if nc else 0)
" 2>/dev/null || echo 0)
  PREV_RESTARTS=$(cat "$RESTART_COUNT_FILE" 2>/dev/null || echo "$CURRENT_RESTARTS")
  echo "$CURRENT_RESTARTS" > "$RESTART_COUNT_FILE"
  if [ "$CURRENT_RESTARTS" -gt "$PREV_RESTARTS" ]; then
    DELTA=$(( CURRENT_RESTARTS - PREV_RESTARTS ))
    send_alert "🔄 *NanoClaw process restarted* (Pi4)
PM2 auto-restarted nanoclaw ${DELTA}x (total restarts: ${CURRENT_RESTARTS}) at ${TIMESTAMP}."
  fi
fi

# --- error / fatal threshold check ---
# Line-position tracking persists between runs in tmpfs (cleared on reboot).
# Tier 1 — FATAL: alert immediately on any new fatal, no threshold.
# Tier 2 — ERROR: alert only when threshold exceeded in two consecutive checks (sustained).
# Cooldown: suppress ERROR alerts for 30 min after one fires to avoid spam.
ERROR_THRESHOLD=10
COOLDOWN_SECONDS=1800

CURRENT_LINES=$(wc -l < "$ERROR_LOG" 2>/dev/null || echo 0)
PREV_LINES=$(cat "$STATE_FILE" 2>/dev/null || echo "$CURRENT_LINES")
echo "$CURRENT_LINES" > "$STATE_FILE"

NEW_FATALS=0
NEW_ERRORS=0
if [ "$CURRENT_LINES" -gt "$PREV_LINES" ]; then
  NEW_LINES=$(tail -n "+$((PREV_LINES + 1))" "$ERROR_LOG" 2>/dev/null)
  NEW_FATALS=$(echo "$NEW_LINES" | grep -c "FATAL" || echo 0)
  NEW_ERRORS=$(echo "$NEW_LINES" | grep -c "] ERROR" || echo 0)
fi

# Tier 1: FATAL — always alert immediately
if [ "$NEW_FATALS" -gt 0 ]; then
  send_alert "🚨 *NanoClaw fatal error* (Pi4)
${NEW_FATALS} FATAL event(s) at ${TIMESTAMP}. Immediate attention required."
fi

# Tier 2: ERROR — require sustained (two consecutive checks above threshold)
if [ "$NEW_ERRORS" -ge "$ERROR_THRESHOLD" ]; then
  PREV_OVER=$(cat "$SUSTAINED_FILE" 2>/dev/null || echo 0)
  echo 1 > "$SUSTAINED_FILE"
  if [ "$PREV_OVER" -eq 1 ]; then
    # Check cooldown
    LAST_ALERT=$(cat "$ALERT_COOLDOWN_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    if [ $(( NOW - LAST_ALERT )) -ge "$COOLDOWN_SECONDS" ]; then
      echo "$NOW" > "$ALERT_COOLDOWN_FILE"
      send_alert "⚠️ *NanoClaw error threshold* (Pi4)
${NEW_ERRORS} new errors in this check (sustained). Threshold: ${ERROR_THRESHOLD}. At ${TIMESTAMP}."
    fi
  fi
else
  echo 0 > "$SUSTAINED_FILE"
fi

exit 0
