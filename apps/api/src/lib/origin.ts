import { config } from '../config.ts';

// 来源校验（§15「本地服务」v0.75）：本地版无鉴权，而浏览器会替任意网页往 127.0.0.1 发请求——DNS 重绑后攻击页与 API 同源
// （Host 是攻击者的域名），跨站表单与 no-cors fetch 带着别人的 Origin，预览域与截图里的屏带预览域或 null。
// 名单从画布 / API 地址推出：它们本身，回环地址再展开成三种写法配同一端口。开发时 Vite 代理（changeOrigin:false）送来的
// Host 与 Origin 都是画布地址；打包形态画布与 API 同源；MCP 客户端、curl、脚本不带 Origin。
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export function sourcePolicy(origins: string[]) {
  const hosts = new Set<string>();
  const allowed = new Set<string>();
  for (const o of origins) {
    const u = new URL(o);
    const port = u.port ? `:${u.port}` : '';
    for (const h of LOOPBACK.includes(u.hostname) ? LOOPBACK : [u.hostname]) {
      hosts.add(`${h}${port}`);
      allowed.add(`${u.protocol}//${h}${port}`);
    }
  }
  return {
    hosts: [...hosts],
    origins: [...allowed],
    // Origin 缺省放行；`null` 不在名单里（沙箱 iframe、about:blank 文档、no-referrer 的表单都发它）
    allows: (host: string | undefined, origin: string | undefined) => !!host && hosts.has(host.toLowerCase()) && (origin === undefined || allowed.has(origin)),
  };
}

export const requestSource = sourcePolicy([config.webOrigin, config.apiOrigin, `http://localhost:${config.apiPort}`]);
