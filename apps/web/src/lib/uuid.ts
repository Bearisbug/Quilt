// v4 UUID。不用 crypto.randomUUID：它只在安全上下文（HTTPS 与 localhost）里有，从局域网 IP 用 http 打开时没有（§15「局域网访问」v1.30）；
// crypto.getRandomValues 在哪都有
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
