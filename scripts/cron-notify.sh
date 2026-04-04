#!/usr/bin/env bash
# cron-notify.sh — Run a cron job and post result to Telegram
#
# Usage: cron-notify.sh "Job Name" command [args...]
#
# Reads BOT_TOKEN from /home/anton/nanoclaw/.env
# Reads CHAT_ID from /home/anton/nanoclaw/groups/telegram_main/team-chat-jid

set -euo pipefail

NANOCLAW_DIR="/home/anton/nanoclaw"
ENV_FILE="$NANOCLAW_DIR/.env"
CHAT_ID_FILE="$NANOCLAW_DIR/groups/telegram_main/team-chat-jid"

# Load bot token from .env
BOT_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_ID=$(sed 's/^tg://' "$CHAT_ID_FILE")

JOB_NAME="$1"
shift

START=$(date +%s)
START_TIME=$(date '+%Y-%m-%d %H:%M:%S')

# Run the job, capturing output and exit code
OUTPUT=$("$@" 2>&1) && EXIT_CODE=0 || EXIT_CODE=$?

END=$(date +%s)
DURATION=$(( END - START ))

if [ "$EXIT_CODE" -eq 0 ]; then
  STATUS="✅"
  RESULT="succeeded"
else
  STATUS="❌"
  RESULT="failed (exit $EXIT_CODE)"
fi

MSG="${STATUS} *Cron: ${JOB_NAME}*
Time: ${START_TIME}
Duration: ${DURATION}s
Status: ${RESULT}"

if [ -n "$OUTPUT" ]; then
  # Truncate long output
  TRUNCATED=$(echo "$OUTPUT" | tail -c 500)
  MSG="${MSG}
\`\`\`
${TRUNCATED}
\`\`\`"
fi

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=${MSG}" \
  > /dev/null

exit "$EXIT_CODE"
