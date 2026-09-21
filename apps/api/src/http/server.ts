import { serve } from '@hono/node-server';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { createApp } from './app.ts';
import { projectRoutes } from './routes/projects.ts';
import { jobRoutes } from './routes/jobs.ts';
import { screenRoutes } from './routes/screens.ts';
import { miscRoutes } from './routes/misc.ts';
import { agentRoutes } from './routes/agent.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { channelRoutes } from './routes/channels.ts';
import { componentRoutes } from './routes/components.ts';
import { previewApp } from './preview.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

export function buildApiApp() {
  const app = createApp();
  app.route('/', miscRoutes);
  app.route('/', projectRoutes);
  app.route('/', jobRoutes);
  app.route('/', screenRoutes);
  app.route('/', agentRoutes);
  app.route('/', mcpRoutes);
  app.route('/', channelRoutes);
  app.route('/', componentRoutes);
  // 打包运行时（REQ-CORE-017）：静态前端由同一进程托管，未命中的路径回 index.html（SPA）
  if (config.webDist) {
    const root = config.webDist;
    app.get('*', async (c) => {
      const url = new URL(c.req.url);
      if (url.pathname.startsWith('/v1/') || url.pathname === '/mcp') return c.notFound();
      const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(root, rel);
      const inside = file.startsWith(root);
      const isFile = inside && await stat(file).then((s) => s.isFile()).catch(() => false);
      const target = isFile ? file : path.join(root, 'index.html');
      const body = await readFile(target);
      const ext = path.extname(target);
      c.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
      c.header('Cache-Control', isFile && rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      return c.body(new Uint8Array(body));
    });
  }
  return app;
}

export function startHttp() {
  const api = buildApiApp();
  serve({ fetch: api.fetch, port: config.apiPort, hostname: config.bindHost }, (info) => console.log(`[api] http://${config.bindHost}:${info.port}${config.webDist ? ' (serving web)' : ''}`));
  serve({ fetch: previewApp.fetch, port: config.previewPort, hostname: config.bindHost }, (info) => console.log(`[preview] ${config.previewOrigin} (port ${info.port})`));
}
