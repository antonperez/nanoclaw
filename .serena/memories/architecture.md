# NanoClaw Architecture

## Overview
Single Node.js process (TypeScript/ESM) that bridges messaging channels to Claude AI agents running in isolated containers. Personal assistant platform for Anton.

## Top-Level Structure
```
src/           - Host process source (TypeScript)
container/     - Agent container image + agent-runner code
groups/        - Per-group filesystems (persistent agent memory)
data/          - SQLite DB, session state, IPC files
store/         - WhatsApp credential store (if installed)
.github/       - CI, skill branch automation workflows
```

## Core Data Flow
1. **Channel** (Telegram/WhatsApp/Slack/Discord/Gmail) receives message
2. `src/index.ts` stores message in SQLite via `db.ts`
3. **Message loop** polls every 2s for new messages in registered groups
4. If trigger condition met → `GroupQueue` enqueues work for that group
5. `container-runner.ts` spawns an isolated Linux container (`nanoclaw-agent:latest`)
6. Container mounts group folder, data dir, credential proxy socket
7. Agent runs Claude Code SDK inside container, streams output back
8. Results sent back via channel to the originating chat

## Key Modules

| Module | Responsibility |
|--------|---------------|
| `src/index.ts` | Orchestrator: state management, message loop, agent dispatch |
| `src/channels/registry.ts` | Self-registration pattern for channels at startup |
| `src/channels/telegram.ts` | Telegram channel + bot pool for swarm workers |
| `src/container-runner.ts` | Spawns agent containers, handles streaming output |
| `src/container-runtime.ts` | Detects Docker vs Apple Container, manages container lifecycle |
| `src/ipc.ts` | IPC watcher for agent-to-host commands (register group, send message, schedule task, send email) |
| `src/router.ts` | Message formatting (inbound XML context, outbound text) + channel routing |
| `src/db.ts` | All SQLite operations (messages, groups, sessions, tasks, chats) |
| `src/task-scheduler.ts` | Runs scheduled tasks (cron/interval/once) |
| `src/group-queue.ts` | Per-group serialized processing, stdin pipe management |
| `src/sender-allowlist.ts` | Security: drops messages from denied senders |
| `src/mount-security.ts` | Security: validates container mount paths against allowlist |
| `src/credential-proxy.ts` | Secure API key proxy — containers never hold secrets directly |
| `src/remote-control.ts` | Remote control sessions for main group |
| `src/config.ts` | All env-driven configuration constants |
| `src/env.ts` | Environment variable loading/validation |
| `src/logger.ts` | Pino logger setup |
| `src/timezone.ts` | Timezone utilities |
| `src/types.ts` | Shared TypeScript types |
| `src/group-folder.ts` | Group filesystem path helpers |

## Channel System
Channels self-register via barrel import (`src/channels/index.ts`). Each channel file calls `registerChannel(name, factory)` at module load time. Factory returns `null` when credentials are missing — the channel is skipped silently.

## Container Isolation
- Each group gets an isolated filesystem at `groups/{name}/`
- Containers mount: group folder (read-write), data/sessions (read-write), credential proxy socket
- Additional mounts controlled by `~/.config/nanoclaw/mount-allowlist.json` (outside project, never mounted into containers)
- Container image: `nanoclaw-agent:latest` (built via `./container/build.sh`)

## Container Agent Runner
- Entry point: `container/agent-runner/src/index.ts`
- IPC MCP bridge: `container/agent-runner/src/ipc-mcp-stdio.ts` — exposes host IPC commands as MCP tools to the agent (e.g. `mcp__nanoclaw__send_email`)

## Container Skills (loaded inside agent containers at runtime)
| Skill | Purpose |
|-------|---------|
| `container/skills/agent-browser/` | Browser automation for agents |
| `container/skills/slack-formatting/` | Slack message formatting helpers |
| `container/skills/capabilities/` | Lists agent capabilities (updated when features added) |
| `container/skills/status/` | Status reporting (updated when features added) |

## IPC Commands (Agent → Host)
Agents write JSON commands to `/workspace/ipc/` inside the container. Host polls via `src/ipc.ts`.

| Command | Handler |
|---------|---------|
| `register-group` | Register a new chat group |
| `send-message` | Send a message via a channel |
| `schedule-task` | Schedule a cron/interval/once task |
| `cancel-task` | Cancel a scheduled task |
| `send_email` | Send email via iCloud SMTP (nodemailer, smtp.mail.me.com:587) |

## Security Model
- Containers run as unprivileged user
- API keys never passed to containers — all AI calls go through credential proxy on port 3001
- Sender allowlist controls which users can trigger the assistant
- Mount allowlist controls what host directories containers can access
- Main group has elevated privileges (no trigger required, can register groups, schedule tasks)

## State Persistence
- SQLite at `data/nanoclaw.db`: messages, chats, groups, sessions, tasks, router state
- Per-group CLAUDE.md at `groups/{name}/CLAUDE.md`: agent memory
- Agent session IDs persisted in DB for conversation continuity

## Last Updated
2026-03-23
