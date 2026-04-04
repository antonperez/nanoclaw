#!/usr/bin/env bash
# perf-report.sh — Generate and send Pi4 performance report via Telegram.
# Covers the last 3.5 days of data. Runs Mon + Thu.

set -euo pipefail

PERF_LOG="/mnt/pi-data/nanoclaw/logs/perf.jsonl"
ENV_FILE="/home/anton/nanoclaw/.env"
CHAT_ID_FILE="/home/anton/nanoclaw/groups/telegram_main/team-chat-jid"
CHART_TMP="/tmp/nanoclaw-perf-chart.png"

[ -f "$PERF_LOG" ] || { echo "No perf log yet"; exit 0; }

BOT_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_ID=$(sed 's/^tg://' "$CHAT_ID_FILE")

REPORT=$(python3 << 'PYEOF'
import json, sys
from datetime import datetime, timedelta, timezone

PERF_LOG = "/mnt/pi-data/nanoclaw/logs/perf.jsonl"
TRIAL_END = datetime(2026, 4, 30, tzinfo=timezone.utc)
NOW = datetime.now(timezone.utc)
CUTOFF = NOW - timedelta(hours=84)  # ~3.5 days

rows = []
total_in_log = 0
with open(PERF_LOG) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            total_in_log += 1
            ts = datetime.fromisoformat(d['ts'].replace('Z', '+00:00'))
            if ts >= CUTOFF:
                rows.append(d)
        except Exception:
            pass

# Trial progress
trial_start = datetime(2026, 4, 4, tzinfo=timezone.utc)
trial_days_elapsed = (NOW - trial_start).days
trial_days_total = (TRIAL_END - trial_start).days
trial_pct = min(trial_days_elapsed / trial_days_total * 100, 100)

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

pruned_count = total_in_log - len(rows)
data_note = f"_{period_start} → {period_end} · {samples} samples"
if pruned_count > 0:
    data_note += f" · {pruned_count} pruned (>7d)"
data_note += "_"

print(f"""📊 *NanoClaw Pi4 Trial Report*
{data_note}

*Trial* {trial_days_elapsed}/{trial_days_total}d ({trial_pct:.0f}%)

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

# --- Generate time series chart ---
python3 << 'PYEOF'
import json, os, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime, timedelta, timezone

PERF_LOG = "/mnt/pi-data/nanoclaw/logs/perf.jsonl"
CHART_OUT = "/tmp/nanoclaw-perf-chart.png"
CUTOFF = datetime.now(timezone.utc) - timedelta(hours=84)

timestamps, loads, temps, mems = [], [], [], []
with open(PERF_LOG) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            ts = datetime.fromisoformat(d['ts'].replace('Z', '+00:00'))
            if ts < CUTOFF:
                continue
            timestamps.append(ts)
            loads.append(d.get('load_1', 0))
            temps.append(d.get('cpu_temp_c', 0))
            mems.append(d.get('mem_used_mb', 0))
        except Exception:
            pass

if not timestamps:
    sys.exit(0)

mem_total = 7819  # fixed Pi4 total

fig, axes = plt.subplots(3, 1, figsize=(10, 7), sharex=True)
fig.patch.set_facecolor('#1a1a2e')
for ax in axes:
    ax.set_facecolor('#16213e')
    ax.tick_params(colors='#aaaacc', labelsize=8)
    ax.yaxis.label.set_color('#aaaacc')
    for spine in ax.spines.values():
        spine.set_edgecolor('#333355')

# Load
axes[0].plot(timestamps, loads, color='#4fc3f7', linewidth=0.8)
axes[0].axhline(y=1.0, color='#f7c948', linewidth=0.6, linestyle='--', alpha=0.6)
axes[0].set_ylabel('Load (1m)')
axes[0].set_ylim(bottom=0)

# Temp
axes[1].plot(timestamps, temps, color='#ff7043', linewidth=0.8)
axes[1].axhline(y=75, color='#ef5350', linewidth=0.6, linestyle='--', alpha=0.6)
axes[1].set_ylabel('Temp (°C)')
axes[1].set_ylim(bottom=0)

# Mem
mem_pct = [m / mem_total * 100 for m in mems]
axes[2].fill_between(timestamps, mem_pct, alpha=0.4, color='#ab47bc')
axes[2].plot(timestamps, mem_pct, color='#ab47bc', linewidth=0.8)
axes[2].axhline(y=85, color='#ef5350', linewidth=0.6, linestyle='--', alpha=0.6)
axes[2].set_ylabel('Mem (%)')
axes[2].set_ylim(0, 100)

# X axis formatting
axes[2].xaxis.set_major_formatter(mdates.DateFormatter('%m/%d %H:%M'))
axes[2].xaxis.set_major_locator(mdates.AutoDateLocator())
plt.setp(axes[2].xaxis.get_majorticklabels(), rotation=30, ha='right', color='#aaaacc')

period_start = timestamps[0].strftime('%Y-%m-%d')
period_end   = timestamps[-1].strftime('%Y-%m-%d')
fig.suptitle(f'NanoClaw Pi4 · {period_start} → {period_end}', color='#ccccee', fontsize=11)
plt.tight_layout()
plt.savefig(CHART_OUT, dpi=130, bbox_inches='tight', facecolor=fig.get_facecolor())
plt.close()
PYEOF

# --- Send text report ---
curl -s --max-time 10 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=${REPORT}" \
  > /dev/null

# --- Send chart if generated ---
if [ -f "$CHART_TMP" ]; then
  curl -s --max-time 30 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto" \
    -F "chat_id=${CHAT_ID}" \
    -F "photo=@${CHART_TMP}" \
    > /dev/null
  rm -f "$CHART_TMP"
fi
