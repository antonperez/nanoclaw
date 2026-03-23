# Hybrid Model Routing

NanoClaw routes messages between a local Ollama model and Claude Pro.
The routing logic lives in `src/model-router.ts` and runs in the host process before any container is spawned.

## Default: Local (anton-vault)

The default backend is **Ollama at `http://localhost:11434`**, model `anton-vault`.

Use local for:
- Normal conversation and general chat
- Simple questions, quick lookups, fast replies
- Private or sensitive activities
- Anything the user explicitly marks as local

## Escalate to Claude Pro

Route to Claude Pro (container agent) when the message requires:
- Complex reasoning or long multi-step chains
- Heavy tool use (web search, code execution, scheduling, email)
- External knowledge or real-time data
- Deep work: code writing, debugging, analysis, refactoring
- Long agents or orchestration tasks

## Force-Local Triggers (keywords in user message)

Any of the following words/phrases in a message force the Ollama path, overriding all other signals:

| Trigger | Example |
|---------|---------|
| `vault` | "vault, what's 2+2?" |
| `use local` | "use local — summarize this" |
| `private` | "private: draft a reply to my boss" |
| `use anton-vault` | "use anton-vault for this" |
| `use ollama` | "use ollama to answer" |
| `use qwen` | "use qwen — quick question" |

## Configuration (.env)

```
OLLAMA_HOST=http://localhost:11434   # Ollama API base URL
OLLAMA_MODEL=anton-vault             # Default local model name
```

The credential proxy (port 3001) routes Claude containers to `https://api.anthropic.com` using `CLAUDE_CODE_OAUTH_TOKEN`.

## Key Files

| File | Purpose |
|------|---------|
| `src/model-router.ts` | Routing decision logic |
| `src/ollama-runner.ts` | Direct Ollama HTTP caller (bypasses proxy) |
| `src/config.ts` | `OLLAMA_HOST`, `OLLAMA_DEFAULT_MODEL` constants |
