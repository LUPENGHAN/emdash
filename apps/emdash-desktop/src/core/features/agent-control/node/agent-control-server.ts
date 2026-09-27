import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { UsageLimits } from '@core/features/model-providers/api';
import type { AgentCaller, AgentControlAction, AgentControlResult } from '../api';
import { mcpPath, verifyMcpPath } from './caller-tokens';
import { registerAgentControlTools } from './mcp-tools';

/** Tried first so agents' URLs survive restarts; any free port if it is taken. */
export const DEFAULT_AGENT_CONTROL_PORT = 47_821;

export type AgentControlServerDeps = {
  secret: Buffer;
  version: string;
  resolveCaller: (conversationId: string) => Promise<AgentCaller | null>;
  dispatch: (caller: AgentCaller, action: AgentControlAction) => Promise<AgentControlResult>;
  usageLimits: () => Promise<UsageLimits>;
  preferredPort?: number;
};

export type AgentControlServer = {
  readonly port: number;
  /** The MCP URL for one conversation's agent. */
  urlFor(conversationId: string): string;
  close(): Promise<void>;
};

/**
 * The "emdash" MCP server (streamable HTTP, stateless) on loopback. Each request is
 * authenticated by its signed per-conversation path and gets a server bound to that
 * conversation; the Host check blocks DNS-rebinding pages in local browsers.
 */
export async function startAgentControlServer(
  deps: AgentControlServerDeps
): Promise<AgentControlServer> {
  const http: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  let port = 0;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const conversationId = verifyMcpPath(deps.secret, url.pathname);
    if (!conversationId) {
      response.writeHead(404).end();
      return;
    }
    const caller = await deps.resolveCaller(conversationId);
    if (!caller) {
      response.writeHead(410).end('This conversation no longer exists');
      return;
    }

    const server = new McpServer({ name: 'emdash', version: deps.version });
    registerAgentControlTools(server, {
      caller,
      dispatch: (action) => deps.dispatch(caller, action),
      usageLimits: deps.usageLimits,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  };

  const listen = (wanted: number) =>
    new Promise<number>((resolve, reject) => {
      http.once('error', reject);
      http.listen(wanted, '127.0.0.1', () => {
        http.off('error', reject);
        resolve((http.address() as AddressInfo).port);
      });
    });
  try {
    port = await listen(deps.preferredPort ?? DEFAULT_AGENT_CONTROL_PORT);
  } catch {
    port = await listen(0);
  }

  return {
    get port() {
      return port;
    },
    urlFor: (conversationId) => `http://127.0.0.1:${port}${mcpPath(deps.secret, conversationId)}`,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
