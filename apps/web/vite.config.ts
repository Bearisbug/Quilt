import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 源码按功能域分目录（ui / canvas / composer / panels / project / settings），跨目录一律 @/ 绝对引用
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // 本机 Vite 8 原生文件监听丢事件（M0 实证），开发用轮询
    watch: { usePolling: true, interval: 300 },
    // 同源代理到 API：会话 cookie 无需跨站
    proxy: { '/v1': { target: 'http://localhost:3100', changeOrigin: false } },
  },
});
