# Model Routing

NanoClaw routes messages between Gemini (default), Claude containers, DeepSeek, and a local Ollama model.
The routing logic lives in `src/model-router.ts` and runs in the host process before any container is spawned.

## Default: Gemini 2.5 Flash

All messages go to Gemini by default. Gemini has read/write access to `.md` files in the group folder, so it can save notes, tasks, and memory between conversations.

## Force-Claude Container Triggers

| Trigger | Example |
|---------|---------|
| `claude` | "claude, write me a script" |
| `andy` | "andy, help me debug this" |

Spawns the full Claude Code CLI container with MCP tools, file system access, and session continuity. Use for complex agentic tasks.

## Force-DeepSeek Triggers

| Trigger | Example |
|---------|---------|
| `ds` (message prefix) | "ds write a sorting algorithm" |
| `deepseek` (message prefix) | "deepseek solve this equation" |

## Force-Gemini Triggers (explicit opt-in, same as default)

| Trigger | Example |
|---------|---------|
| `gem` (message prefix) | "gem summarize this" |
| `gemini` (message prefix) | "gemini explain this" |

## Force-Local Triggers (Ollama)

| Trigger | Example |
|---------|---------|
| `vault` | "vault, what's 2+2?" |
| `ollama` | "ollama, quick question" |

## Configuration (.env)

```
GEMINI_API_KEY=                  # Google AI Studio API key (required for default path)
GEMINI_MODEL=gemini-2.5-flash    # Model name
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai  # OpenAI-compat endpoint

OLLAMA_HOST=http://localhost:11434   # Ollama API base URL
OLLAMA_MODEL=anton-vault             # Local model name
```

The credential proxy (port 3001) routes Claude containers to `https://api.anthropic.com` using `CLAUDE_CODE_OAUTH_TOKEN`.

## Key Files

| File | Purpose |
|------|---------|
| `src/model-router.ts` | Routing decision logic |
| `src/gemini-runner.ts` | Gemini API caller (OpenAI-compatible, read/write .md tools) |
| `src/ollama-runner.ts` | Direct Ollama HTTP caller (bypasses proxy) |
| `src/deepseek-runner.ts` | DeepSeek API caller (Anthropic-compatible) |
| `src/config.ts` | `GEMINI_*`, `OLLAMA_HOST`, `DEEPSEEK_*` constants |
