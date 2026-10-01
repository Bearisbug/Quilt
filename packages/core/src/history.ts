import { presetNote, variantPrompt, missingPagePrompt, ROUND_PRESETS, ROUND_PRESET_PROMPTS } from './contract.ts';

// 历史指令（ADR-012 v0.87）：改屏 / 局部重生成 / 改组件 / 本机 agent 投递时带进上下文的「此前已生效的用户指令」。
// 这里只管选哪些轮、每轮取哪句、怎么截断、怎么排；查库在 apps/api（services/screens.ts、services/components.ts）。
// 每条是用户当时那句话，从作业输入取——系统代发的描述、模型的改动摘要都不算
export const MAX_PRIOR_INSTRUCTIONS = 18;
export const MAX_PRIOR_INSTRUCTION_CHARS = 500;

export type HistoryJob = { id: string; kind: string; input: unknown };
export type HistoryRevision = { id: string; parentRevisionId: string | null; jobId: string | null };
type Input = { prompt?: string; annotations?: { anchorText?: string; note: string }[]; variantName?: string; route?: string; componentId?: string };

/** 连续空白并成一个空格；超过 500 字（按码点）截成 499 字加「…」 */
function clamp(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > MAX_PRIOR_INSTRUCTION_CHARS ? `${chars.slice(0, MAX_PRIOR_INSTRUCTION_CHARS - 1).join('')}…` : flat;
}

// 一轮作业落到这屏上时，用户当时说的那句话；系统动作、没写附加要求的预设轮次返回 null。
// createdScreen = 这一轮造出了这屏（它的修订是链的根）——generate 顺手改别的屏（入口屏补链）不算这屏的指令
function screenIntent(job: HistoryJob, createdScreen: boolean): string | null {
  const i = (job.input ?? {}) as Input;
  const prompt = i.prompt ?? '';
  switch (job.kind) {
    case 'edit_screens': {
      if (i.annotations?.length) return `批注：${i.annotations.map((a) => (a.anchorText?.trim() ? `「${a.anchorText.trim()}」→ ${a.note}` : a.note)).join('；')}`;
      for (const kind of ROUND_PRESETS) { const note = presetNote(prompt, ROUND_PRESET_PROMPTS[kind]); if (note !== null) return note || null; }
      return prompt || null;
    }
    case 'regenerate_subtree': return prompt ? `局部重生成：${prompt}` : null;
    case 'chat': return prompt || null;
    case 'generate': {
      if (!createdScreen) return null;
      if (i.variantName && prompt === variantPrompt(i.variantName)) return null;
      const note = i.route ? presetNote(prompt, missingPagePrompt(i.route)) : null;
      return (note ?? prompt) || null;
    }
    // apply_design_system / edit_component 的回流 / ingest_screen：系统动作
    default: return null;
  }
}

/** 屏：沿 current 的父修订链走到首版，每个作业只算一次，从新到旧、最多 18 条。回溯掉的分支与未选用的候选不在链上 */
export function screenInstructionHistory(currentRevisionId: string | null, revisions: HistoryRevision[], jobs: HistoryJob[]): string[] {
  const byId = new Map(revisions.map((r) => [r.id, r]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const order: string[] = [];
  const created = new Set<string>();
  for (let cur = currentRevisionId ? byId.get(currentRevisionId) : undefined; cur; cur = cur.parentRevisionId ? byId.get(cur.parentRevisionId) : undefined) {
    if (!cur.jobId) continue; // 元素直改、回溯、组件直改的回流：本身不贡献，链照常往上走
    if (!order.includes(cur.jobId)) order.push(cur.jobId);
    if (!cur.parentRevisionId) created.add(cur.jobId);
  }
  const out: string[] = [];
  for (const id of order) {
    const job = jobById.get(id);
    const text = job ? screenIntent(job, created.has(id)) : null;
    if (text) out.push(clamp(text));
    if (out.length === MAX_PRIOR_INSTRUCTIONS) break;
  }
  return out;
}

/** 组件：没有修订表，取这个组件此前成功的改组件作业，按建作业时间从新到旧、最多 18 条 */
export function componentInstructionHistory(componentId: string, jobs: (HistoryJob & { status: string; createdAt: Date })[]): string[] {
  return jobs
    .filter((j) => j.kind === 'edit_component' && j.status === 'succeeded' && (j.input as Input | null)?.componentId === componentId && (j.input as Input).prompt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MAX_PRIOR_INSTRUCTIONS)
    .map((j) => clamp((j.input as Input).prompt!));
}
