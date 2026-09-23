import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { UserRow } from '../services/user.ts';
import { makeCtx } from './ctx.ts';
import { registerProjectTools } from './tools/projects.ts';
import { registerScreenTools } from './tools/screens.ts';
import { registerRevisionTools } from './tools/revisions.ts';
import { registerJobTools } from './tools/jobs.ts';
import { registerDesignTools } from './tools/design.ts';
import { registerComponentTools } from './tools/components.ts';
import { registerAssetTools } from './tools/assets.ts';
import { registerAnnotationTools } from './tools/annotations.ts';
import { registerResources } from './resources.ts';

// MCP server（API-AGENT-002）：每请求无状态构建；工具 / 资源 / 提示词都是 REST 服务层的投影，按域分文件放在 tools/。
// v0.32 本地版免鉴权：调用方就是本机用户，没有 scope 区分。
export function buildMcpServer(user: UserRow): McpServer {
  const server = new McpServer({ name: 'quilt', version: '0.1.0' }, { instructions: 'Quilt is an infinite-canvas AI design tool. Use quilt.get_design_contract before writing HTML yourself; quilt.validate_screen reports deviations from it without saving (advisory — a write is never rejected for them); push with quilt.create_screen / quilt.update_screen. Long-running generation tools return a job — poll quilt.get_job. When the Quilt canvas delivered a job to this session, pass that jobId on every create/update call and close it with quilt.finish_job when done. Everything the canvas can do has a tool here: revisions (get_revision / restore_revision / adopt_candidate), placement (move_screens), assets, design presets, export, job management (list_jobs / cancel_job / get_job_events), annotations and zero-token element edits (edit_element). Keep each call small: change part of a screen with quilt.patch_screen (find/replace) instead of resending it, and write a screen larger than ~8 KB as quilt.create_upload_url + several quilt.append_upload chunks, then pass uploadId — one long tool argument can break your streamed response.' });
  const ctx = makeCtx(server, user);
  registerProjectTools(ctx);
  registerScreenTools(ctx);
  registerRevisionTools(ctx);
  registerJobTools(ctx);
  registerDesignTools(ctx);
  registerComponentTools(ctx);
  registerAssetTools(ctx);
  registerAnnotationTools(ctx);
  registerResources(ctx);
  return server;
}
