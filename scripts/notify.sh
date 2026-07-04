#!/bin/bash
# Send a Telegram message to Anton via ilfraffBot.
# Usage: notify.sh "your message here"
# Reads TELEGRAM_BOT_TOKEN from /home/anton/nanoclaw/.env

CHAT_ID=$(sed 's/^tg://' /home/anton/nanoclaw/groups/telegram_main/team-chat-jid)
TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" /home/anton/nanoclaw/.env 2>/dev/null | cut -d= -f2)

if [ -z "$TOKEN" ]; then
  echo "[notify] TELEGRAM_BOT_TOKEN not found in .env" >&2
  exit 1
fi

MESSAGE="${1:-}"
if [ -z "$MESSAGE" ]; then
  echo "[notify] usage: $0 'message'" >&2
  exit 1
fi

curl -s -o /dev/null -X POST \
  "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=${MESSAGE}"
