import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

// ---- Clients store ----

class ClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return Promise.resolve(this.clients.get(clientId));
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(registered.client_id, registered);
    return Promise.resolve(registered);
  }
}

// ---- Internal state shapes ----

interface LoginSession {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface CodeEntry {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface TokenEntry {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

interface RefreshEntry {
  accessToken: string;
  clientId: string;
  scopes: string[];
}

// ---- Provider ----

export class SimpleOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new ClientsStore();

  private loginSessions = new Map<string, LoginSession>();
  private authCodes = new Map<string, CodeEntry>();
  private tokens = new Map<string, TokenEntry>();
  private refreshTokens = new Map<string, RefreshEntry>();

  constructor(private readonly adminPassword: string) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const loginToken = randomUUID();
    this.loginSessions.set(loginToken, { client, params });
    res.type('html').send(loginPage(loginToken));
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) throw new Error('Invalid authorization code');
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) throw new Error('Invalid authorization code');
    if (entry.client.client_id !== client.client_id) throw new Error('Code not issued to this client');

    this.authCodes.delete(authorizationCode);

    const token = randomUUID();
    const refreshToken = randomUUID();
    const scopes = entry.params.scopes ?? [];

    this.tokens.set(token, { clientId: client.client_id, scopes, expiresAt: Date.now() + 3_600_000 });
    this.refreshTokens.set(refreshToken, { accessToken: token, clientId: client.client_id, scopes });

    return { access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: refreshToken, scope: scopes.join(' ') };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry || entry.clientId !== client.client_id) throw new Error('Invalid refresh token');

    this.tokens.delete(entry.accessToken);
    this.refreshTokens.delete(refreshToken);

    const newToken = randomUUID();
    const newRefreshToken = randomUUID();
    const newScopes = scopes ?? entry.scopes;

    this.tokens.set(newToken, { clientId: client.client_id, scopes: newScopes, expiresAt: Date.now() + 3_600_000 });
    this.refreshTokens.set(newRefreshToken, { accessToken: newToken, clientId: client.client_id, scopes: newScopes });

    return { access_token: newToken, token_type: 'bearer', expires_in: 3600, refresh_token: newRefreshToken, scope: newScopes.join(' ') };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.tokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) throw new Error('Invalid or expired token');
    return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: Math.floor(entry.expiresAt / 1000) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const tokenEntry = this.tokens.get(request.token);
    if (tokenEntry?.clientId === client.client_id) {
      this.tokens.delete(request.token);
    }

    const refreshEntry = this.refreshTokens.get(request.token);
    if (refreshEntry?.clientId === client.client_id) {
      this.tokens.delete(refreshEntry.accessToken);
      this.refreshTokens.delete(request.token);
    }
  }

  // ---- Used by the login route ----

  validatePassword(password: string): boolean {
    return password === this.adminPassword;
  }

  consumeLoginSession(loginToken: string): LoginSession | undefined {
    const session = this.loginSessions.get(loginToken);
    if (session) this.loginSessions.delete(loginToken);
    return session;
  }

  createAuthCode(client: OAuthClientInformationFull, params: AuthorizationParams): string {
    const code = randomUUID();
    this.authCodes.set(code, { client, params });
    return code;
  }
}

// ---- Login page ----

function loginPage(loginToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nextcloud MCP – Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
    .card { background: white; padding: 2rem; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.12); width: 340px; }
    h1 { margin: 0 0 1.5rem; font-size: 1.25rem; color: #111; }
    label { display: block; margin-bottom: .375rem; font-size: .875rem; color: #444; }
    input[type=password] { width: 100%; padding: .5rem .75rem; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; margin-bottom: 1.25rem; }
    input[type=password]:focus { outline: 2px solid #0062cc; border-color: transparent; }
    button { width: 100%; padding: .625rem; background: #0062cc; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; font-weight: 500; }
    button:hover { background: #0053ad; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Nextcloud MCP</h1>
    <form method="post" action="/oauth/login">
      <input type="hidden" name="login_token" value="${loginToken}">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}
