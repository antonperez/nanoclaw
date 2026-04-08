# NanoClaw Codebase Conventions

## Language and Runtime
- TypeScript 5.7, strict mode, ESM modules (`"type": "module"` in package.json)
- Node.js >= 20
- All imports use `.js` extension even for `.ts` source files (ESM/NodeNext requirement)
- `tsx` for development, `tsc` for production build to `dist/`
- Target: ES2022, moduleResolution: NodeNext

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | Synchronous SQLite — all DB operations |
| `grammy` | Telegram bot client |
| `nodemailer` | Email sending via iCloud SMTP (smtp.mail.me.com:587) |
| `pino` / `pino-pretty` | Structured JSON logging |
| `zod` | Runtime schema validation |
| `yaml` | YAML config parsing |
| `cron-parser` | Task scheduling with timezone support |

## File Naming
- `kebab-case.ts` for all source files
- Test files colocated with source: `foo.ts` + `foo.test.ts` in same directory
- No separate `test/` directory
- Channel implementations: `src/channels/{channel-name}.ts`

## Code Style Rules
- **Prettier** for formatting: `npm run format` (writes) / `npm run format:check` (CI)
- **ESLint** with `typescript-eslint` + `eslint-plugin-no-catch-all`: `npm run lint`
- **Husky pre-commit hook** enforces format + lint before every commit
- No bare `catch` blocks — always narrow or type the error
- Prefer `catch (err)` with `logger.error({ err }, 'message')` pattern

## NPM Scripts

| Script | Command |
|--------|---------|
| `npm run dev` | `tsx src/index.ts` (hot reload) |
| `npm run build` | `tsc` → compiles to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint src/` |
| `npm run lint:fix` | `eslint src/ --fix` |
| `npm run format` | `prettier --write "src/**/*.ts"` |
| `npm run format:check` | `prettier --check "src/**/*.ts"` |
| `npm test` | `vitest run` (single pass) |
| `npm run test:watch` | `vitest` (watch mode) |

## Patterns

### Channel Registration
Each channel file self-registers at module load time. Returns `null` when credentials are missing — the channel is skipped silently in `index.ts`.
```typescript
// src/channels/mytchannel.ts
import { registerChannel } from './registry.js';
registerChannel('mychannel', (opts) => {
  if (!process.env.MY_TOKEN) return null;
  return new MyChannel(opts);
});
```

### Structured Logging
Always pass the context object first:
```typescript
logger.info({ group: group.name, count: messages.length }, 'Processing messages');
logger.error({ err, chatJid }, 'Error processing IPC message');
logger.warn({ folder: group.folder }, 'Group folder not found');
```
Log levels: `fatal` > `error` > `warn` > `info` > `debug` > `trace`

### Database Access
All DB operations go through named functions in `src/db.ts`. No raw SQL outside that module.
```typescript
// Good
import { storeMessage, getNewMessages } from './db.js';
// Bad — never
import db from './db.js'; db.prepare('SELECT ...').run();
```

### Configuration
- All env-driven constants in `src/config.ts`
- Env file loading via `src/env.ts` (`readEnvFile(['KEY1', 'KEY2'])`)
- Secrets (API keys, tokens) only read by `src/credential-proxy.ts` — never exported from config
- `.env` is gitignored; secrets managed by OneCLI Agent Vault or credential proxy

### IPC Commands (Agent to Host)
Agents write JSON files to `/workspace/ipc/{subdir}/` inside the container:
- `messages/{uuid}.json` — `{ type: 'message', chatJid, text }`
- `tasks/{uuid}.json` — task lifecycle commands
- `emails/{uuid}.json` — `{ type: 'send_email', to, subject, body, attachments? }`

Attachments in emails: array of container paths like `/workspace/group/file.pdf`. Host resolves to `groups/{groupFolder}/file.pdf`.

### Container Volume Mounts
Use `validateAdditionalMounts()` from `src/mount-security.ts` before adding extra mounts. Never accept mount paths from IPC payloads directly.

### Model Routing
Call `routeMessage(lastUserMessageText)` from `src/model-router.ts` after stripping the trigger prefix. Returns `{ model: 'claude' | 'deepseek' | 'ollama', reason: string }`.

### Error Recovery Pattern
For cursor-based message processing — always save the old cursor, roll back on error unless output was already sent:
```typescript
const previousCursor = lastAgentTimestamp[chatJid] || '';
lastAgentTimestamp[chatJid] = newTimestamp;
saveState();
// ... run agent ...
if (hadError && !outputSentToUser) {
  lastAgentTimestamp[chatJid] = previousCursor; // rollback
  saveState();
}
```

### GroupQueue Singleton
One `GroupQueue` instance in `src/index.ts`. Each group processes one container at a time. Messages for an active container are piped via stdin. New containers queue behind the active one.

### Test Exports for Internal State
Functions/vars only needed by tests are exported with underscore prefix and documented:
```typescript
/** @internal - exported for testing */
export function _resetIpcWatcher(): void { ... }
export function _setRegisteredGroups(...): void { ... }
```

## Key Invariants
- Never pass API keys to containers — use credential proxy (port 3001)
- Never store secrets in config exports — only non-secret config values
- Always validate mount paths via `validateAdditionalMounts` before spawning
- Main group (`isMain: true`) is the only group with unrestricted trigger access and cross-group IPC
- `isMain` flag cannot be set via IPC payload (defense in depth)
- Groups track messages via `lastAgentTimestamp` cursor — rollback on agent error before output

## Last Updated
2026-04-06
