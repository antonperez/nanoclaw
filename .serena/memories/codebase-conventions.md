# NanoClaw Codebase Conventions

## Language & Runtime
- TypeScript with strict mode, ESM modules (`"type": "module"`)
- Node.js >= 20
- All imports use `.js` extension (ESM requirement even for `.ts` source files)
- `tsx` for dev, `tsc` for prod build

## File Naming
- `kebab-case.ts` for source files
- Test files colocated: `foo.ts` + `foo.test.ts` in same directory
- Channel skills as separate files: `src/channels/telegram.ts`, `src/channels/whatsapp.ts`

## Code Style
- Prettier for formatting (`prettier --write "src/**/*.ts"`)
- ESLint with `typescript-eslint` and `no-catch-all` plugin
- No bare `catch` blocks — always type or narrow the error
- Husky pre-commit hook enforces format + lint

## Patterns

### Channel Registration
```typescript
// Each channel file self-registers at module load
registerChannel('telegram', (opts) => new TelegramChannel(opts));
// Returns null if credentials missing — silently skipped
```

### Error Handling
- Use `logger.error({ err }, 'message')` for errors (pino structured logging)
- Never swallow errors silently
- Prefer returning `null` or typed result over throwing for recoverable cases

### Database Access
- All DB operations through `src/db.ts` functions — no direct SQL in other modules
- `better-sqlite3` (synchronous API)

### Configuration
- All env-driven config in `src/config.ts`
- Secrets ONLY in credential proxy, never in config or containers
- `.env` file for local dev secrets (gitignored)

### IPC (Agent → Host)
- Agents write JSON commands to `/workspace/ipc/` inside the container
- Host polls IPC dir via `src/ipc.ts` and dispatches to registered handlers
- IPC commands: `register-group`, `send-message`, `schedule-task`, `cancel-task`, etc.

### Container Mounts
- Group folder: `/workspace/group/` (read-write)
- Data/sessions: `/workspace/data/sessions/{groupFolder}` (read-write)
- Credential proxy socket: `/tmp/credential-proxy.sock`
- Additional mounts validated against `~/.config/nanoclaw/mount-allowlist.json`

## Logging
- `pino` logger with `pino-pretty` in dev
- Structured logging: always pass object first `logger.info({ key: value }, 'message')`
- Log levels: `fatal` > `error` > `warn` > `info` > `debug`

## Testing
- Vitest for unit/integration tests
- Test files colocated with source
- Test command: `npm test` (vitest run)

## Key Invariants
- Never pass API keys to containers directly — use credential proxy
- Never store secrets in config exports — only non-secret values
- Always validate mount paths via mount-security before spawning containers
- Main group (`isMain: true`) is the only group with unrestricted trigger access
- Groups track messages via `lastAgentTimestamp` cursor — rollback on agent error
