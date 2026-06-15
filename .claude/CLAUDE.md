# Model Routing

NanoClaw routes messages between Claude containers (default), Gemini, DeepSeek, and a local Ollama model.
The routing logic lives in `src/model-router.ts` and runs in the host process before any container is spawned.

## Default: Claude Sonnet (container agent)

All messages go to Claude Sonnet by default, via the container agent runner. Uses the Claude Max Agent SDK credit pool ($100/month). No per-token billing.

## Triggers — all prefix-only

A trigger only fires when the keyword is the **first word** of the message (case-insensitive, leading whitespace tolerated). Mid-sentence mentions stay on the default Claude path.

| Backend | Triggers | Example |
|---------|----------|---------|
| **Gemini** (explicit override) | `gem`, `gemini` | "gem summarize this" |
| **DeepSeek** | `ds`, `deepseek` | "ds write a sorting algorithm" |
| **Ollama** (local Pi) | `vault`, `ollama` | "vault, what's 2+2?" |
| **Claude container** (default, no trigger needed) | — | any message |

What this means in practice:
- ✓ Any message → Claude Sonnet (default)
- ✓ `gem summarize this` → Gemini (explicit)
- ✗ `compare claude.ai vs gemini` → **Claude** (no prefix trigger)
- ✗ `let's use ollama locally` → **Claude**

## Configuration (.env)

```
GEMINI_API_KEY=                  # Google AI Studio API key (for explicit gem/gemini prefix)
GEMINI_MODEL=gemini-2.5-flash    # Model name
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai  # OpenAI-compat endpoint

OLLAMA_HOST=http://localhost:11434   # Ollama API base URL
OLLAMA_MODEL=anton-vault             # Local model name
```

Claude container traffic goes through the credential proxy (port 3001) using OAuth via `~/.claude/.credentials.json`.

## Key Files

| File | Purpose |
|------|---------|
| `src/model-router.ts` | Routing decision logic |
| `src/gemini-runner.ts` | Gemini API caller (OpenAI-compatible, read/write .md tools) |
| `src/ollama-runner.ts` | Direct Ollama HTTP caller (bypasses proxy) |
| `src/deepseek-runner.ts` | DeepSeek API caller (Anthropic-compatible) |
| `src/config.ts` | `GEMINI_*`, `OLLAMA_HOST`, `DEEPSEEK_*` constants |
