import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Env } from '../app.ts';
import { localUser } from '../../services/user.ts';
import { buildMcpServer } from '../../mcp/server.ts';

export const mcpRoutes = new Hono<Env>();

// API-AGENT-002：MCP Streamable HTTP（无状态：每请求一个 server 实例）。
// v0.32 本地版免鉴权——服务只绑 127.0.0.1，能连上的就是本机用户（ADR-016）。
mcpRoutes.all('/mcp', async (c) => {
  const server = buildMcpServer(await localUser());
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(c.req.raw); }
  finally { setTimeout(() => { transport.close().catch(() => {}); server.close().catch(() => {}); }, 0); }
});
