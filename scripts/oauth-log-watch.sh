#!/usr/bin/env bash
# oauth-log-watch.sh — Periodic check for MCP OAuth persist failures.
# Wired into host crontab. Silent on clean log; sends Telegram alert if log
# has any new content since last cleared.
#
# Background: mcp-server/src/oauth.ts persist() catch logs failures here.
# Was firing repeatedly Apr 25 2026; root cause data-dependent + unreproducible
# at time of diagnosis. Defensive instrumentation in place — first new failure
# will land here with full step + stack trace.

set -eu

LOG="/home/anton/.pm2/logs/nanoclaw-mcp-error.log"
NANOCLAW_DIR="/home/anton/nanoclaw"
ENV_FILE="$NANOCLAW_DIR/.env"
CHAT_ID_FILE="$NANOCLAW_DIR/groups/telegram_main/team-chat-jid"

# Silent if log doesn't exist or is empty
[ -s "$LOG" ] || exit 0

BOT_TOKEN="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
CHAT_ID="$(sed 's/^tg://' "$CHAT_ID_FILE")"

# Take first 800 chars of the log so the message stays Telegram-sized
SNIPPET="$(head -c 800 "$LOG")"

MSG="$(cat <<EOF
⚠️ *MCP OAuth persist failure*
Time: $(date '+%Y-%m-%d %H:%M')
File: \`$LOG\`

\`\`\`
$SNIPPET
\`\`\`

Inspect with: \`pm2 logs nanoclaw-mcp --err --lines 30\`
After fixing, clear with: \`> $LOG\`
EOF
)"

curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=${MSG}" \
  >/dev/null
