# Model Routing

NanoClaw routes messages between Claude containers (default), Gemini, DeepSeek, and a local Ollama model.
The routing logic lives in `src/model-router.ts` and runs in the host process before any container is spawned.

## Layer 1 — Backend routing (host process, `src/model-router.ts`)

Prefix triggers fire only when the keyword is the **first word** (case-insensitive). Mid-sentence mentions stay on Claude.

| Prefix | Backend |
|--------|---------|
| `gem`, `gemini` | Gemini 2.5 Flash |
| `ds`, `deepseek` | DeepSeek |
| `vault`, `ollama` | Local Ollama |
| *(anything else)* | Claude container (default) |

## Layer 2 — Claude model routing (inside container, `container/agent-runner/src/query-classifier.ts`)

| Condition | Model | Examples |
|-----------|-------|---------|
| `q:` prefix | Sonnet | `q: is wimbledon on?` |
| `ingest` / `source` anywhere | Sonnet | `source this`, `ingest https://...` |
| `wiki ingest` / `add to wiki` | Sonnet | `/wiki ingest` |
| `/wiki query` / `/wiki lint` / `search the wiki` | Sonnet | `/wiki query transformers` |
| `save this` / `note this` / `remember this` / `add to notes` | Sonnet | `remember this for later` |
| Scheduled / cron task | Sonnet | *(automatic)* |
| *(everything else)* | **Opus 4.8** | open questions, planning, analysis |

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
