import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Env } from '../app.ts';
import { localUser } from '../../services/user.ts';
import { buildMcpServer } from '../../mcp/server.ts';
import { requestSource } from '../../lib/origin.ts';

export const mcpRoutes = new Hono<Env>();

// API-AGENT-002：MCP Streamable HTTP（无状态：每请求一个 server 实例）。
// 本地版免鉴权（ADR-016）：服务只绑 127.0.0.1，不校验凭据；来源由 app.ts 按本机名单挡过一道（v0.75），
// SDK 自带的 DNS 重绑防护也开着，名单同一份
mcpRoutes.all('/mcp', async (c) => {
  const server = buildMcpServer(await localUser());
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
    enableDnsRebindingProtection: true, allowedHosts: requestSource.hosts, allowedOrigins: requestSource.origins,
  });
  await server.connect(transport);
  try { return await transport.handleRequest(c.req.raw); }
  finally { setTimeout(() => { transport.close().catch(() => {}); server.close().catch(() => {}); }, 0); }
});
