# NanoClaw Container Workflow

## Container Runtime
NanoClaw supports two container runtimes, auto-detected at startup in `src/container-runtime.ts`:

| Runtime | Platform | Binary | Host Gateway |
|---------|----------|--------|--------------|
| **Apple Container** | macOS | `container` | `192.168.64.1` (vmnet bridge) |
| **Docker** | Linux, WSL, macOS Docker Desktop | `docker` | `host.docker.internal` |

Override: `CONTAINER_RUNTIME=docker` and `CONTAINER_HOST_GATEWAY=<ip>` in `.env`

## Container Image

**Image name**: `nanoclaw-agent:latest`

### Build the Image
```bash
./container/build.sh
# Uses CONTAINER_RUNTIME env var (defaults to "container" for Apple Container)
# To build with Docker: CONTAINER_RUNTIME=docker ./container/build.sh
```

### Force Clean Rebuild
The buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps:
```bash
# Prune the builder cache first, then rebuild
container builder prune   # Apple Container
# or
docker builder prune      # Docker
./container/build.sh
```

### Test the Image Manually
```bash
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' \
  | container run -i nanoclaw-agent:latest
```

## Container Image Contents
- Base: `node:22-slim`
- System packages: Chromium + dependencies (for agent-browser skill)
- Global npm: `agent-browser`, `@anthropic-ai/claude-code`
- App: `container/agent-runner/` TypeScript source, compiled at startup (not build time)
- Working dir: `/workspace/group` (group filesystem)
- Entry: `/app/entrypoint.sh` — shadows .env, compiles agent-runner, drops privileges, runs agent

## Volume Mount Layout (at Runtime)

### Main Group Container
| Host Path | Container Path | Mode |
|-----------|---------------|------|
| `{project_root}/` | `/workspace/project` | read-only |
| `groups/{folder}/` | `/workspace/group` | read-write |
| `data/sessions/{folder}/.claude/` | `/home/node/.claude` | read-write |
| `data/ipc/{folder}/` | `/workspace/ipc` | read-write |
| `data/sessions/{folder}/agent-runner-src/` | `/app/src` | read-write |

### Non-Main Group Container
| Host Path | Container Path | Mode |
|-----------|---------------|------|
| `groups/{folder}/` | `/workspace/group` | read-write |
| `groups/global/` | `/workspace/global` | read-only |
| `.claude/` (project) | `/workspace/extra/nanoclaw` | read-only |
| `data/sessions/{folder}/.claude/` | `/home/node/.claude` | read-write |
| `data/ipc/{folder}/` | `/workspace/ipc` | read-write |
| `data/sessions/{folder}/agent-runner-src/` | `/app/src` | read-write |

### Additional Mounts
Configured per-group in `RegisteredGroup.containerConfig.additionalMounts`. Must be pre-approved in `~/.config/nanoclaw/mount-allowlist.json` (outside project root — containers cannot tamper with it).

## Credential Proxy
Containers never hold API keys. All AI calls route through the host's credential proxy:
- **Bind address**: `0.0.0.0:3001` (macOS Apple Container) or `127.0.0.1:3001` (Linux/WSL)
- **Container env**: `ANTHROPIC_BASE_URL=http://{HOST_GATEWAY}:3001`
- **Auth mode** auto-detected: API key (`ANTHROPIC_API_KEY=placeholder`) or OAuth (`CLAUDE_CODE_OAUTH_TOKEN=placeholder`)
- Proxy also handles CalDAV/CardDAV at `/__dav` path

## Container Lifecycle

### Naming
Container names: `nanoclaw-{groupFolder}-{timestamp}` (e.g. `nanoclaw-main-1704067200000`)

### Timeouts
- `CONTAINER_TIMEOUT` — hard timeout (default 1800000ms / 30min)
- `IDLE_TIMEOUT` — stdin closes after this idle period (default 1800000ms / 30min)
- Hard timeout = `max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30s)` to allow graceful shutdown

### Orphan Cleanup
`cleanupOrphans()` runs at startup to kill leftover `nanoclaw-*` containers from crashed sessions.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Container image to run |
| `CONTAINER_TIMEOUT` | `1800000` | Hard timeout in ms |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10MB) | Max stdout/stderr buffer |
| `IDLE_TIMEOUT` | `1800000` | Idle stdin close timeout in ms |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max parallel containers |
| `CREDENTIAL_PROXY_PORT` | `3001` | Credential proxy port |
| `CONTAINER_HOST_GATEWAY` | auto-detected | IP containers use to reach host |
| `CONTAINER_RUNTIME` | auto-detected | Runtime binary name |

## Container Security
- Non-root containers run as host UID:GID
- Main group containers start as root (needed for .env bind-shadow), then `setpriv` drops to host UID
- `.env` is shadowed with `/dev/null` inside main containers so agents cannot read host secrets
- Container reads/writes are isolated to their mounted directories

## Service Management

### Linux (systemd) — Primary Platform (Pi4)
```bash
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw
```

### macOS (launchd)
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
```

### Development
```bash
npm run dev   # tsx src/index.ts with hot reload
```

## Logs
Container run logs written to `groups/{folder}/logs/container-{timestamp}.log` after each run.
- Error exits: includes full stderr, stdout, container args, mount list
- Success exits: minimal log unless `LOG_LEVEL=debug`
- Timeout logs: noted with `(TIMEOUT)` suffix

## Last Updated
2026-04-06
