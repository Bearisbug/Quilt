import type { ErrorClass, JobKind } from './schemas.ts';
import { L, type Locale, type Localized } from './i18n.ts';

// 作业失败的对用户文案（DESIGN §14 v0.74）：失败的作业 chip 上写它（v1.17 起作业失败不再弹提示条）。开头按作业种类说什么失败了，
// 原因按失败类别说为什么，最后给下一步。供应商原始报文与英文内部原因不进文案，留在作业 output.message。
// 中英两版逐句对应（REQ-CORE-046），英文版的下一步在拼句时补首字母大写
const WHAT: Record<JobKind, Localized> = {
  generate: L('造屏失败', 'Generation failed'), edit_screens: L('改屏失败', 'Edit failed'), edit_component: L('改组件失败', 'Component edit failed'),
  regenerate_subtree: L('重做这一块失败', 'Regenerating this block failed'), apply_design_system: L('回刷失败', 'Re-apply failed'),
  propose_design_system: L('提炼约定失败', 'Distilling conventions failed'), export_prototype: L('导出失败', 'Export failed'),
  ingest_screen: L('写入失败', 'Write failed'), chat: L('回答失败', 'Reply failed'),
};
// 流水线里的英文内部原因（pipeline.ts 的 JobFailure）
const KNOWN: [RegExp, Localized][] = [
  [/^revision conflict$/, L('这一屏在作业跑的时候被改过', 'this screen was changed while the job was running')],
  [/^component not found$/, L('这个组件已被删除', 'this component was deleted')],
  [/^element not found$/, L('要重做的元素已不在这一屏里', 'the element to regenerate is no longer on this screen')],
  [/^replacement produced no element$/, L('模型没有给出替换的元素', 'the model did not return a replacement element')],
  [/^route already exists$/, L('这个路由已经有屏了', 'this route already has a screen')],
  [/^route space exhausted$/, L('没有可用的新路由了', 'no new routes are left')],
  [/^variantOf must be a default screen/, L('变体只能给还在的默认屏出', 'variants can only be made from a default screen that still exists')],
  [/^project has no screens to export$/, L('项目里还没有屏', 'the project has no screens yet')],
  [/^screen html too large/, L('生成的屏超过大小上限', 'the generated screen is over the size limit')],
];
const CJK = /[\u3400-\u9fff]/;
// 中文原因的英文（英文界面用）：中文版把中文原因原样写进文案，英文版按这张表换；表里没有的退回按失败类别的通用原因，
// 不把中文夹进英文句子。流水线、本机投递、通道解析里新加中文原因时在这里补一行。
// 作业 output.message 是落库的原文：v1.24 之前的作业写的是「通道…」，界面改叫「模型」后两种说法都要认
const ZH_REASONS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^组件 HTML 超过 (\d+) KB$/, (m) => `the component HTML is over ${m[1]} KB`],
  [/^组件必须恰好一个根元素，现在有 (\d+) 个$/, (m) => `a component must have exactly one root element; this one has ${m[1]}`],
  [/^组件里不能有 <script> 或 <style>/, 'a component cannot contain <script> or <style>: it is copied into every screen'],
  [/^组件里不能再放别的共享组件$/, 'a component cannot contain another shared component'],
  [/^组件在这一轮里被别处改过/, 'the component was changed elsewhere during this job; send it again'],
  [/^组件已被删除$/, 'the component was deleted'],
  [/^草稿已被删除$/, 'the draft was deleted'],
  [/^目标屏都已被删除$/, 'all target screens were deleted'],
  [/^目标屏有的已被删除，其余还没有生成出内容$/, 'some target screens were deleted and the rest have no content yet'],
  [/^目标屏还没有生成出内容$/, 'the target screens have no content yet'],
  [/^聊天只能用「本机 Claude 订阅」(?:通道|的模型)$/, 'chat only works with a Local Claude subscription model'],
  [/^作业输入不合法/, 'the job input is invalid'],
  [/^Quilt 重启时作业未完成$/, 'the job had not finished when Quilt restarted'],
  [/^(?:通道|模型)不可用：(.*)$/s, (m) => `the model is unavailable${detail(m[1])}`],
  [/^(?:通道|模型)已删除或不属于该账号$/, 'the model was deleted or does not belong to this account'],
  [/^(?:通道|模型)没有密钥$/, 'the model has no key'],
  [/^(?:通道|模型)密钥无法解密/, 'the model key cannot be decrypted because QUILT_SECRETS_KEY changed; enter the key again in Settings'],
  [/^本机没有找到 codex 命令：/, 'the codex command was not found on this machine; install Codex and run codex to log in with your ChatGPT account'],
  [/^本机没有找到 codex 命令$/, 'the codex command was not found on this machine'],
  [/^codex 启动失败/, 'codex failed to start'],
  [/^codex queue 没有确认入队/, 'codex queue did not confirm the message was queued'],
  [/^助手在 (\d+) 轮工具调用内没有收口$/, (m) => `the assistant did not finish within ${m[1]} tool-call turns`],
  [/^会话已关闭或不存在，没有投递出去$/, 'the session is closed or gone, so nothing was delivered'],
  [/^投递失败：(.*)$/s, (m) => `delivery failed${detail(m[1])}`],
  [/^写入会话 inbox 超时$/, 'timed out writing to the session inbox'],
  [/^连不上会话 inbox/, 'could not reach the session inbox'],
  [/^会话报告未完成$/, 'the session reported that it did not finish'],
  [/^没有可用的浏览器做截图/, 'no browser is available for screenshots; install Chrome / Edge, or run npx playwright install chromium'],
  [/^截图超时：/, 'the screenshot timed out'],
  [/^页面未就绪：/, 'the page was not ready: the Tailwind CDN did not take effect or the icon library did not load'],
];
function zhReasonEn(msg: string): string | null {
  for (const [re, en] of ZH_REASONS) {
    const m = msg.match(re);
    if (m) return typeof en === 'string' ? en : en(m);
  }
  return null;
}
// 「模型不可用：…」「投递失败：…」后半句是下层的原因：认得就接上，认不得只说前半句
const detail = (inner: string): string => { const r = CJK.test(inner) ? zhReasonEn(inner.trim()) : null; return r ? `: ${r}` : ''; };
// 下一步：能原样重试的四类（API-CORE-034）写「点「重试」」——失败的作业 chip 上有这个按钮；其余几类没有重试，写它们各自再发一次的入口
const AGAIN: Partial<Record<JobKind, Localized>> = {
  regenerate_subtree: L('在检查器里再点一次「重生成这块」', 'click “Regenerate block” in the Inspector again'),
  apply_design_system: L('到设计系统面板再回刷一次', 're-apply from the design system panel again'),
  propose_design_system: L('到设计系统面板再发一次', 'send it again from the design system panel'),
  export_prototype: L('再点一次工具栏的「导出原型」', 'click “Export prototype” in the toolbar again'),
  ingest_screen: L('让本机会话再写一次', 'have the local session write it again'),
};

// locale：按哪种界面语言写（REQ-CORE-046），缺省中文
export function failureText(kind: JobKind | null | undefined, errorClass?: ErrorClass | string | null, message?: string | null, kept = 0, locale: Locale = 'zh'): string {
  const en = locale === 'en';
  const t = (zh: string, english: string) => (en ? english : zh);
  const msg = (message ?? '').trim();
  const known = KNOWN.find(([re]) => re.test(msg))?.[1][locale];
  // 中文原因：中文版原样用，英文版换成表里的英文，换不了时为 null（退回通用原因）
  const cjk = CJK.test(msg) ? (en ? zhReasonEn(msg) : msg) : null;
  const again = (kind && AGAIN[kind]?.[locale]) || null;
  const retry = again ?? t('点「重试」', 'click “Retry”');
  let why = ''; let next = again ?? t('点「重试」再来一次', 'click “Retry” to try again');
  if (errorClass === 'provider') {
    const status = Number(msg.match(/\b([45]\d\d)\b/)?.[1] ?? 0);
    next = again ? t(`稍后${again}，或换一个模型`, `${again} later, or switch to another model`) : t('稍后点「重试」，或在输入框换一个模型再发', 'click “Retry” later, or pick another model in the composer and send again');
    // 先于状态码判：本机 Claude 订阅的报文是「exceeded the 32000 output token maximum」，上限数字可能恰好是三位数
    if (/output hit the token limit|output token maximum/.test(msg)) {
      why = t('模型这次要写的内容超过了单次输出上限，结果不完整，没有保存', 'the output went over the model’s single-response limit, so the result was incomplete and was not saved');
      next = t('把这次的要求拆成几次发', 'split this request into several smaller ones');
    } else if (status === 401 || status === 403) {
      why = t(`模型的 Key 被拒绝（HTTP ${status}）`, `the model’s key was rejected (HTTP ${status})`);
      next = again
        ? t(`到「设置 → 模型」检查这个模型的 Key 或换一个模型，然后${again}`, `check this model’s key in Settings → Models or switch to another model, then ${again}`)
        : t('到「设置 → 模型」检查这个模型的 Key，或换一个模型再发', 'check this model’s key in Settings → Models, or send again with another model');
    }
    else if (status === 429) why = t('模型限流（HTTP 429）', 'the model is rate limited (HTTP 429)');
    else if (status >= 500) why = t(`模型服务暂时不可用（HTTP ${status}）`, `the model service is temporarily unavailable (HTTP ${status})`);
    else if (status >= 400) {
      why = t(`模型拒绝了这次请求（HTTP ${status}）`, `the model rejected this request (HTTP ${status})`);
      next = t(`${again ? `换一个模型，然后${again}` : '换一个模型再发'}；到「设置 → 模型」重新验证这个模型可以看到具体原因`,
        `${again ? `switch to another model, then ${again}` : 'send again with another model'}; verify this model again in Settings → Models to see the exact reason`);
    }
    else why = cjk ?? t('连不上模型或它没有回应', 'could not reach the model, or it did not respond');
  } else if (errorClass === 'timeout') {
    why = t('超过时限没做完', 'it did not finish within the time limit');
    if (kind === 'generate' || kind === 'edit_screens') next = t('点「重试」；屏数或版数多时先减少再发', 'click “Retry”, or if there were many screens or versions, send again with fewer');
  } else if (errorClass === 'agent') {
    why = cjk ?? t('本机会话没有完成', 'the local session did not finish');
    next = again
      ? t(`在本机 agent 面板看详情，或换成一个模型，然后${again}`, `see the details in the Local agents panel, or switch to a model, then ${again}`)
      : t('在本机 agent 面板看详情，或换成一个模型再发', 'see the details in the Local agents panel, or send again with a model');
  } else if (errorClass) {
    why = known ?? cjk ?? (errorClass === 'system' ? t('Quilt 内部出错', 'Quilt hit an internal error') : t('模型产出不合格', 'the model output did not pass the checks'));
    next = errorClass === 'system' ? t(`${retry}；反复出现时看 API 日志`, `${retry}; if it keeps happening, check the API log`) : again ?? t('点「重试」，或换个说法再发', 'click “Retry”, or rephrase and send again');
  }
  const what = kind ? WHAT[kind][locale] : t('作业失败', 'Job failed');
  const reason = why.replace(/[。．.]$/, '');
  if (!en) return `${what}${reason ? `：${reason}` : ''}${kept > 0 ? `，已保留 ${kept} 屏` : ''}。${next}`;
  const keptNote = kept > 0 ? `; ${kept} ${kept === 1 ? 'screen' : 'screens'} kept` : '';
  return `${what}${reason ? `: ${reason}` : ''}${keptNote}. ${next.charAt(0).toUpperCase()}${next.slice(1)}`;
}
