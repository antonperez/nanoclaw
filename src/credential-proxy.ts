/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *             Token is read fresh from ~/.claude/.credentials.json so it
 *             stays valid across automatic refreshes (expires ~8h).
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Proxy a CalDAV or CardDAV request to iCloud, injecting Basic auth.
 * Follows redirects internally (iCloud redirects caldav.icloud.com to
 * per-user servers like p123-caldav.icloud.com). Credentials are never
 * sent to containers.
 */
function proxyDavRequest(
  method: string,
  hostname: string,
  path: string,
  reqHeaders: Record<string, string | number | string[] | undefined>,
  body: Buffer,
  res: ServerResponse,
  maxRedirects = 5,
): void {
  const upstream = httpsRequest(
    {
      hostname,
      port: 443,
      path,
      method,
      headers: reqHeaders,
    } as RequestOptions,
    (upRes) => {
      const status = upRes.statusCode ?? 0;
      // Follow redirects, re-injecting auth on every hop
      if (
        (status === 301 ||
          status === 302 ||
          status === 307 ||
          status === 308) &&
        maxRedirects > 0
      ) {
        const loc = upRes.headers.location;
        upRes.resume(); // discard redirect body
        if (loc) {
          try {
            const target = new URL(loc);
            proxyDavRequest(
              method,
              target.hostname,
              target.pathname + target.search,
              { ...reqHeaders, host: target.hostname },
              body,
              res,
              maxRedirects - 1,
            );
          } catch {
            res.writeHead(status, upRes.headers);
            res.end();
          }
          return;
        }
      }
      res.writeHead(status, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    logger.error({ err, hostname, path }, 'DAV proxy upstream error');
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  upstream.write(body);
  upstream.end();
}

/**
 * Handle a /__dav/ request: determine the iCloud target host/path,
 * inject Basic auth, and proxy the request.
 *
 * URL scheme:
 *   /__dav/caldav/<path>   → https://caldav.icloud.com/<path>
 *   /__dav/carddav/<path>  → https://contacts.icloud.com/<path>
 */
function handleDavRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  url: string,
  basicAuth: string,
): void {
  const isCaldav = url.startsWith('/__dav/caldav');
  const defaultHost = isCaldav ? 'caldav.icloud.com' : 'contacts.icloud.com';
  const prefix = isCaldav ? '/__dav/caldav' : '/__dav/carddav';
  const strippedPath = url.slice(prefix.length) || '/';

  const headers: Record<string, string | number | string[] | undefined> = {
    ...(req.headers as Record<string, string>),
    host: defaultHost,
    authorization: `Basic ${basicAuth}`,
    'content-length': body.length,
  };
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];

  proxyDavRequest(
    req.method ?? 'GET',
    defaultHost,
    strippedPath,
    headers,
    body,
    res,
  );
}

/**
 * Read the current OAuth access token.
 * Priority: CLAUDE_CODE_OAUTH_TOKEN env/envfile → ~/.claude/.credentials.json
 * Cached for 60s to avoid file I/O per request, while still picking up refreshes.
 */
let _oauthTokenCache: { token: string; expiresAt: number } | null = null;

export function readOAuthToken(envFileToken?: string): string | undefined {
  // Explicit env override always wins (no caching needed, it's static)
  if (envFileToken) return envFileToken;

  const now = Date.now();
  if (_oauthTokenCache && now < _oauthTokenCache.expiresAt) {
    return _oauthTokenCache.token;
  }

  // Read from Claude Code's credentials file
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw) as Record<string, unknown>;
    const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
    const token = oauth?.accessToken as string | undefined;
    if (token) {
      _oauthTokenCache = { token, expiresAt: now + 60_000 };
      return token;
    }
  } catch {
    // Credentials file absent or unreadable — fall through
  }

  return undefined;
}

/**
 * Read the OAuth token, refreshing it first if it expires within 15 minutes.
 *
 * Refresh strategy (in order):
 *   1. `claude auth status` — proactively refreshes tokens that are still
 *      valid but near expiry. Fast, no token cost.
 *   2. `claude --print . --max-turns 1` — forces a real API call that
 *      triggers Claude Code's OAuth refresh flow. Used only when the token
 *      is already expired and step 1 had no effect. Costs ~5 Haiku tokens.
 *
 * Called once per container spawn (not per request), so the extra latency
 * is acceptable.
 */
export function ensureFreshOAuthToken(): string | undefined {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const REFRESH_AHEAD_MS = 15 * 60 * 1000; // refresh if < 15 min remaining

  function readFromDisk(): { token?: string; expiresAt?: number } {
    try {
      const raw = fs.readFileSync(credPath, 'utf-8');
      const creds = JSON.parse(raw) as Record<string, unknown>;
      const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
      return {
        token: oauth?.accessToken as string | undefined,
        expiresAt: oauth?.expiresAt as number | undefined,
      };
    } catch {
      return {};
    }
  }

  const { token, expiresAt } = readFromDisk();
  const now = Date.now();

  if (token && expiresAt && expiresAt > now + REFRESH_AHEAD_MS) {
    return token; // Fresh enough — use as-is
  }

  const remainingMin = expiresAt
    ? ((expiresAt - now) / 60_000).toFixed(1)
    : 'unknown';
  logger.info(
    { remainingMin },
    'OAuth token near/past expiry — attempting refresh',
  );

  // Step 1: lightweight refresh (works when token is still valid)
  try {
    execFileSync('claude', ['auth', 'status'], {
      timeout: 30_000,
      stdio: 'ignore',
    });
  } catch { /* ignore */ }

  const after = readFromDisk();
  if (after.token && after.expiresAt && after.expiresAt > now + 60_000) {
    logger.info('OAuth token refreshed via auth status');
    _oauthTokenCache = null; // invalidate proxy cache
    return after.token;
  }

  // Step 2: token still expired — force a real API call to trigger refresh
  logger.warn(
    'auth status did not refresh token — forcing refresh via API call (~5 Haiku tokens)',
  );
  try {
    execFileSync(
      'claude',
      ['--print', '.', '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1'],
      { timeout: 60_000, stdio: 'ignore' },
    );
  } catch { /* ignore */ }

  const final = readFromDisk();
  _oauthTokenCache = null; // invalidate proxy cache regardless
  if (final.token && final.expiresAt && final.expiresAt > now) {
    logger.info(
      { expiresIn: `${((final.expiresAt - now) / 60_000).toFixed(1)}m` },
      'OAuth token refreshed via API call',
    );
  } else {
    logger.error('OAuth token refresh failed — container may fail to authenticate');
  }
  return final.token;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ICLOUD_EMAIL',
    'ICLOUD_APP_PASSWORD',
  ]);

  const icloudEmail = process.env.ICLOUD_EMAIL || secrets.ICLOUD_EMAIL;
  const icloudPass =
    process.env.ICLOUD_APP_PASSWORD || secrets.ICLOUD_APP_PASSWORD;
  const icloudBasicAuth =
    icloudEmail && icloudPass
      ? Buffer.from(`${icloudEmail}:${icloudPass}`).toString('base64')
      : null;

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  // envFileToken is the static override from .env; readOAuthToken() falls back
  // to ~/.claude/.credentials.json per request so tokens auto-refresh.
  const envFileToken = secrets.CLAUDE_CODE_OAUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // iCloud DAV routes: /__dav/caldav/ and /__dav/carddav/
        if (
          req.url?.startsWith('/__dav/caldav') ||
          req.url?.startsWith('/__dav/carddav')
        ) {
          if (!icloudBasicAuth) {
            logger.warn(
              { url: req.url },
              'DAV request received but ICLOUD_EMAIL/ICLOUD_APP_PASSWORD not configured',
            );
            res.writeHead(503);
            res.end('iCloud credentials not configured');
            return;
          }
          handleDavRequest(req, res, body, req.url, icloudBasicAuth);
          return;
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = readOAuthToken(envFileToken);
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
            }
          }
        }

        // 90-second hard timeout on upstream Anthropic API calls.
        // Without this, a hung API connection keeps the process alive
        // indefinitely, preventing Docker from ever restarting it.
        const PROXY_UPSTREAM_TIMEOUT_MS = parseInt(
          process.env.PROXY_UPSTREAM_TIMEOUT_MS || '90000',
          10,
        );

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
            timeout: PROXY_UPSTREAM_TIMEOUT_MS,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('timeout', () => {
          logger.warn(
            { url: req.url, timeoutMs: PROXY_UPSTREAM_TIMEOUT_MS },
            'Credential proxy upstream timeout — aborting request',
          );
          upstream.destroy();
          if (!res.headersSent) {
            res.writeHead(504);
            res.end('Gateway Timeout');
          }
        });

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
