#!/bin/bash
# Refresh Claude OAuth token. Two-step: auth status (fast), then a real API
# call if the token is still expired/near-expiry. Mirrors ensureFreshOAuthToken()
# in credential-proxy.ts.
# Run via cron every 5 hours.

CLAUDE_BIN="/home/anton/.nvm/versions/node/v20.20.2/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-arm64/claude"
CREDS="$HOME/.claude/.credentials.json"
REFRESH_AHEAD_HOURS=1  # force API call if < 1h remaining

if [ ! -x "$CLAUDE_BIN" ]; then
    echo "$(date) Claude binary not found"
    exit 1
fi

get_expires_in_hours() {
    python3 -c "
import json, time, sys
try:
    d = json.load(open('$CREDS'))
    exp = d.get('claudeAiOauth', {}).get('expiresAt', 0)
    print(f'{(exp - time.time()*1000)/3600000:.1f}')
except Exception as e:
    print('?')
" 2>/dev/null
}

# Step 1: lightweight refresh
$CLAUDE_BIN auth status > /dev/null 2>&1
HOURS=$(get_expires_in_hours)

# Step 2: if still < 1h remaining (or negative), force a real API call
NEEDS_FORCE=$(python3 -c "
try:
    h = float('$HOURS')
    print('yes' if h < $REFRESH_AHEAD_HOURS else 'no')
except:
    print('yes')
" 2>/dev/null)

if [ "$NEEDS_FORCE" = "yes" ]; then
    echo "$(date) auth status insufficient (${HOURS}h left) — forcing API call to renew session"
    $CLAUDE_BIN --print '.' --model claude-haiku-4-5 --max-turns 1 > /dev/null 2>&1
    HOURS=$(get_expires_in_hours)
    echo "$(date) Token renewed via API call, expires in ${HOURS}h"
else
    echo "$(date) Token refreshed (auth status), expires in ${HOURS}h"
fi
