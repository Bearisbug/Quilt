import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { API, assertTestApi } from './lib.ts';

// MCP 客户端（测试与脚本共用）：Streamable HTTP，本地版免鉴权（服务只绑 127.0.0.1）
export async function connectMcp(url = `${API}/mcp`): Promise<Client> {
  // MCP 的写工具能建能改能删屏，和浏览器那条路一样危险，同样先认库（见 lib.ts 的 assertTestApi）
  if (url.startsWith(API)) await assertTestApi();
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'quilt-tests', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; json: unknown; isError: boolean; image?: string }> {
  const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  const image = r.content.find((c) => c.type === 'image')?.data;
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { text, json, isError: !!r.isError, image };
}
