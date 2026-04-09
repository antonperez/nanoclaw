#!/usr/bin/env bash
# perf-collector.sh — Sample nanoclaw + system performance every 10 minutes.
# Appends one JSON line to perf.jsonl.
#
# Feature flag: touch /home/anton/nanoclaw/.perf-disabled to pause collection.

set -euo pipefail

[ -f /home/anton/nanoclaw/.perf-disabled ] && exit 0

export PATH="/home/anton/.nvm/versions/node/v20.20.2/bin:$PATH"
PM2="/home/anton/.nvm/versions/node/v20.20.2/bin/pm2"
PERF_LOG="/mnt/pi/nanoclaw/logs/perf.jsonl"
SCAN_REF="${XDG_RUNTIME_DIR:-/tmp}/nanoclaw-perf-scan-ref"
GROUPS_DIR="/home/anton/nanoclaw/groups"
NANOCLAW_DIR="/home/anton/nanoclaw"
BOOT_TS_FILE="/mnt/pi/nanoclaw/logs/last-boot-ts"

# --- Boot detection + Telegram notification ---
CURRENT_BOOT=$(awk '{print int($1)}' /proc/uptime)
# Use /proc/stat btime — kernel's actual boot epoch, fixed for the lifetime of a boot
CURRENT_BOOT_EPOCH=$(awk '/^btime / {print $2}' /proc/stat)

notify_restart() {
  local bot_token chat_id uptime_min msg
  bot_token=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$NANOCLAW_DIR/.env" 2>/dev/null | cut -d= -f2-) || return
  local chat_id_file="$NANOCLAW_DIR/groups/telegram_main/team-chat-jid"
  [ -f "$chat_id_file" ] || return
  chat_id=$(sed 's/^tg://' "$chat_id_file")
  uptime_min=$(( CURRENT_BOOT / 60 ))
  msg="🔄 *Pi4 rebooted* — NanoClaw back online
Time: $(date '+%Y-%m-%d %H:%M:%S')
Uptime: ${uptime_min}m"
  curl -s -X POST "https://api.telegram.org/bot${bot_token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=${msg}" \
    > /dev/null || true
}

if [ -f "$BOOT_TS_FILE" ]; then
  LAST_BOOT_EPOCH=$(cat "$BOOT_TS_FILE")
  if [ "$CURRENT_BOOT_EPOCH" != "$LAST_BOOT_EPOCH" ]; then
    notify_restart
    echo "$CURRENT_BOOT_EPOCH" > "$BOOT_TS_FILE"
  fi
else
  # First run — record boot epoch, no notification (no baseline to compare against)
  echo "$CURRENT_BOOT_EPOCH" > "$BOOT_TS_FILE"
fi

# --- System metrics ---
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOAD_1=$(awk '{print $1}' /proc/loadavg)
LOAD_5=$(awk '{print $2}' /proc/loadavg)
LOAD_15=$(awk '{print $3}' /proc/loadavg)
MEM_TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
MEM_AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
MEM_USED_MB=$((MEM_TOTAL_MB - MEM_AVAIL_MB))
CPU_TEMP=$(vcgencmd measure_temp 2>/dev/null | grep -oP '[0-9.]+' || echo "0")
CPU_FREQ_HZ=$(vcgencmd measure_clock arm 2>/dev/null | grep -oP '[0-9]+$' || echo "0")
CPU_FREQ_MHZ=$((CPU_FREQ_HZ / 1000000))

# --- Disk metrics ---
read -r DF_ROOT_USED_MB DF_ROOT_TOTAL_MB < <(df -k / | awk 'NR==2 {print int($3/1024), int($2/1024)}')
read -r DF_DATA_USED_MB DF_DATA_TOTAL_MB < <(df -k /mnt/pi 2>/dev/null | awk 'NR==2 {print int($3/1024), int($2/1024)}' || echo "0 0")

# --- PM2 metrics ---
PM2_JSON=$("$PM2" jlist 2>/dev/null || echo "[]")
read -r PM2_STATUS PM2_MEM_MB PM2_CPU_PCT PM2_RESTARTS < <(
  echo "$PM2_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
nc = next((p for p in data if p.get('name') == 'nanoclaw'), None)
if nc:
    status = nc.get('pm2_env', {}).get('status', 'unknown')
    mem = nc.get('monit', {}).get('memory', 0) // 1024 // 1024
    cpu = nc.get('monit', {}).get('cpu', 0)
    restarts = nc.get('pm2_env', {}).get('restart_time', 0)
    print(f'{status} {mem} {cpu} {restarts}')
else:
    print('unknown 0 0 0')
" 2>/dev/null || echo "unknown 0 0 0"
)

# --- Container runs since last scan ---
# Uses a reference file to find container logs created since the previous run.
# First run: no ref file — skip container scanning (avoids counting old backlog).
CONTAINER_RUNS=0
CONTAINER_ERRORS=0
DURATIONS_JSON="[]"

if [ -f "$SCAN_REF" ]; then
  dur_list=""
  while IFS= read -r -d '' logfile; do
    dur=$(grep -m1 '^Duration:' "$logfile" 2>/dev/null | grep -oP '\d+' || true)
    code=$(grep -m1 '^Exit Code:' "$logfile" 2>/dev/null | grep -oP '\d+' || echo "1")
    [ -z "$dur" ] && continue
    CONTAINER_RUNS=$((CONTAINER_RUNS + 1))
    dur_list="${dur_list:+$dur_list,}$dur"
    [ "$code" != "0" ] && CONTAINER_ERRORS=$((CONTAINER_ERRORS + 1))
  done < <(find "$GROUPS_DIR" -name "container-*.log" -newer "$SCAN_REF" -print0 2>/dev/null)
  [ -n "$dur_list" ] && DURATIONS_JSON="[$dur_list]"
fi
touch "$SCAN_REF"

# --- Append JSON line ---
cat >> "$PERF_LOG" << EOF
{"ts":"$TS","load_1":$LOAD_1,"load_5":$LOAD_5,"load_15":$LOAD_15,"mem_used_mb":$MEM_USED_MB,"mem_total_mb":$MEM_TOTAL_MB,"cpu_temp_c":$CPU_TEMP,"cpu_freq_mhz":$CPU_FREQ_MHZ,"df_root_used_mb":$DF_ROOT_USED_MB,"df_root_total_mb":$DF_ROOT_TOTAL_MB,"df_data_used_mb":$DF_DATA_USED_MB,"df_data_total_mb":$DF_DATA_TOTAL_MB,"pm2_status":"$PM2_STATUS","pm2_mem_mb":$PM2_MEM_MB,"pm2_cpu_pct":$PM2_CPU_PCT,"pm2_restarts":$PM2_RESTARTS,"container_runs":$CONTAINER_RUNS,"container_errors":$CONTAINER_ERRORS,"durations_ms":$DURATIONS_JSON}
EOF

# --- Prune entries older than 7 days (once per day, not every run) ---
PRUNE_STAMP="${XDG_RUNTIME_DIR:-/tmp}/nanoclaw-perf-pruned"
TODAY=$(date -u +%Y-%m-%d)
if [ ! -f "$PRUNE_STAMP" ] || [ "$(cat "$PRUNE_STAMP" 2>/dev/null)" != "$TODAY" ]; then
  echo "$TODAY" > "$PRUNE_STAMP"
python3 - "$PERF_LOG" << 'PYEOF'
import json, sys, os
from datetime import datetime, timedelta, timezone

log = sys.argv[1]
cutoff = datetime.now(timezone.utc) - timedelta(days=7)
tmp = log + ".tmp"

kept = pruned = 0
with open(log) as fin, open(tmp, "w") as fout:
    for line in fin:
        line = line.strip()
        if not line:
            continue
        try:
            ts = datetime.fromisoformat(json.loads(line)["ts"].replace("Z", "+00:00"))
            if ts >= cutoff:
                fout.write(line + "\n")
                kept += 1
            else:
                pruned += 1
        except Exception:
            fout.write(line + "\n")  # keep unparseable lines

os.replace(tmp, log)
if pruned:
    print(f"perf-collector: pruned {pruned} samples older than 7d, kept {kept}", flush=True)
PYEOF
fi
