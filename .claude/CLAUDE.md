# Model Routing

NanoClaw routes messages between Gemini (default), Claude containers, DeepSeek, and a local Ollama model.
The routing logic lives in `src/model-router.ts` and runs in the host process before any container is spawned.

## Default: Gemini 2.5 Flash

All messages go to Gemini by default. Gemini has read/write access to `.md` files in the group folder, so it can save notes, tasks, and memory between conversations.

## Triggers — all prefix-only

A trigger only fires when the keyword is the **first word** of the message (case-insensitive, leading whitespace tolerated). Mid-sentence mentions stay on the default Gemini path.

| Backend | Triggers | Example |
|---------|----------|---------|
| **Claude container** (Sonnet, full tools) | `claude`, `andy`, `/council` | "andy, help me debug this" |
| **DeepSeek** | `ds`, `deepseek` | "ds write a sorting algorithm" |
| **Ollama** (local Pi) | `vault`, `ollama` | "vault, what's 2+2?" |
| **Gemini** (explicit, same as default) | `gem`, `gemini` | "gem summarize this" |

What this means in practice:
- ✓ `andy, read me on Tejas` → Claude
- ✗ `what did andy say yesterday` → **Gemini** (no longer false-positives to Claude)
- ✗ `compare claude.ai vs gemini` → **Gemini**
- ✗ `let's use ollama locally` → **Gemini**

Note: `/wiki ingest` and `/wiki lint` run on Gemini (has bash tool). Only force Claude with `andy /wiki ingest` if Gemini fails.

## Configuration (.env)

```
GEMINI_API_KEY=                  # Google AI Studio API key (required for default path)
GEMINI_MODEL=gemini-2.5-flash    # Model name
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai  # OpenAI-compat endpoint

OLLAMA_HOST=http://localhost:11434   # Ollama API base URL
OLLAMA_MODEL=anton-vault             # Local model name
```

NanoClaw routes Claude container traffic directly to `https://api.anthropic.com` using `ANTHROPIC_AUTH_TOKEN` (pay-per-token API billing, separate from any claude.ai subscription).

## Key Files

| File | Purpose |
|------|---------|
| `src/model-router.ts` | Routing decision logic |
| `src/gemini-runner.ts` | Gemini API caller (OpenAI-compatible, read/write .md tools) |
| `src/ollama-runner.ts` | Direct Ollama HTTP caller (bypasses proxy) |
| `src/deepseek-runner.ts` | DeepSeek API caller (Anthropic-compatible) |
| `src/config.ts` | `GEMINI_*`, `OLLAMA_HOST`, `DEEPSEEK_*` constants |
