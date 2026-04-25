# NanoClaw MCP Server

Exposes the NanoClaw workspace (`groups/telegram_main/`) to claude.ai as a remote MCP server, so Claude can read your captures, CRM, wiki, and notes during a chat.

**Read-only.** Write tools intentionally omitted to avoid conflict with NanoClaw's own filing.

## Tools exposed

| Tool | Purpose |
|------|---------|
| `list_files` | Browse directory structure |
| `read_file` | Read a `.md` file (max 200 KB) |
| `search_workspace` | Keyword search across workspace (uses `rg` if installed, else `grep`) |
| `recent_captures` | Last N hours of Telegram messages from `store/messages.db` |

## Setup

### 1. Install deps and build

```bash
cd mcp-server
npm install
npm run build
```

### 2. Set bearer token in `.env` (project root)

```bash
# Generate a strong token
openssl rand -hex 32 >> /tmp/mcp_token

# Add to .env (project root, NOT mcp-server/.env)
echo "MCP_BEARER_TOKEN=$(cat /tmp/mcp_token)" >> ../.env
echo "MCP_PORT=3002" >> ../.env
```

### 3. Run under pm2

```bash
pm2 start dist/index.js --name nanoclaw-mcp --cwd /home/anton/nanoclaw/mcp-server
pm2 save
```

Health check:
```bash
curl -H "Authorization: Bearer $MCP_BEARER_TOKEN" http://localhost:3002/health
# → {"ok":true,"version":"0.1.0"}
```

### 4. Expose via Cloudflare Tunnel

```bash
# Install cloudflared (if not already)
sudo apt install cloudflared

# Auth and create tunnel
cloudflared tunnel login
cloudflared tunnel create nanoclaw-mcp
cloudflared tunnel route dns nanoclaw-mcp nanoclaw-mcp.<your-domain>.dev

# Run as service
cloudflared service install
```

`config.yml` in `~/.cloudflared/`:

```yaml
tunnel: nanoclaw-mcp
credentials-file: /home/anton/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: nanoclaw-mcp.<your-domain>.dev
    service: http://localhost:3002
  - service: http_status:404
```

### 5. Register with claude.ai

claude.ai → Settings → Connectors → Add custom MCP server:

- URL: `https://nanoclaw-mcp.<your-domain>.dev/sse`
- Auth: Bearer token (paste the value from `.env`)

## Path safety

The server only allows reads under these prefixes (in `src/workspace.ts`):

- `notes/`
- `crm/`
- `wiki/`
- `knowledgebase/`
- `journal/`
- `projects/`
- `work/`
- `archives/`
- `CLAUDE.md`

Anything else returns `Error: path not allowed`. No writes, no shell, no network access from the tool side.

## Rotating the bearer token

```bash
# Generate new
openssl rand -hex 32

# Update .env, restart server
sed -i "s/^MCP_BEARER_TOKEN=.*/MCP_BEARER_TOKEN=<new>/" /home/anton/nanoclaw/.env
pm2 restart nanoclaw-mcp

# Update claude.ai connector with the new token
```
