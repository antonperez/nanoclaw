# NanoClaw Architecture

## Overview
Single Node.js process (TypeScript/ESM) that bridges messaging channels to Claude AI agents running in isolated containers (Linux VMs). Personal assistant platform. Each group has an isolated filesystem and conversation memory.

## Tech Stack
- **Language**: TypeScript 5.7 (strict, ESM modules)
- **Runtime**: Node.js >= 20
- **Database**: SQLite via `better-sqlite3` (synchronous)
- **Test framework**: Vitest 4
- **Key deps**: grammy (Telegram), nodemailer (email), pino (logging), zod (validation), cron-parser (scheduling), yaml

## Top-Level Directory Structure
```
src/                  - Host process TypeScript source
src/channels/         - Channel implementations (Telegram + registry)
container/            - Agent container: Dockerfile, build.sh, agent-runner/, skills/
container/agent-runner/ - TypeScript agent that runs inside containers (Claude Code SDK)
container/skills/     - Skills loaded into agent containers at runtime
groups/               - Per-group persistent filesystems (CLAUDE.md, logs/)
groups/main/          - Main group template (elevated privileges)
groups/global/        - Global memory template (shared read-only by non-main)
data/                 - SQLite DB, IPC files, session state
data/ipc/             - Per-group IPC directories polled by host
data/sessions/        - Per-group Claude session files + .claude/ settings
store/                - WhatsApp auth credentials (if installed)
.claude/              - Project-level Claude settings and skills
```

## Core Message Flow
1. **Channel** (Telegram/WhatsApp/Slack/Discord/Gmail) receives inbound message
2. `src/index.ts` stores message via `db.ts` → SQLite `messages` table
3. **Message loop** polls every 2s (`POLL_INTERVAL`) for new messages in registered groups
4. Trigger check: non-main groups require `@Andy` prefix (configurable); main group always processes
5. `GroupQueue` serializes processing per group — one container at a time per group
6. **Model router** (`src/model-router.ts`) selects backend: Claude (default), DeepSeek (`ds`/`deepseek` prefix), or Ollama (`vault`/`ollama` prefix)
7. For Claude: `container-runner.ts` spawns `nanoclaw-agent:latest` container with mounts
8. Container runs Claude Code SDK agent, streams output back via sentinel markers
9. Results sent to originating chat via channel's `sendMessage`

## Key Modules

| Module | Responsibility |
|--------|---------------|
| `src/index.ts` | Orchestrator: state, message loop, agent dispatch, command handlers (/reset, /remote-control) |
| `src/channels/registry.ts` | Self-registration pattern for channels (Map-based factory registry) |
| `src/channels/telegram.ts` | Telegram channel + bot pool for agent swarm |
| `src/channels/index.ts` | Barrel import that triggers all channel self-registrations |
| `src/container-runner.ts` | Spawns containers, builds volume mounts, streams output via sentinel markers |
| `src/container-runtime.ts` | Runtime abstraction: Apple Container (macOS) vs Docker (Linux/WSL) |
| `src/ipc.ts` | Polls `data/ipc/` for agent commands; handles messages, tasks, emails, group registration |
| `src/router.ts` | Message formatting (XML inbound context, outbound text stripping) + channel routing |
| `src/model-router.ts` | Routes messages to Claude/DeepSeek/Ollama based on keyword prefix |
| `src/db.ts` | All SQLite operations — messages, chats, groups, sessions, tasks, router state |
| `src/task-scheduler.ts` | Cron/interval/once task execution loop (60s poll) |
| `src/group-queue.ts` | Per-group serialized processing, stdin pipe to active container, retry with backoff |
| `src/group-folder.ts` | Resolves group filesystem paths; validates folder names |
| `src/credential-proxy.ts` | HTTP proxy on port 3001 — injects API keys so containers never see secrets; also proxies CalDAV/CardDAV |
| `src/sender-allowlist.ts` | Security: allowlist/blocklist for message senders per group |
| `src/mount-security.ts` | Validates additional container mounts against `~/.config/nanoclaw/mount-allowlist.json` |
| `src/remote-control.ts` | Remote control sessions (main group only) |
| `src/config.ts` | All env-driven config constants (POLL_INTERVAL, GROUPS_DIR, triggers, model backends) |
| `src/env.ts` | Reads .env file, returns named keys |
| `src/logger.ts` | Pino logger |
| `src/timezone.ts` | IANA timezone validation and local time formatting |
| `src/types.ts` | All shared TypeScript interfaces (Channel, NewMessage, RegisteredGroup, ScheduledTask, etc.) |

## Channel System
Channels self-register at startup via barrel import (`src/channels/index.ts`). Pattern:
```typescript
registerChannel('telegram', (opts) => {
  if (!hasCredentials()) return null; // silently skip
  return new TelegramChannel(opts);
});
```
`src/index.ts` iterates `getRegisteredChannelNames()` and calls each factory. Channels returning `null` are skipped. A `Channel` must implement: `connect`, `sendMessage`, `isConnected`, `ownsJid`, `disconnect`. Optional: `setTyping`, `syncGroups`.

## Container Isolation Model
Each group gets a separate container run with tailored mounts:

**Main group container mounts:**
- `/workspace/project` — project root (read-only, agent-runner reference)
- `/workspace/group` — group filesystem (read-write)
- `/home/node/.claude` — per-group Claude sessions + skills (read-write)
- `/workspace/ipc` — per-group IPC directory (read-write)
- `/app/src` — per-group copy of agent-runner source (read-write, customizable)

**Non-main group container mounts:**
- `/workspace/group` — group filesystem (read-write)
- `/workspace/global` — global memory (read-only)
- `/workspace/extra/nanoclaw` — project .claude/ for model routing rules (read-only)
- `/home/node/.claude` — per-group Claude sessions (read-write)
- `/workspace/ipc` — per-group IPC directory (read-write)
- `/app/src` — per-group agent-runner source (read-write)

Additional mounts validated against `~/.config/nanoclaw/mount-allowlist.json` (outside project root — tamper-proof from containers).

## IPC System (Agent to Host)
Agents write JSON files to `/workspace/ipc/{subdir}/` inside the container. Host polls every 1s.

IPC subdirectory structure per group:
- `messages/` — send a chat message to a JID
- `tasks/` — schedule/pause/resume/cancel/update tasks, refresh groups, register groups
- `emails/` — send email via iCloud SMTP (with optional file attachments)
- `input/` — piped follow-up messages from host to active container stdin

IPC task types: `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `refresh_groups`, `register_group`

Authorization: non-main groups can only message their own JID, schedule tasks for themselves, and cannot register new groups.

## Model Routing
Priority order in `src/model-router.ts`:
1. `ds` or `deepseek` prefix → DeepSeek (Anthropic-compatible external API)
2. `claude` or `andy` keyword → Claude (force container agent)
3. `vault` or `ollama` keyword → Ollama (local model, no container overhead)
4. Default → Claude container agent

## Scheduled Tasks
`src/task-scheduler.ts` polls every 60s for due tasks. Task types: `cron`, `interval`, `once`. Drift-free interval scheduling (anchors to scheduled time, not `Date.now()`).

## Security Model
- Containers run as host user UID/GID (non-root)
- Main containers start as root, drop to host UID via `setpriv` after mounting .env shadow
- API keys never in containers — all AI calls through credential proxy (port 3001)
- Sender allowlist: `~/.config/nanoclaw/sender-allowlist.json`
- Mount allowlist: `~/.config/nanoclaw/mount-allowlist.json`
- IPC authorization: source group identity from directory path (not from payload)
- Defense in depth: `isMain` flag cannot be set via IPC payload

## State Persistence
- SQLite at `data/nanoclaw.db`: messages, chats, registered_groups, sessions, scheduled_tasks, task_run_logs, router_state
- `lastAgentTimestamp` cursor per group persisted in DB — rolled back on agent error (before output sent)
- Session IDs per group-folder stored in DB for conversation continuity
- Agent CLAUDE.md copied from template at group registration (groups/main/CLAUDE.md or groups/global/CLAUDE.md)

## Container Agent Runner
- Source: `container/agent-runner/src/`
- Per-group copy lives at `data/sessions/{groupFolder}/agent-runner-src/` (customizable per group)
- Recompiled on container startup via `entrypoint.sh`
- IPC MCP bridge: exposes host IPC commands as MCP tools to the Claude agent

## Container Skills (runtime, loaded into agent .claude/skills/)
| Skill | Purpose |
|-------|---------|
| `agent-browser` | Browser automation (Chromium via Playwright) |
| `slack-formatting` | Slack message formatting helpers |
| `capabilities` | Agent self-description of available features |
| `status` | Status reporting tool |

## Last Updated
2026-04-06
