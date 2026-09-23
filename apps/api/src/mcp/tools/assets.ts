import { z } from 'zod';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Problem, problems } from '../../lib/errors.ts';
import { listAssets, createAsset, deleteAsset } from '../../services/assets.ts';
import type { ToolCtx } from '../ctx.ts';

// 素材（API-CORE-032）：create 读服务端本机文件——MCP 与 Quilt 同机是本地版前提（ADR-016）；不走 multipart 也不收 base64
export function registerAssetTools(c: ToolCtx) {
  const { server, user, wrap, read, write } = c;

  server.registerTool('quilt.list_assets', {
    description: 'Project assets (logos, illustrations) with their stable preview-origin URLs — the same list as assets[] in the design contract.',
    inputSchema: { projectId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    return { items: await listAssets(user.id, a.projectId as string) };
  }));

  server.registerTool('quilt.create_asset', {
    description: 'Upload a project asset from a file on this machine (Quilt runs locally, so the absolute path is read server-side): svg | png | jpeg | webp by content, ≤ 5 MB, ≤ 50 per project. Returns the asset with the URL to use in screens.',
    inputSchema: { projectId: z.string().uuid(), path: z.string().min(1).max(4096), name: z.string().trim().min(1).max(80).optional() },
  }, wrap(async (a) => {
    write();
    const p = a.path as string;
    if (!path.isAbsolute(p)) throw problems.validation([{ path: 'path', message: 'path must be absolute' }]);
    let body: Buffer;
    try { body = await readFile(p); }
    catch { throw new Problem(404, '/errors/not-found', `file not found: ${p}`); }
    return { asset: await createAsset(user.id, a.projectId as string, { name: (a.name as string | undefined) ?? path.basename(p), body }) };
  }));

  server.registerTool('quilt.delete_asset', {
    description: 'Delete a project asset. Revisions that already reference its URL will show a broken image.',
    inputSchema: { assetId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    await deleteAsset(user.id, a.assetId as string);
    return { assetId: a.assetId, deleted: true };
  }));
}
