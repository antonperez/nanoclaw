#!/usr/bin/env bash
# weekly-restart.sh — Restart nanoclaw via pm2 with correct PATH for cron.
# Cron runs with a minimal PATH that excludes nvm, so we source nvm first
# to pick up whatever node version is set as default.

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
source "$NVM_DIR/nvm.sh"

exec pm2 restart nanoclaw
