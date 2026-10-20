export const DEVICE_TYPES = ['mobile', 'desktop'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

// 呈现方式（v0.63 REQ-PROTO-005）：push 整屏换 / overlay 压在当前屏上（弹层、底部抽屉）；是屏的元数据，不进修订
export const PRESENTATIONS = ['push', 'overlay'] as const;
export type Presentation = (typeof PRESENTATIONS)[number];

export const DEVICE_SIZE: Record<DeviceType, { w: number; h: number }> = {
  mobile: { w: 390, h: 844 },
  desktop: { w: 1280, h: 800 },
};

// 草稿的截图与看板尺寸（REQ-CORE-040）：mobile / desktop 用对应视口拍首屏；component 在桌面视口里只拍根元素的框（rootOnly）。
// 非草稿（普通项目的屏）照旧按项目的设备形态
// 组件画框的草稿四周那圈透明边（px）：预览文档的 body 内边距、截图的裁剪外扩、看板 iframe 的视口外扩用同一个数（prelude.ts withDraftComponentStyle）
export const DRAFT_PAD = 64;
export type ShotSpec = { size: { w: number; h: number }; rootOnly: boolean };
export function shotSpecFor(project: { kind: string; deviceType: string }, screen: { frame: string | null }): ShotSpec {
  if (project.kind === 'sketchbook') {
    if (screen.frame === 'mobile' || screen.frame === 'desktop') return { size: DEVICE_SIZE[screen.frame], rootOnly: false };
    return { size: DEVICE_SIZE.desktop, rootOnly: true };
  }
  return { size: DEVICE_SIZE[(project.deviceType === 'desktop' ? 'desktop' : 'mobile')], rootOnly: false };
}

// 模型在草稿根元素上声明的画框（frame=auto 时，API-CORE-010 草稿本规则）：只看草稿根的开始标签；缺失或取值不认识返回 null，由调用方按 component 处理。
// 草稿根 = body 里第一个不是 script / style / link / meta / template / noscript 的元素——提示词允许字体样式表与 <style>，模型会把它们放在根前面；
// 与截图、测量用的 DRAFT_ROOT_JS（apps/api/src/lib/screenshot.ts）同一个取法，两处要一起改
const LEADING_NON_ROOT = /^\s*(?:<!--[\s\S]*?-->|<(?:link|meta)\b[^>]*>|<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>)/i;
export function frameFromBody(body: string): 'component' | 'mobile' | 'desktop' | null {
  let rest = body;
  for (let m = LEADING_NON_ROOT.exec(rest); m; m = LEADING_NON_ROOT.exec(rest)) rest = rest.slice(m[0].length);
  const open = rest.trimStart().match(/^<[a-zA-Z][^>]*>/)?.[0] ?? '';
  const m = open.match(/\sdata-frame\s*=\s*["']?(component|mobile|desktop)["'\s>]/);
  return (m?.[1] as 'component' | 'mobile' | 'desktop' | undefined) ?? null;
}
