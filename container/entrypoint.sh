#!/bin/bash
set -e

# Shadow .env so the agent cannot read host secrets (requires root)
# mount --bind of a file may fail on overlayfs (containerd) — non-fatal
if [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then
  mount --bind /dev/null /workspace/project/.env 2>/dev/null || true
fi

# Restore .claude.json from backup if missing — prevents Claude CLI interactive setup prompt
if [ ! -f /home/node/.claude.json ]; then
  BACKUP=$(ls /home/node/.claude/backups/.claude.json.backup.* 2>/dev/null | sort | tail -1)
  if [ -n "$BACKUP" ]; then
    cp "$BACKUP" /home/node/.claude.json 2>/dev/null || true
    [ -n "$RUN_UID" ] && chown "$RUN_UID:$RUN_GID" /home/node/.claude.json 2>/dev/null || true
  fi
fi

# Compile agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Capture stdin (secrets JSON) to temp file
cat > /tmp/input.json

# Drop privileges if running as root (main-group containers)
if [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then
  chown "$RUN_UID:$RUN_GID" /tmp/input.json /tmp/dist
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- node /tmp/dist/index.js < /tmp/input.json
fi

exec node /tmp/dist/index.js < /tmp/input.json
