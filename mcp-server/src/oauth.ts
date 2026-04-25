/**
 * Minimal single-user OAuth 2.1 provider for claude.ai's MCP connector.
 *
 * Single-user means: anyone who can reach this endpoint AND knows the
 * pre-shared registration token can complete OAuth. claude.ai's web UI does
 * dynamic client registration → redirects to /authorize → we auto-approve
 * (no human consent UI) → exchanges code for access token.
 *
 * Storage is in-memory: clients, codes, and tokens vanish on restart.
 * That's acceptable for personal use — claude.ai re-auths automatically.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const ACCESS_TOKEN_TTL_SECONDS = 3600 * 24 * 7; // 7 days
const REFRESH_TOKEN_TTL_SECONDS = 3600 * 24 * 30; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 min

// Persist OAuth state to disk so restarts don't invalidate Claude Desktop's
// stored tokens. Without this, every server restart forces re-authentication.
const STATE_PATH =
  process.env.MCP_OAUTH_STATE_PATH || '/mnt/pi/nanoclaw/mcp-oauth-state.json';

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private store: Map<string, OAuthClientInformationFull>,
    private onChange: () => void,
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.store.get(clientId);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    this.store.set(client.client_id, client);
    this.onChange();
    return client;
  }
}

export class NanoClawOAuthProvider implements OAuthServerProvider {
  public clientsStore: InMemoryClientsStore;
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, CodeRecord>(); // codes are short-lived, not persisted
  private accessTokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, TokenRecord>();

  constructor() {
    this.loadFromDisk();
    this.clientsStore = new InMemoryClientsStore(this.clients, () => this.persist());
    // Periodically purge expired auth codes so the in-memory map can't grow
    // unboundedly under brute-force attempts. Codes expire after 5 minutes;
    // sweeping every minute is plenty.
    setInterval(() => {
      const now = Date.now();
      for (const [code, rec] of this.codes) {
        if (rec.expiresAt < now) this.codes.delete(code);
      }
    }, 60_000).unref();
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(STATE_PATH)) return;
      const raw = readFileSync(STATE_PATH, 'utf8');
      const state = JSON.parse(raw) as PersistedState;
      const now = Date.now();
      for (const [id, c] of Object.entries(state.clients ?? {})) this.clients.set(id, c);
      for (const [t, r] of Object.entries(state.accessTokens ?? {})) {
        if (r.expiresAt > now) this.accessTokens.set(t, r);
      }
      for (const [t, r] of Object.entries(state.refreshTokens ?? {})) {
        if (r.expiresAt > now) this.refreshTokens.set(t, r);
      }
      console.log(
        `[oauth] loaded ${this.clients.size} clients, ${this.accessTokens.size} access tokens, ${this.refreshTokens.size} refresh tokens from ${STATE_PATH}`,
      );
    } catch (err) {
      console.warn(`[oauth] failed to load state: ${err instanceof Error ? err.message : err}`);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(STATE_PATH), { recursive: true });
      const state: PersistedState = {
        clients: Object.fromEntries(this.clients),
        accessTokens: Object.fromEntries(this.accessTokens),
        refreshTokens: Object.fromEntries(this.refreshTokens),
      };
      // Write atomically: write to .tmp then rename
      const tmp = `${STATE_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, STATE_PATH);
    } catch (err) {
      console.warn(`[oauth] failed to persist state: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Auto-approve every authorize request (single-user setup, no consent UI).
   * Redirects back to claude.ai with a code.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = newId('code');
    this.codes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const url = new URL(params.redirectUri);
    url.searchParams.set('code', code);
    if (params.state) url.searchParams.set('state', params.state);
    res.redirect(url.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record) throw new Error('invalid_grant');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.expiresAt < Date.now()) throw new Error('invalid_grant');
    if (record.clientId !== client.client_id) throw new Error('invalid_grant');
    this.codes.delete(authorizationCode);

    return this.issueTokens(client.client_id, record.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.expiresAt < Date.now()) throw new Error('invalid_grant');
    if (record.clientId !== client.client_id) throw new Error('invalid_grant');
    this.refreshTokens.delete(refreshToken);
    // issueTokens() will call persist() below

    return this.issueTokens(client.client_id, scopes ?? record.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(token);
    if (!record || record.expiresAt < Date.now()) {
      throw new Error('invalid_token');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
    };
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const accessToken = newId('at');
    const refreshToken = newId('rt');
    const now = Date.now();
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
    });
    this.refreshTokens.set(refreshToken, {
      clientId,
      scopes,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
    });
    this.persist();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }
}
