# NanoClaw Testing Strategy

## Framework
- **Vitest** v4 — all tests
- **@vitest/coverage-v8** — coverage reporting
- Config: `vitest.config.ts` — includes `src/**/*.test.ts` and `setup/**/*.test.ts`
- Test files are colocated with source (`foo.ts` + `foo.test.ts` in same directory)

## Running Tests

```bash
# Single pass (used in CI)
npm test

# Watch mode (development)
npm run test:watch

# With coverage (not a defined script — run directly)
npx vitest run --coverage
```

## Typecheck (separate from tests)
```bash
npm run typecheck   # tsc --noEmit
```

## Current Test Files

| Test File | What It Covers |
|-----------|---------------|
| `src/container-runner.test.ts` | Container spawn logic, volume mount building, output marker parsing |
| `src/container-runtime.test.ts` | Apple Container vs Docker detection, host gateway resolution |
| `src/credential-proxy.test.ts` | Credential proxy routing, API key vs OAuth mode, CalDAV proxy |
| `src/db-migration.test.ts` | SQLite schema migration |
| `src/db.test.ts` | All SQLite operations (messages, groups, sessions, tasks, chats) |
| `src/deepseek-runner.test.ts` | DeepSeek API runner |
| `src/formatting.test.ts` | Message formatting and XML escaping |
| `src/group-folder.test.ts` | Path resolution, folder name validation |
| `src/group-queue.test.ts` | Per-group serialized processing, retry/backoff |
| `src/ipc-auth.test.ts` | IPC authorization (cross-group attempt blocking) |
| `src/ipc-email.test.ts` | Email IPC: send_email command, attachment resolution |
| `src/model-router.test.ts` | Model routing (Claude/DeepSeek/Ollama keyword matching) |
| `src/ollama-gate.test.ts` | Ollama availability gating |
| `src/ollama-runner.test.ts` | Ollama runner |
| `src/remote-control.test.ts` | Remote control session management |
| `src/routing.test.ts` | Channel routing (findChannel, routeOutbound) |
| `src/sender-allowlist.test.ts` | Sender allowlist matching and drop mode |
| `src/task-scheduler.test.ts` | Cron/interval/once scheduling, drift-free nextRun |
| `src/timezone.test.ts` | Timezone validation, local time formatting |
| `src/channels/registry.test.ts` | Channel self-registration pattern |
| `src/channels/telegram-files.test.ts` | Telegram file handling |

## Test Patterns

### Mocking
- Use `vi.mock()` for external dependencies (fs, DB, child_process)
- Mock `db.ts` functions rather than using a real database
- Use `vi.fn()` for callbacks and event emitters

### File System Mocks
```typescript
import { vi } from 'vitest';
vi.mock('fs');
// or
vi.mock('../db.js', () => ({ storeMessage: vi.fn(), ... }));
```

### ESM Import Extension
All imports in test files use `.js` extension:
```typescript
import { routeMessage } from '../model-router.js';
import { processTaskIpc } from '../ipc.js';
```

### Test Structure
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('ModuleName', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does the thing', () => {
    expect(fn(input)).toBe(expected);
  });
});
```

### Internal State Resets
Some modules expose `_reset*` functions for test isolation:
```typescript
import { _resetIpcWatcher } from '../ipc.js';
beforeEach(() => _resetIpcWatcher());
```

## What Is NOT Tested (Manual Only)
- Container image build (`./container/build.sh`)
- Live channel connections (require real credentials/auth)
- End-to-end message flow through real chat apps
- Container entrypoint execution

## CI Pipeline
- File: `.github/workflows/ci.yml`
- Runs on PRs: `npm test`, `npm run typecheck`, `npm run format:check`
- No coverage threshold enforced in CI (run coverage locally as needed)

## Last Updated
2026-04-06
