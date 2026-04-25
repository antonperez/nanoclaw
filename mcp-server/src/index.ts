/**
 * NanoClaw MCP server — exposes workspace to claude.ai via HTTP+SSE.
 *
 * Run: pm2 start dist/index.js --name nanoclaw-mcp
 * Expose: cloudflared tunnel run nanoclaw-mcp
 *
 * Configuration via env (loaded from project root .env):
 *   MCP_PORT          — listen port (default 3002)
 *   MCP_BEARER_TOKEN  — required; rejects requests without matching Authorization header
 *   NANOCLAW_GROUP_DIR — workspace path (default groups/telegram_main)
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../.env') });

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { NanoClawOAuthProvider } from './oauth.js';
import {
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  searchWorkspace,
  getRecentCaptures,
  queryDb,
} from './workspace.js';

const PORT = parseInt(process.env.MCP_PORT || '3002', 10);
const PUBLIC_URL = process.env.MCP_PUBLIC_URL;

if (!PUBLIC_URL) {
  console.error(
    'FATAL: MCP_PUBLIC_URL not set in .env (e.g. https://nanoclaw-pi.<tail>.ts.net) — refusing to start.',
  );
  process.exit(1);
}

const TOOLS = [
  {
    name: 'list_files',
    description:
      'List files and subdirectories in the NanoClaw workspace. Use to browse before reading.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Relative path inside the workspace (e.g. "crm/contacts" or "notes"). Empty for root.',
        },
      },
    },
  },
  {
    name: 'read_file',
    description:
      'Read a markdown file from the NanoClaw workspace. Path must be relative to workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path (e.g. "crm/contacts/john.md")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_workspace',
    description:
      'Search the NanoClaw workspace for a keyword. Returns paths of matching files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword (case-insensitive)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'recent_captures',
    description:
      'Return recent Telegram messages (last N hours) — Anton\'s captures and assistant replies. Use for "what happened today" or "what did Anton say recently about X".',
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: 'Look back N hours (default 24)',
        },
      },
    },
  },
  {
    name: 'write_file',
    description:
      'Write or append to a file in the NanoClaw workspace (groups/telegram_main only — store/ is read-only). Creates parent directories automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path (e.g. "notes/ideas.md")',
        },
        content: {
          type: 'string',
          description: 'Content to write',
        },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'Write mode: "overwrite" (default) replaces the file, "append" adds to end',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a file or empty directory in the NanoClaw workspace (groups/telegram_main only — store/ is protected). Use with care — no undo.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path to delete (e.g. "notes/draft.md")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'query_db',
    description:
      'Run a read-only SQL SELECT against a NanoClaw SQLite database. Available databases: messages (messages, scheduled_tasks, registered_groups, memory_hot, sessions), store (general), nanoclaw. Returns CSV with header.',
    inputSchema: {
      type: 'object',
      properties: {
        db: {
          type: 'string',
          description: 'Database name without extension: "messages", "store", or "nanoclaw"',
        },
        sql: {
          type: 'string',
          description: 'SELECT statement to run',
        },
      },
      required: ['db', 'sql'],
    },
  },
];

function makeServer() {
  const server = new Server(
    { name: 'nanoclaw', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;
    let text: string;
    switch (name) {
      case 'list_files':
        text = listFiles(String(a.path ?? ''));
        break;
      case 'read_file':
        text = readFile(String(a.path ?? ''));
        break;
      case 'write_file':
        text = writeFile(
          String(a.path ?? ''),
          String(a.content ?? ''),
          (a.mode as 'overwrite' | 'append') ?? 'overwrite',
        );
        break;
      case 'delete_file':
        text = deleteFile(String(a.path ?? ''));
        break;
      case 'search_workspace':
        text = searchWorkspace(String(a.query ?? ''));
        break;
      case 'recent_captures':
        text = getRecentCaptures(Number(a.hours ?? 24));
        break;
      case 'query_db':
        text = queryDb(String(a.db ?? ''), String(a.sql ?? ''));
        break;
      default:
        text = `Error: unknown tool "${name}"`;
    }
    return { content: [{ type: 'text', text }] };
  });

  return server;
}

const app = express();
// Trust the FIRST proxy hop. Assumes topology is exactly:
//   public client → Tailscale Funnel → this server.
// If you put another proxy in front (e.g., Cloudflare in front of Funnel),
// bump this number to match the hop count or X-Forwarded-For becomes spoofable.
// Required for express-rate-limit (used by mcpAuthRouter) to identify clients.
app.set('trust proxy', 1);
app.use(express.json());

// Log every request + response status so we can see what claude.ai is doing
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.url.split('?')[0]} → ${res.statusCode} (${ms}ms, auth=${req.headers.authorization ? 'yes' : 'no'})`,
    );
  });
  next();
});

// Health endpoint is public so we can curl it without auth.
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: '0.1.0',
    transports: ['sse', 'streamable-http'],
    auth: 'oauth2',
  });
});

// === OAuth 2.1 endpoints (claude.ai connector requires this) ===
const oauthProvider = new NanoClawOAuthProvider();
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(PUBLIC_URL),
    resourceName: 'NanoClaw',
  }),
);

// All MCP traffic requires a valid OAuth bearer token from this point on.
const requireAuth = requireBearerAuth({ verifier: oauthProvider });

// === Legacy SSE transport (older MCP clients) ===
const sseTransports = new Map<string, SSEServerTransport>();

app.get('/sse', requireAuth, async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  sseTransports.set(transport.sessionId, transport);
  res.on('close', () => sseTransports.delete(transport.sessionId));
  const server = makeServer();
  await server.connect(transport);
});

app.post('/message', requireAuth, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: 'unknown sessionId' });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// === Streamable HTTP transport (MCP 2025-11-25, what claude.ai web uses) ===
// Stateless mode: each request gets a fresh server instance. Simpler, fine for
// our read-only tool set.
app.post('/mcp', requireAuth, async (req, res) => {
  try {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', requireAuth, (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed; use POST' },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`NanoClaw MCP server listening on :${PORT}`);
});
