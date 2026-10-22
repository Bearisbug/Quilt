// 复制文字。navigator.clipboard 只在安全上下文里有，从局域网 IP 用 http 打开时退回 execCommand（§15「局域网访问」v1.30）；两样都不行时抛错，调用方提示复制失败
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}
