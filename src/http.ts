import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { SimpleOAuthProvider } from './oauth.js';
import type { CalDavClient } from './caldav.js';

export type ServerFactory = (dav: CalDavClient) => McpServer;

export interface HttpConfig {
  port: number;
  baseUrl: string;
  adminPassword: string;
}

export function startHttpServer(makeServer: ServerFactory, dav: CalDavClient, config: HttpConfig): void {
  const mcpUrl = new URL('/mcp', config.baseUrl);
  const issuerUrl = new URL(config.baseUrl);

  const provider = new SimpleOAuthProvider(config.adminPassword);

  const app = createMcpExpressApp({ host: '0.0.0.0' });

  // OAuth endpoints: /.well-known/oauth-authorization-server, /authorize, /token, /register, /revoke
  // Also sets up /.well-known/oauth-protected-resource/mcp
  app.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: ['mcp'],
    resourceName: 'Nextcloud MCP',
  }));

  // Login form POST handler (called by the HTML form rendered in provider.authorize)
  app.post('/oauth/login', express.urlencoded({ extended: false }), (req, res) => {
    const loginToken = req.body.login_token as string;
    const password = req.body.password as string;

    if (!provider.validatePassword(password)) {
      res.status(401).type('html').send('<p>Invalid password. <a href="javascript:history.back()">Go back</a></p>');
      return;
    }

    const session = provider.consumeLoginSession(loginToken);
    if (!session) {
      res.status(400).type('html').send('<p>Session expired. Please try again.</p>');
      return;
    }

    const code = provider.createAuthCode(session.client, session.params);

    const redirectUrl = new URL(session.params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (session.params.state) redirectUrl.searchParams.set('state', session.params.state);

    res.redirect(redirectUrl.toString());
  });

  const bearerAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const mcpHandler: express.RequestHandler = async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Unknown session ID' }, id: null });
          return;
        }
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Expected initialize request' }, id: null });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports.set(sid, transport); },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      const server = makeServer(dav);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };

  app.post('/mcp', bearerAuth, express.json(), mcpHandler);
  app.get('/mcp', bearerAuth, mcpHandler);
  app.delete('/mcp', bearerAuth, mcpHandler);

  app.listen(config.port, () => {
    process.stderr.write(`HTTP MCP server listening on port ${config.port}\n`);
  });
}
