#!/usr/bin/env bash
# mcp-write-digest.sh — Weekly summary of MCP write_file activity.
# Reads the last 7 days from store/mcp-writes.jsonl.
# Runs every Monday. Sends to team chat via Telegram Bot API.

set -euo pipefail

LOG_FILE="/mnt/pi/nanoclaw/store/mcp-writes.jsonl"
ENV_FILE="/home/anton/nanoclaw/.env"
CHAT_ID_FILE="/home/anton/nanoclaw/groups/telegram_main/team-chat-jid"

[ -f "$LOG_FILE" ] || { echo "No mcp-writes log yet"; exit 0; }

BOT_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_ID=$(sed 's/^tg://' "$CHAT_ID_FILE")

REPORT=$(python3 << 'PYEOF'
import json, sys
from datetime import datetime, timedelta, timezone
from collections import defaultdict

LOG_FILE = "/mnt/pi/nanoclaw/store/mcp-writes.jsonl"
NOW = datetime.now(timezone.utc)
CUTOFF = NOW - timedelta(days=7)

entries = []
with open(LOG_FILE) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            ts = datetime.fromisoformat(d['ts'].replace('Z', '+00:00'))
            if ts >= CUTOFF:
                entries.append(d)
        except Exception:
            pass

total = len(entries)
if total == 0:
    print("No MCP writes in the last 7 days.")
    sys.exit(0)

# Group by top-level directory
by_dir = defaultdict(list)
for e in entries:
    parts = e['path'].split('/')
    top = parts[0] if len(parts) > 1 else '(root)'
    by_dir[top].append(e)

# Most written files
file_counts = defaultdict(int)
for e in entries:
    file_counts[e['path']] += 1
top_files = sorted(file_counts.items(), key=lambda x: -x[1])[:5]

# Byte total
total_bytes = sum(e.get('bytes', 0) for e in entries)

period_start = CUTOFF.strftime('%b %d')
period_end   = NOW.strftime('%b %d')

dir_lines = []
for d, items in sorted(by_dir.items(), key=lambda x: -len(x[1])):
    overwrite = sum(1 for e in items if e.get('mode') != 'append')
    append    = sum(1 for e in items if e.get('mode') == 'append')
    parts = [f"{len(items)} write{'s' if len(items)>1 else ''}"]
    if append:
        parts.append(f"{append} append{'s' if append>1 else ''}")
    dir_lines.append(f"  {d}/  —  {', '.join(parts)}")

file_lines = [f"  {count}×  {p}" for p, count in top_files]

print(f"""📝 *MCP Write Digest* — {period_start}–{period_end}

*{total} write{'s' if total != 1 else ''}* across {len(by_dir)} director{'ies' if len(by_dir) != 1 else 'y'} · {total_bytes/1024:.1f} KB total

*By directory:*
{chr(10).join(dir_lines)}

*Most written:*
{chr(10).join(file_lines) if file_lines else '  (none)'}""")
PYEOF
)

curl -s --max-time 10 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=${REPORT}" \
  > /dev/null
