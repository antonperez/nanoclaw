# Model Routing

NanoClaw routes messages between Claude, DeepSeek, and a local Ollama model.
The routing logic lives in `src/model-router.ts` and runs in the host process before any container is spawned.

## Default: Claude

All messages go to Claude by default. Other backends are opt-in via keywords.

## Force-DeepSeek Triggers

| Trigger | Example |
|---------|---------|
| `ds` (message prefix) | "ds write a sorting algorithm" |
| `deepseek` (message prefix) | "deepseek solve this equation" |

## Force-Claude Triggers

| Trigger | Example |
|---------|---------|
| `claude` | "claude, write me a script" |
| `andy` | "andy, help me debug this" |

## Force-Local Triggers (Ollama)

| Trigger | Example |
|---------|---------|
| `vault` | "vault, what's 2+2?" |
| `ollama` | "ollama, quick question" |

## Configuration (.env)

```
OLLAMA_HOST=http://localhost:11434   # Ollama API base URL
OLLAMA_MODEL=anton-vault             # Local model name
```

The credential proxy (port 3001) routes Claude containers to `https://api.anthropic.com` using `CLAUDE_CODE_OAUTH_TOKEN`.

## Key Files

| File | Purpose |
|------|---------|
| `src/model-router.ts` | Routing decision logic |
| `src/ollama-runner.ts` | Direct Ollama HTTP caller (bypasses proxy) |
| `src/deepseek-runner.ts` | DeepSeek API caller (Anthropic-compatible) |
| `src/config.ts` | `OLLAMA_HOST`, `OLLAMA_DEFAULT_MODEL`, `DEEPSEEK_*` constants |
