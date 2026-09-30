import type { ErrorClass, JobKind } from './schemas.ts';

// 作业失败的对用户文案（DESIGN §14 v0.74）：助手回执与失败 toast 共用。开头按作业种类说什么失败了，
// 原因按失败类别说为什么，最后给下一步。供应商原始报文与英文内部原因不进文案，留在作业 output.message
const WHAT: Record<JobKind, string> = {
  generate: '造屏失败', edit_screens: '改屏失败', edit_component: '改组件失败', regenerate_subtree: '重做这一块失败', apply_design_system: '回刷失败',
  propose_design_system: '提炼约定失败', export_prototype: '导出失败', ingest_screen: '写入失败', chat: '回答失败',
};
// 流水线里的英文内部原因（pipeline.ts 的 JobFailure）
const KNOWN: [RegExp, string][] = [
  [/^revision conflict$/, '这一屏在作业跑的时候被改过'],
  [/^component not found$/, '这个组件已被删除'],
  [/^element not found$/, '要重做的元素已不在这一屏里'],
  [/^replacement produced no element$/, '模型没有给出替换的元素'],
  [/^route already exists$/, '这个路由已经有屏了'],
  [/^route space exhausted$/, '没有可用的新路由了'],
  [/^variantOf must be a default screen/, '变体只能给还在的默认屏出'],
  [/^project has no screens to export$/, '项目里还没有屏'],
  [/^screen html too large/, '生成的屏超过大小上限'],
];
const CJK = /[\u3400-\u9fff]/;
const RETRY = '稍后点「重试」，或在输入框换一个通道再发';

export function failureText(kind: JobKind | null | undefined, errorClass?: ErrorClass | string | null, message?: string | null, kept = 0): string {
  const msg = (message ?? '').trim();
  const known = KNOWN.find(([re]) => re.test(msg))?.[1];
  let why = ''; let next = '点「重试」再来一次';
  if (errorClass === 'provider') {
    const status = Number(msg.match(/\b([45]\d\d)\b/)?.[1] ?? 0);
    next = RETRY;
    if (status === 401 || status === 403) { why = `通道的 Key 被拒绝（HTTP ${status}）`; next = '到「设置 → 生成通道」检查这条通道的 Key，或换一个通道再发'; }
    else if (status === 429) why = '通道限流（HTTP 429）';
    else if (status >= 500) why = `模型服务暂时不可用（HTTP ${status}）`;
    else if (status >= 400) { why = `通道拒绝了这次请求（HTTP ${status}）`; next = '换一个通道再发；到「设置 → 生成通道」重新验证这条通道可以看到具体原因'; }
    else why = CJK.test(msg) ? msg : '连不上模型通道或它没有回应';
  } else if (errorClass === 'timeout') {
    why = '超过时限没做完';
    if (kind === 'generate' || kind === 'edit_screens') next = '点「重试」；屏数或版数多时先减少再发';
  } else if (errorClass === 'agent') {
    why = CJK.test(msg) ? msg : '本机会话没有完成';
    next = '在本机 agent 面板看详情，或换一个模型通道再发';
  } else if (errorClass) {
    why = known ?? (CJK.test(msg) ? msg : errorClass === 'system' ? 'Quilt 内部出错' : '模型产出不合格');
    next = errorClass === 'system' ? '点「重试」；反复出现时看 API 日志' : '点「重试」，或换个说法再发';
  }
  const keptNote = kept > 0 ? `，已保留 ${kept} 屏` : '';
  return `${kind ? WHAT[kind] : '作业失败'}${why ? `：${why.replace(/[。．.]$/, '')}` : ''}${keptNote}。${next}`;
}
