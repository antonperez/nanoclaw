#!/usr/bin/env bash
# perf-report.sh — Generate and send Pi4 performance report via Telegram.
# Covers the last 3.5 days of data. Runs Mon + Thu.

set -euo pipefail

PERF_LOG="/mnt/pi-data/nanoclaw/logs/perf.jsonl"
ENV_FILE="/home/anton/nanoclaw/.env"
CHAT_ID_FILE="/home/anton/nanoclaw/groups/telegram_main/team-chat-jid"

[ -f "$PERF_LOG" ] || { echo "No perf log yet"; exit 0; }

BOT_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_ID=$(sed 's/^tg://' "$CHAT_ID_FILE")

REPORT=$(python3 << 'PYEOF'
import json, sys
from datetime import datetime, timedelta, timezone

PERF_LOG = "/mnt/pi-data/nanoclaw/logs/perf.jsonl"
CUTOFF = datetime.now(timezone.utc) - timedelta(hours=84)  # ~3.5 days

rows = []
with open(PERF_LOG) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            ts = datetime.fromisoformat(d['ts'].replace('Z', '+00:00'))
            if ts >= CUTOFF:
                rows.append(d)
        except Exception:
            pass

if not rows:
    print("No data yet for this period.")
    sys.exit(0)

# System stats
loads = [r['load_1'] for r in rows]
temps = [r['cpu_temp_c'] for r in rows if r.get('cpu_temp_c', 0) > 0]
mems = [r['mem_used_mb'] for r in rows]
mem_total = rows[-1].get('mem_total_mb', 4096)
freqs = [r.get('cpu_freq_mhz', 0) for r in rows if r.get('cpu_freq_mhz', 0) > 0]

avg_load  = sum(loads) / len(loads)
max_load  = max(loads)
avg_temp  = sum(temps) / len(temps) if temps else 0
max_temp  = max(temps) if temps else 0
avg_mem   = sum(mems) / len(mems)
max_mem   = max(mems)
avg_freq  = sum(freqs) / len(freqs) if freqs else 0

# Container stats
all_durations = []
total_runs   = 0
total_errors = 0
pm2_restarts = max((r.get('pm2_restarts', 0) for r in rows), default=0)
online_pct   = sum(1 for r in rows if r.get('pm2_status') == 'online') / len(rows) * 100

# Disk — use latest sample (changes slowly)
last = rows[-1]
df_root_used  = last.get('df_root_used_mb', 0)
df_root_total = last.get('df_root_total_mb', 1)
df_data_used  = last.get('df_data_used_mb', 0)
df_data_total = last.get('df_data_total_mb', 1)
df_root_pct   = df_root_used / df_root_total * 100 if df_root_total else 0
df_data_pct   = df_data_used / df_data_total * 100 if df_data_total else 0

for r in rows:
    total_runs   += r.get('container_runs', 0)
    total_errors += r.get('container_errors', 0)
    all_durations.extend(r.get('durations_ms', []))

error_rate = (total_errors / total_runs * 100) if total_runs > 0 else 0

avg_dur = sum(all_durations) / len(all_durations) / 1000 if all_durations else 0
p95_dur = max_dur = 0
if all_durations:
    sorted_durs = sorted(all_durations)
    p95_dur = sorted_durs[int(len(sorted_durs) * 0.95)] / 1000
    max_dur = sorted_durs[-1] / 1000

period_start = rows[0]['ts'][:10]
period_end   = rows[-1]['ts'][:10]
samples      = len(rows)

# Pi4 fitness verdict
issues = []
if max_temp > 75:
    issues.append("🔥 CPU throttling risk (peak >75°C)")
if avg_load > 3.0:
    issues.append("⚠️ Sustained high load (avg >3.0)")
if error_rate > 10:
    issues.append(f"⚠️ High container error rate ({error_rate:.0f}%)")
if p95_dur > 120:
    issues.append(f"⚠️ Slow p95 response time ({p95_dur:.0f}s)")
if max_mem > mem_total * 0.85:
    issues.append(f"⚠️ Memory pressure ({max_mem}MB / {mem_total}MB)")
if df_root_pct > 85:
    issues.append(f"⚠️ Root disk full ({df_root_pct:.0f}%)")
if df_data_pct > 85:
    issues.append(f"⚠️ Data disk full ({df_data_pct:.0f}%)")

verdict = "✅ Pi4 handling it well" if not issues else "\n".join(issues)

print(f"""📊 *NanoClaw Pi4 Trial Report*
_{period_start} → {period_end} · {samples} samples_

*System*
Load: {avg_load:.2f} avg / {max_load:.2f} peak
Temp: {avg_temp:.1f}°C avg / {max_temp:.1f}°C peak
Mem: {avg_mem:.0f}MB avg / {max_mem:.0f}MB peak (of {mem_total}MB)
CPU: {avg_freq:.0f}MHz avg

*Containers*
Runs: {total_runs} · Errors: {total_errors} ({error_rate:.1f}%)
Avg: {avg_dur:.1f}s · p95: {p95_dur:.1f}s · Max: {max_dur:.1f}s

*Disk*
/: {df_root_used/1024:.1f}GB / {df_root_total/1024:.1f}GB ({df_root_pct:.0f}%)
/mnt/pi-data: {df_data_used/1024:.1f}GB / {df_data_total/1024:.1f}GB ({df_data_pct:.0f}%)

*Stability*
PM2 uptime: {online_pct:.1f}% · Restarts: {pm2_restarts}

*Assessment*
{verdict}""")
PYEOF
)

curl -s --max-time 10 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=${REPORT}" \
  > /dev/null
