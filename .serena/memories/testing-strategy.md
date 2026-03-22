# NanoClaw Testing Strategy

## Framework
- **Vitest** v4 for all tests
- **No separate test directory** — test files colocated with source (`foo.test.ts` next to `foo.ts`)
- Coverage via `@vitest/coverage-v8`

## Running Tests
```bash
npm test           # vitest run (single pass)
npm run test:watch # vitest (watch mode)
```

## What's Tested

### Unit Tests (colocated)
- `src/container-runner.test.ts` — container spawn logic, output parsing
- `src/container-runtime.test.ts` — Docker vs Apple Container detection
- `src/credential-proxy.test.ts` — proxy request routing, security
- `src/db.test.ts` — SQLite operations
- `src/group-folder.test.ts` — path resolution and validation
- `src/group-queue.test.ts` — serialized group processing logic
- `src/ipc-auth.test.ts` — IPC authentication
- `src/remote-control.test.ts` — remote control session management
- `src/routing.test.ts` — channel routing (findChannel, formatMessages)
- `src/sender-allowlist.test.ts` — allowlist matching logic
- `src/task-scheduler.test.ts` — cron/interval/once scheduling
- `src/timezone.test.ts` — timezone utilities
- `src/channels/registry.test.ts` — channel self-registration
- `src/channels/telegram.test.ts` — Telegram channel behavior

### Not Tested
- Container image build (manual via `./container/build.sh`)
- Live channel connections (require real credentials)
- End-to-end message flow (manual testing via chat)

## Test Patterns
- Tests use `vi.mock()` for external dependencies (fs, DB)
- No real DB connections in unit tests — mock `db.ts` functions
- Test files import from `.js` extensions (ESM requirement)
- Prefer `it()` over `test()` for readability
- Group related tests with `describe()` blocks

## CI
- GitHub Actions: `.github/workflows/ci.yml`
- Runs `npm test` and `npm run typecheck` on PRs
- Format check: `npm run format:check`
