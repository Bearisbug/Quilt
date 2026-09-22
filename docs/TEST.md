# Quilt 测试文档

> AI 与人工共用的功能验收执行脚本与台账。用例由 `docs/DESIGN.md` 的 `REQ-*` 与 §19 Gherkin 场景派生；域段与设计文档一致（`CORE`=M1、`PROTO`=M2、`EDIT`=M3、`AGENT`=M4/M5）。

## 1. 元信息 / 变更记录

| 字段 | 值 |
| --- | --- |
| 状态 | 生效（v0.33 输入框可收起 + 聚焦态热更新于 RUN-089 局部轮通过；v0.32 本地单用户版：§3 已于 2026-09-18 按测试库 + 打包形态实测，全量 CORE / PROTO / EDIT / AGENT / INSTALL 于 RUN-082~087 通过） |
| Owner | @bug |
| 关联设计文档 | `docs/DESIGN.md` |
| 被测系统 | `~/Documents/Projects/Quilt`（Web 画布 + API/MCP 服务 + Worker + 预览域服务） |
| 最后更新 | 2026-09-19 |

变更记录（登用例增改，不登执行轮次）：

| 日期 | 改动 | 作者 |
| --- | --- | --- |
| 2026-09-09 | 初稿：TC-CORE-001~022、TC-PROTO-001~006、TC-EDIT-001~006、TC-AGENT-001~008，覆盖 REQ-CORE-001~010、REQ-PROTO-001~004、REQ-EDIT-001~003、REQ-AGENT-001~005 | @bug |
| 2026-09-10 | §3 环境按 M1 实现修正并冷启动实测通过（端口 3100/3101、`docker compose` Postgres、fs 对象存储、outbox 邮件、`.env` 来源、curl 需 `--resolve`）；无用例增改；AI 执行脚本 `tests/e2e/core.ts`（RUN=轮次、ONLY=用例子集）与 `tests/e2e/core-stub.ts`（TC-CORE-006） | @bug |
| 2026-09-11 | 设计文档 v0.6：新增 TC-PROTO-007（表单提交 / data-href 跳转）、TC-PROTO-008（画布连线开关）、TC-PROTO-009（补链修复轮）、TC-EDIT-007（检查器手动连线 + form-action 规则）；种子 `seed:project` 增 `--form`、`--unlinked` | @bug |
| 2026-09-14 | 设计文档 v0.7：新增 TC-PROTO-010（未设计交互只提示）、TC-PROTO-011（聚焦屏内捏合缩放）；`--form` fixture 增 `href="#"` 链接；`pnpm seed` 改为只清测试账号数据（§3） | @bug |

| 2026-09-16 | 设计文档 v0.13/v0.14（M6）：新增 `TC-EDIT-008`（元素批注攒批发送）、`TC-CORE-025`（生成通道可选）；`TC-EDIT-001`/`TC-EDIT-007` 按「选择元素可直接进入、与交互态互斥」更新步骤 | @bug |
| 2026-09-16 | 设计文档 v0.18（输入框按参考件重做，通道下拉改为自定义列表）：`TC-CORE-025` 原步骤 2 拆为 2~5——触发器默认值与名称、列表分组与不可用项就地说明、`Esc` 只关列表不清画布选中、选择后跨刷新记忆 | @bug |
| 2026-09-16 | 设计文档 v0.19（品牌接入）：新增 `TC-CORE-026`（品牌标识、字体、深底对比度与「用户设计稿不带工具品牌」的边界） | @bug |
| 2026-09-16 | 设计文档 v0.20（输入框不随侧边浮层平移）：`TC-CORE-023` 第 9 步改为断言折叠/展开不移动输入框，新增第 9b 步（右侧面板让位但不过度退让、输入框压在视口正中） | @bug |
| 2026-09-17 | 设计文档 v0.21（新建项目不问种子色）：`TC-CORE-003` 第 1~2 步改为断言弹窗只有 1 个可填字段、无取色器与「种子色」字样，且服务端在未传时回落到默认种子色 | @bug |
| 2026-09-18 | 设计文档 v0.31（动词版 M9）：`TC-CORE-029` 重写为「双击放锚点 → 输入框造 1 屏 × 3 版 → 候选修订 → 覆盖层采用 → 修订面板折组 → 造一组按流程排一行并反向连线」；新增 `TC-CORE-030`（⌘A × 2 版整组采用）、`TC-EDIT-009`（⌘A 不改设计系统；记为约定 → 提炼 → 预览 → 写入约定节 → 面板可删）、`TC-AGENT-009`（agent 作业映射：租约过期释放屏锁、重领重快照、旧基线 409、缺 expectedRevisionId 400、完成回执）；`TC-CORE-016` 增在途预估计入余额三步；`TC-CORE-024` 增第 5b 步（目标标签不随点空白清除、清空回到造）；`TC-CORE-025` 第 7 步改为「建 runner=agent 作业 + 挂 jobId 的任务、不占输入框」；`TC-CORE-014` 面板断言按修订树（每条标派生自哪一版）；作业种类 `generate_screens` / `generate_screen` / `generate_missing_screen` 在用例与种子里统一为 `generate`；种子 `seed:job` 增 `--input`、`seed:task` 增 `--job` 模式 | @bug |
| 2026-09-18 | 设计文档 v0.30（通道下拉只给图标 + 显示名 / 画布顶栏去品牌 / 分段控件同心圆角）：`TC-CORE-025` 第 3 步增「模型 id 不进下拉」，`TC-CORE-028` 第 7 步增「管理器行里写出模型 id」，`TC-CORE-026` 第 2 步改为在登录页量字标并断言画布顶栏无字标 | @bug |
| 2026-09-17 | 设计文档 v0.29（画布指针 / 设置弹层分栏 / 多屏生成改为独立屏）：`TC-CORE-007` 第 1、2 步增指针断言；`TC-CORE-018` 第 3 步、`TC-CORE-022` 第 2 步、`TC-CORE-028` 第 7 步改为分节 URL 与左栏 tab 操作，028 第 7 步增「方向键换节、URL 跟随」；`TC-CORE-029` 重写为「N 张独立屏并排、留一删余、无链接规划的出屏提示写明暂不跳转」 | @bug |
| 2026-09-17 | 设计文档 v0.28（画布空白处凭空生成一屏 + 多版候选 `REQ-CORE-014`）：新增 `TC-CORE-029`（三个入口开浮框、3 版候选不入主链与地图、选定后转 current 且重复选 409、count=1 直接 current 与路由去重） | @bug |
| 2026-09-17 | 设计文档 v0.27（预置 / 本机通道可按账号移除、可恢复）：`TC-CORE-028` 增第 7d 步，第 9 步增「已移除项不进下拉」 | @bug |
| 2026-09-17 | 设计文档 v0.28 导航模型（画布即主界面：`/` 直接进最近项目，项目列表页改为顶栏项目切换器，设置页改为 `?settings=1` 设置弹层）：`TC-CORE-001` 第 1、3、4 步、`TC-CORE-003` 第 1 步、`TC-CORE-018` 第 3 步、`TC-CORE-022` 第 2 步、`TC-CORE-028` 第 7~9 步改为经切换器 / 弹层操作；`TC-CORE-028` 第 8 步增「内层关闭后设置弹层仍在、背景仍 inert」 | @bug |
| 2026-09-17 | 设计文档 v0.25（生成通道可配置）：新增 `TC-CORE-028`（通道增删改验、密钥零泄漏、作业按 channel 形态跑通、设置页管理器与输入框下拉只列可用项）；`TC-CORE-025` 步骤 2~3 的「下拉列出全部通道且不可用项灰化」改为「下拉只列可用项，不可用项在设置页看」 | @bug |
| 2026-09-17 | 设计文档 v0.24（本机三条通道传图）：`TC-CORE-027` 第 3、6 步改为条件步骤——当前所有通道 `vision=true`，护栏路径无通道可触发，脚本按清单自动跳过 | @bug |
| 2026-09-17 | 设计文档 v0.23（参考图输入）：新增 `TC-CORE-027`（附件类型/大小校验、无视觉通道的双重护栏、贴图上限与移除、`attachmentIds` → `imageKeys` 贯通） | @bug |
| 2026-09-17 | 设计文档 v0.22（风格指南卡改报项目字体）：`TC-CORE-026` 第 5 步由「卡上不出现 Space Grotesk」改为「卡上报出项目自己的字体、且不等于工具外壳字体」，并加一条防止两者取同一字体时断言失去区分力的守卫 | @bug |
| 2026-09-22 | 设计文档 v0.59（改文案联动无障碍名）：`TC-EDIT-012` 第 11 步增三条断言——一致时联动、邻条不受影响、刻意不同时不动。这是 v0.57 记进遗留问题的那一条，现已收口，遗留问题里相应删去 | @bug |
| 2026-09-22 | 设计文档 v0.58（今天这批功能的缺陷回写）：`TC-EDIT-012` 第 11 步增「改完一个元素后不退出、直接改第二个」与「组件被 edit_component 占着时直改报 component-busy」两条；`TC-CORE-023` 第 12 步增「改窗口大小后工具条要重量、任何视口下控件都可点」；`TC-CORE-007` 第 7 步增「平移后立刻刷新不丢位置」与「切到没打开过的项目不得用上一个项目的屏算适配」 | @bug |
| 2026-09-22 | 设计文档 v0.57 补测：`TC-EDIT-012` 第 11 步把「退出路径逐条查残留」写成断言。用户报「退出后样式还在」，实测两条路径确实留着：`⌘E` 在焦点落于组件 iframe 内时根本没到父页（组件分支只转发了 Escape），以及离开时没给组件运行时发回 `interact`（屏是靠卸载 iframe 自然清掉的） | @bug |
| 2026-09-22 | 设计文档 v0.57（组件里也能选元素直改）：`TC-EDIT-012` 增第 11 步。两条断言是这轮实测踩出来的：① 文案框要读得到文字——组件给 `<span>` 写了 `pointer-events:none`、命中全落外层 `<label>` 时，选中的会是没有直接文案的 label，保存文案会在它下面挂一个游离文本节点；② 面板里不能有「记为共享组件」与子树重生成，组件里套组件本来就被硬校验拒掉 | @bug |
| 2026-09-22 | 设计文档 v0.56（组件交互态角标换绿点）：`TC-EDIT-012` 第 9 步的角标断言改为「右上出现 `.live-dot` 呼吸绿点、带 `aria-label="交互中"`」，文字角标不再存在 | @bug |
| 2026-09-22 | 设计文档 v0.55（组件预览里链接惰性）：`TC-EDIT-012` 第 9 步增断言——往交互态的组件里塞一个 `href="#"` 链接点下去，不得出现 toast、iframe 不得跳走；`Esc` 在焦点落于组件 iframe 内时仍能退出 | @bug |
| 2026-09-22 | 设计文档 v0.54（组件交互契约）：`TC-EDIT-012` 增第 10 步——组件要真能切，验收点落在「没有任何一条把选中样式硬编码进 class」与「点一下状态真的转移且容器不顶高」两条可量的断言上，而不是看截图像不像。组件禁 `<script>` 不变，所以这一步同时守住「交互是 CSS-only 实现的」 | @bug |
| 2026-09-22 | 设计文档 v0.53（画布位置留存 / 组件卡可交互 / e2e 认库闸）：`TC-CORE-007` 增第 7 步（刷新后首帧即记忆位置、逐帧只一个 transform、存储被改坏时回默认）；`TC-EDIT-012` 增第 9 步（双击组件卡进交互、镜头不动、与屏聚焦互斥、`Esc` 出）；§3 写明认库闸与 3200/3201 另起一套的跑法 | @bug |
| 2026-09-22 | 设计文档 v0.52（一键排成一行 / 排成一列，`REQ-CORE-018` 补充）：`TC-CORE-034` 第 2 步按钮数改为 10、增第 8b～8d 步——三屏叠在一处时点「排成一列」按 844 + 80 纵向排开、点「排成一行」按 390 + 80 横向排开、`⌘Z` 回到一列并 toast「已撤销排列」；第 9 步 `End` 落点改为 `arrange-vcol` | @bug |
| 2026-09-21 | 设计文档 v0.51（MCP 与画布同面，`REQ-AGENT-002` 补充）：新增 `TC-AGENT-011`——用纯 MCP / REST 脚本 `tests/e2e/mcp.ts`（`pnpm --filter @quilt/tests e2e:mcp`）把 32 个新工具与 4 处签名改动逐个过一遍（删 / 修订 / 候选 / 摆放 / 直改 / 六种作业 / 素材 / 预设 / 批注 / 项目），作业类步骤在 `LLM_DRIVER=stub` 下只验作业输入与终态；`TC-AGENT-001` 第 1 步的工具清单仍成立（子集）。脚本可经 `QUILT_E2E_API` 指到独立端口的 API，不占用 3100 的开发实例（§3） | @bug |
| 2026-09-21 | 设计文档 v0.50（输入框工具条几何）：`TC-CORE-023` 第 12 步——控件两两不相交、宽度按工具条量、切模式时宽度单调过渡而高度恒定、装不下时 `data-bar="wrap"` 仍全部可见。这四条都不是「有没有横向滚动」能查出来的：内容是溢出到兄弟节点身上、不撑文档，高度抖动只在动画中途出现 | @bug |
| 2026-09-21 | 设计文档 v0.49（预览响应不再声明 immutable，`API-CORE-016` 修订）：`TC-CORE-010` 增第 3c 步——预览响应头为 `no-cache`，退出交互再进一次仍走真实网络请求。这一步守的是「运行时修复当场生效」这条承诺：v0.48 的修复推上去之后现场仍看得到滚动条，就是被 `immutable` 挡住的 | @bug |
| 2026-09-21 | 设计文档 v0.48（预览里不再露出滚动条，`ADR-003` 补充）：`TC-CORE-010` 增第 3b 步——聚焦屏的滚动根 `scrollbar-width` 为 `none`、槽宽 0，但 `scrollHeight > clientHeight` 且滚轮滚得动（视觉无条、实质可滚）。无头浏览器默认 overlay 滚动条、槽宽恒 0，这一步必须在有头 Edge 里量才有区分力 | @bug |
| 2026-09-21 | 设计文档 v0.47（多选批量移动，`REQ-CORE-004` 补充）：`TC-CORE-007` 前置增建一个共享组件，增第 4～6 步——加选 2 屏 + 组件后按住其中一屏拖动整组同位移、未选中的屏不动、屏与组件各自 PATCH 落库；按在已选卡片上不拖则收成只选它；`⌘Z` 整组还原并 toast「已撤销移动」 | @bug |
| 2026-09-20 | 设计文档 v0.46（共享组件 `REQ-EDIT-006`）：新增 `TC-EDIT-012`（从屏里提取导航栏为组件并同步到其他屏、`PATCH` 改组件后三屏确定性回刷、版本冲突 409、实例内直改 409 component-locked 与 `detach` 脱离、改名跟随、删组件屏不动、画布组件卡 / 目标标签 / 检查器锁定提示 / 新建组件、真实 `edit_component` 回合）；§3 注明 fixture 的 `<nav>` / `<header>` 是提取靶子 | @bug |
| 2026-09-20 | 设计文档 v0.45（聊天模式 `REQ-CORE-023`）：新增 `TC-CORE-039`（非 Claude 通道 / 没有 agent-sdk 通道 400、在跑 chat 作业 409、只问不改的回合不动屏、跨轮指代改一屏且修订记在聊天作业名下、段控切聊天后档位隐藏 / 动词行 / 通道只列本机 Claude 订阅 / 在跑作业行与回执 / 刷新记住模式）；脚本 `tests/e2e/chat.ts`；§3 补本机 claude 登录态前置。 | @bug |
| 2026-09-20 | 设计文档 v0.44（字体来源）：新增 `TC-EDIT-011`（Google 任意族名进 prelude 链接、本机字体不发外链且栈以族名开头带 `-apple-system` 回退、自定义样式表链接原样进 `<link>`、来源为 url 缺链接与带引号族名 400、面板回显 / 就地报错不提交 / 切来源收起链接框）；`tests/e2e/edit.ts` 同步。 | @bug |
| 2026-09-20 | 设计文档 v0.43（设计契约从闸门改成透镜）：三处断言翻转——`TC-EDIT-002`（直改引入内联样式）、`TC-PROTO-007`（表单去掉 action）、`TC-AGENT-004`（MCP 推违规 HTML）由「422 lint-failed、不落库」改为「照常落修订 / 建屏，偏离进 `lintReport` 并在卡片上报「N 处偏离」」；新增外部库用例（推一张引 Chart.js 的屏，预览域里真的画出来）。 |
| 2026-09-20 | 设计文档 v0.42（MCP 补两个写入口）：`TC-AGENT-002`（MCP 工具面）增两步——`quilt.update_design_system` 带 `expectedVersion` 改色板并 `applyToScreens` 回刷（屏的 prelude 换色、body 不动、版本过期回 `409`），`quilt.update_project` 改名与 brief。 |
| 2026-09-20 | 设计文档 v0.41（画布位置可撤销）：`TC-CORE-034` 增第 8 步——对齐后按 `⌘Z` 位置回到对齐前并 toast「已撤销对齐」，再按一次提示「没有可撤销的移动」。 |
| 2026-09-20 | 设计文档 v0.40（项目重命名 + 设计预设）：新增 `TC-CORE-037`（切换器行内重命名：hover 露出、就地编辑、回车存、`Esc` 放弃、空名不改）与 `TC-CORE-038`（设计预设：连素材存 → 新建项目按预设开局 → 已有项目套用并问回刷 → 删预设不影响已套用的项目）。 |
| 2026-09-19 | 设计文档 v0.39（v0.38 收尾）：`TC-EDIT-005` 第 2 步改为「只改正文不弹回刷、焦点兜底落到『回刷所有屏』」；`tests/e2e/edit.ts` 点弹层里的 `ds-apply-confirm`（旧脚本点面板那颗同名键会被 inert 挡住必超时）、`tests/e2e/agent.ts` 的「已投递」改等待式（面板改轮询后最长 1.5s 才翻牌）。 |
| 2026-09-19 | 设计文档 v0.38（八组验收缺陷回写）：`TC-CORE-029` 第 6 步改为「先摆好目标与草稿再让后台造屏」并增第 6b 步（收口后目标标签与草稿都不变、进度兜底写「排队中…」）；`TC-CORE-030` 第 3 步增「展开期间排列条不在场」、新增第 3b 步（整组采用被逐屏跳过时报跳过、零采用不收起）、第 4 步删掉与现状不符的「Esc 关闭」（采用后自动收起）并补「排列条随之回来」；`TC-CORE-034` 增第 8~9 步（1024 窄视口下排列条避让右侧面板且按钮可点、48rem 以下面板开着时整条让位；工具条键盘模式方向键 / `Home` / `End` 环绕 + 一次 `Tab` 离开）；`TC-CORE-035` 增第 3b、3c、7b 步（改名文件按正文魔数认类型、坏 / 越界 `viewBox` 不再 500、并发 60 次上传仍卡在 50 个、素材区拖拽上传与非图片就地说明）并在第 7 步写明展示 `<img>` 不带 `crossOrigin`；`TC-CORE-036` 第 1 步把「带进度」明确为兜底文案「排队中…」；`TC-EDIT-005` 第 1~2 步改为「未保存时回刷不可点 → 保存后弹 `ds-apply-ask` → 点 `ds-apply-confirm` 才建回刷作业」；`TC-EDIT-010` 第 5 步增暗色方案断言（`surfaceVariant` 取暗值、对比度 ≥ 4.5:1、语义色切 80/20）、新增第 5b 步（撤掉暗色色板自动回落 `light`、`dark:{}` 等同没有暗色色板、显式选 `dark` 仍 400）与第 8 步（存量行删掉语义键后重启即回填、`version` 不变、幂等）；`TC-AGENT-009` 第 3 步增「面板开着时活跃 `EventSource` 仍为 1、后台标签页不轮询」、第 5 步的「已投递」改为等待式断言（面板改轮询后最长 1.5 s 才翻牌，一次性断言会变脆）。`tests/e2e/core.ts` 同步：补三条最值得防回归的断言——`TC-CORE-029` 的「后台造屏不顶目标与草稿」、`TC-CORE-030` 的「展开期间排列条不在场」与「全部被跳过时说明跳过且不收起」；候选角标选择器改为 `[data-testid="candidate-badge"][data-route=…]`（角标已移出卡片，后代选择器失效），`TC-CORE-032` 保存后改点 `ds-apply-confirm`。`TC-CORE-034` 第 8~9 步（窄视口避让、工具条键盘模式）与 `TC-CORE-035` / `TC-EDIT-010` 的新步骤本轮只入文档、脚本未覆盖，按人工或下一轮补 | @bug |
| 2026-09-19 | 设计文档 v0.37（一个标签页只开一条长连接）：`TC-CORE-036` 增第 10 步——两个作业同时在跑时，该标签页的活跃 `EventSource` 恒为 1（作业进度改走项目事件流的 `job_changed` 投影）。多开标签页的连接额度是浏览器全局 6 条，实测第 6 条起普通请求即超时，这一步是它的回归闸。 |
| 2026-09-19 | 设计文档 v0.36（并行作业 `REQ-CORE-020`）：新增 `TC-CORE-036`（两个作业同时在跑时输入框仍可输入、在跑作业逐行呈现并各带取消键、只有这一轮真冲突才挡住发送、改另一张空闲屏放行且两个作业各自落地、`Esc` 取消最新、逐行取消只取消那一个）；`TC-CORE-013` 第 2 步与 `TC-CORE-023` 第 10 步改写——此前把「有作业在跑时输入框禁用」「占位文案提示按 `Esc` 可取消」当验收点 | @bug |
| 2026-09-19 | 设计文档 v0.35（品牌色板 + 项目素材库）：新增 `TC-EDIT-010`（品牌色板：语义色恒在、逐键覆盖、回刷只换 prelude、无暗色色板拒切、清空回派生、面板 26 键）与 `TC-CORE-035`（项目素材库：SVG 取 viewBox 尺寸、URL 不签名可取且长缓存、非图片 422、素材清单进 system 前缀、详情带 `assets[]`、风格指南卡片画出素材、面板确认后删除）；`openai-stub` 记下 system 前缀供断言。验收反馈后 `TC-CORE-035` 补第 5～6 步，`TC-CORE-023` 的画布空态不再有「屏幕会生成到这里」那句文案。 |
| 2026-09-19 | 设计文档 v0.34（本机 agent 改为投递到活跃 Claude Code 会话）：`TC-AGENT-009` 重写为假会话（登记文件 + socket）验「列表命名规则 / 会话下拉 / 投递提示词与回执 / 屏锁 / 取消后 finish_job 409 / failed · 旧基线 · succeeded 三种收口 / 选择记忆与失效」；`TC-AGENT-010` 改为人工（投递到真实会话要在终端确认）；`TC-CORE-025` 第 7 步改为「缺 / 死 sessionId 建作业前 400」；§3 的 `QUILT_AGENT_COMMAND` 换成 `QUILT_CLAUDE_SESSIONS_DIR`；§7 遗留改写；同轮验收补 `TC-CORE-010` 第 5b 步（焦点在 iframe 里按 `⌘E` 由运行时转发）、`TC-EDIT-003` 第 1a 步（检查器通道单独记忆、作业带该 runner）与第 1~3 步的屏内标记 / 根沿用 qid 断言、`TC-AGENT-009` 第 8 步的「不操作即热更新」断言（项目级事件流 `API-CORE-030`）；`TC-CORE-028` 第 7d 步（预置通道按账号移除 / 恢复）随该功能删除，第 9 步去掉「已移除项不进下拉」；新增 `TC-CORE-033`（删项目：hover 垃圾桶 / Delete 键 → 确认 → 级联与对象清理、有作业 409、删当前项目回首页；标签页标题带项目名）；新增 `TC-CORE-034`（多选排列：六种对齐 + 两种等距，经既有位置 PATCH 落库，不足 3 屏等距不可用）；候选覆盖层改为画布就地展开后 `TC-CORE-029` 第 5 步、`TC-CORE-030` 第 3 步改写（`candidate-stack` / `cand-ghost` / 每格活 iframe / 采用后自动收起）；去掉「系统预置」后 `TC-CORE-025` 第 1 步改为「云端通道 = 自己配的（seed 按 `.env` 建一条 Gemini）」、`TC-CORE-028` 第 7 步改两组、删第 7c 步 | @bug |
| 2026-09-18 | 设计文档 v0.33（输入框可收起 `⌘/` + 聚焦态热更新）：`TC-CORE-023` 增第 8b~8d 步（`⌘/` 收起 / 叫回并保草稿、工具栏同一开关、聚焦自动收起 / 退出恢复）；新增 `TC-CORE-032`（聚焦态热更新：桩通道改屏后 iframe 原地更新、不重挂、滚动位置保持；栈顶屏回刷后原地换色、后退到栈底屏也是新修订）；`TC-EDIT-001` 第 2 步增「iframe 不重挂」；`TC-EDIT-003` 增「聚焦不退出即见子树更新」；桩 `openai-stub` 复用 | @bug |
| 2026-09-18 | 设计文档 v0.32（本地单用户版 M10，`ADR-016`）：去账号——`TC-CORE-001` / `002` / `021` 随 `REQ-CORE-001` 推迟，全部用例的「以 Owner 登录」「会话 cookie」「`--owner`」前置移除，§3 改为单用户 + 测试库 `quilt_test` + 两种运行形态；去硬上限——`TC-CORE-016` 重写为「台账无上限仍放行 + 在途预估可见」、`TC-CORE-022` 重写为「设置弹层汇总 / 按驱动分列 / MCP 接入命令」；`TC-CORE-018` 第 3 步改为新标签页重开；`TC-CORE-025` 第 7 步改为「本机 agent 建 runner=agent 作业、列入 `GET …/jobs?runner=agent`、CLI 不在 PATH 时 400 并给安装步骤」；`TC-CORE-026` 第 1、2 步改在 PAGE-FIRST（`pnpm seed --empty`）量品牌；`TC-CORE-028` 第 7 步左栏改为 2 节；本机 agent 改由 Quilt 进程拉起 CLI——`TC-AGENT-001` 重写为免鉴权接入、`TC-AGENT-002` / `005` / `006` / `007` / `008` 推迟、`TC-AGENT-009` 重写为桩 CLI 验拉起 / 屏锁 / 回写守卫 / 退出码 / 取消、新增 `TC-AGENT-010`（真实 Claude Code 跑一次）；新增 `TC-CORE-031`（`npx quilt-canvas` 冷启动，脚本 `tests/e2e/install.ts`）；种子 `seed` 增 `--empty`、`seed:job` 增 `--screens`，`seed:login` / `seed:magic-link` / `seed:quota` / `seed:task` / `seed:device` / `mcp:grant` / `mcp:await` / `task:lease-expire` 删除 | @bug |

## 2. 测试范围 / 不测什么

- 覆盖：Quilt 全部功能域的黑盒功能验收——Web 画布（浏览器）、REST API（curl）、MCP 工具（脚本客户端）、预览域；对应设计文档 `REQ-CORE-002`~`REQ-CORE-017`、`REQ-PROTO-001`~`REQ-PROTO-004`、`REQ-EDIT-001`~`REQ-EDIT-004`、`REQ-AGENT-002`~`REQ-AGENT-003`（`REQ-CORE-001`、`REQ-AGENT-001/004/005` 已推迟到 SaaS 阶段）及其全部 Gherkin 场景（每条场景至少一条 TC 可操作化，无场景交由自动化独占覆盖）。
- 不测：

| 不测项 | 归属 |
| --- | --- |
| 单元 / 集成 / 契约自动化（lint 规则、状态机守卫穷举、权限矩阵、openapi↔MCP schema） | 代码仓测试套件（策略见设计文档 §19） |
| 延迟 P95、并发 20 作业、队列等待等容量指标 | 专项压测（指标见设计文档 §15）；本文档仅含 100 屏画布帧率一条功能性检查 |
| 安全渗透（预览域 CSP 绕过；SaaS 阶段的鉴权攻击面） | 上线前专项审计——本地版服务只绑 `127.0.0.1`、无鉴权面；SaaS 阶段再审 |
| 生成内容的美学质量（超出「对标 Stitch」人工门之外） | 无归属——由 §3 指标持续观察 |
| 部署管线、灰度、回滚演练 | deploy-pipeline（设计文档 §23） |

## 3. 环境与前置

**跑 e2e 必须对测试库**（v0.53 起有机械闸，不再只靠这段话）：`tests/e2e/lib.ts` 的 `assertTestApi()` 挂在 `launch()` / `apiJson()` / `connectMcp()` 三个入口，动手前问 `GET /v1/health` 的 `database` 字段，库名不含 `_test` 就当场抛错并给出另起一套 API 的命令；连不上也抛（失败即关）。`pnpm mcp:call` 是手工开发脚本，显式 `ALLOW_E2E_DEV=1` 放行。3100 被开发实例占着时另起一套：`DATABASE_URL=…/quilt_test API_PORT=3200 PREVIEW_PORT=3201 pnpm --filter @quilt/api dev`，跑用例时 `QUILT_E2E_API=http://localhost:3200`。起因：2026-09-21 并行会话把 e2e 打到 3100 的开发实例上，浏览器与 MCP 的逐屏写删绕过了下面这道 seed 守卫，开发库里四个项目的屏被清空。`pnpm seed` 是按 owner 全量重置（项目、通道、用量全删），而各套件在模块顶层就调它——import 一下就清库。因此 e2e 一律 `DATABASE_URL=postgres://quilt:quilt@127.0.0.1:5439/quilt_test`（API 进程与 runner 都要设）；`tests/e2e/lib.ts` 的 `seed()` 会在 DATABASE_URL 不指向测试库时直接抛错，确实要重置开发库时显式给 `ALLOW_SEED_DEV=1`。

> 状态：v0.32 本地单用户版（2026-09-18）。没有账号、登录、邮件与派活队列；MCP 免鉴权；数据层可用内置 PGlite 或外部 Postgres。

- 两种运行形态，用例针对**仓库内开发形态**执行，`TC-CORE-031` 单独验**打包形态**：
  - 仓库内开发：`docker compose up -d`（Postgres 容器 `quilt-pg`，端口 5439）→ `pnpm install && pnpm db:migrate && pnpm dev`（API `:3100` + 预览域 `:3101` + Worker + agentRunner 同一进程，Web `:5173` 经 Vite 代理 `/v1`）。**跑用例前把 API 与种子脚本都指到测试库**：`DATABASE_URL=postgres://quilt:quilt@127.0.0.1:5439/quilt_test`（先 `docker exec quilt-pg psql -U quilt -d postgres -c "create database quilt_test"` 与 `DATABASE_URL=… pnpm db:migrate`），因为 `pnpm seed` 会清掉默认用户名下**全部**项目——本地版只有这一个用户，开发库里的真实项目不能拿来跑测试。
  - 打包形态：`npx quilt-canvas`（包 `apps/cli`，bin `quilt`）——`$QUILT_HOME`（默认 `~/.quilt`）下 PGlite + 对象目录 + `config.env`，API 同端口托管静态前端，预览域 `http://127.0.0.1:3101`。测试用 `--home <临时目录> --port 3410 --preview-port 3411 --no-open` 隔离，结束即删。
- 就绪判定：`curl http://127.0.0.1:3100/v1/health` 返回 200 且含 `"status":"ok"`；`curl http://127.0.0.1:3100/v1/config` 返回 `{"previewOrigin":…,"local":true,…}`；`http://localhost:5173/` 返回画布或 PAGE-FIRST（HTTP 200）；`curl --resolve preview.localhost:3101:127.0.0.1 http://preview.localhost:3101/healthz` 返回 200。服务只绑 `127.0.0.1`。本地 `.env` 由 `.env.example` 复制而来，`SCREENSHOT_BROWSER_CHANNEL=msedge`（截图用本机 Edge）。对象存储用本地 fs 驱动（`.data/objects`）。
- 入口：Web `http://localhost:5173`；API `http://127.0.0.1:3100/v1`；MCP `http://127.0.0.1:3100/mcp`（免鉴权）；预览域 `http://preview.localhost:3101`。
- 用户：只有默认用户 `local@quilt.local`（迁移 `0008` 创建，`pnpm seed` 不删它）。所有 curl / 浏览器请求都不带凭据。
- 种子数据与重置：
  - `pnpm seed [--empty]`：重置基线——删掉默认用户名下全部项目（级联屏 / 修订 / 作业 / 台账 / 通道）与对象子目录，再建空项目 `Demo Mobile`（mobile）与 `Demo Desktop`（desktop），设计系统 seedColor `#3B5BDB`；`--empty` 不建示例项目（PAGE-FIRST 用例）。
  - LLM 驱动：`.env` 的 `LLM_DRIVER` 取 `agent-sdk`（本机 Claude 订阅）/ `anthropic` / `gemini`（模型 `QUILT_MODEL` 用 `gemini-3.8-flash`；计费路径二选一：AI Studio 需 `GEMINI_API_KEY`，Vertex AI 需 `GEMINI_VERTEX=1` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION=global` + `GOOGLE_APPLICATION_CREDENTIALS` 指向服务账号 JSON）；`GET /v1/health` 的 `llm` / `model` 字段确认生效。真实 LLM 用例（`TC-CORE-005` 等）的耗时与通过率随驱动变化，登记时在明细注明驱动。
  - `pnpm seed:project --name <名> --device mobile|desktop --screens <N> [--revisions <M>] [--dangling] [--no-shot]`：用内置 fixture HTML 直接落库（不调 LLM），每屏含 `data-qid`、路由 `/s1`…`/sN` 与互链；`--revisions M` 给每屏 M 个修订；`--dangling` 让第一屏多一条 `href=/settings` 断链。输出 projectId 与各 screenId。fixture 每屏 depth-1 有一个 `<header>`（标题 `Screen N vM`）与一个 `<nav>`（tab 数 = min(N, 4)，指向 `/s1`…，各条链接类名完全相同、无 `aria-current`），它们是共享组件用例（`TC-EDIT-012`）的提取靶子——提取这个 `<nav>` 得到的是非导航型组件（`nav=false`）。
  - `pnpm seed:job --project <id> --screen <id> --status running`：构造进行中作业占用某屏；`--status running --tokens 3000 [--screens 400]`：构造已消耗 3000 token（与 400 屏）的运行中作业，台账预写在 `stub` 驱动名下（供取消记账与用量展示用例）；`--input '<json>'` 覆盖作业输入（在途预估用例：`{"prompt":"x","count":4,"versions":2}`）。
  - `pnpm seed:preview-token --screen <id> --expired`：打印一个已过期的预览签名 URL。
  - `pnpm seed:design-system --project <id> --bump`：把设计系统 version 抬升 1（制造版本冲突）。
  - 时间敏感状态（过期签名）一律种子构造，不真等。
- 本机 agent（`REQ-AGENT-003` v0.34，投递到本机 Claude Code 会话）：`TC-AGENT-009` 用**假会话**验整条链——`tests/e2e/agent-stub.ts` 在 `QUILT_CLAUDE_SESSIONS_DIR` 指向的目录里写一份 Claude Code 风格的登记文件（`<pid>.json`，`kind=interactive`、`peerProtocol=1`）并监听同目录下的 unix socket；API 与测试脚本都要以同一个 `QUILT_CLAUDE_SESSIONS_DIR=/tmp/quilt-e2e-sessions` 启动 / 运行（未设时该用例登记「跳过」）。假会话按投递来的指令里的 `HANG` / `FAIL` / `STALE` 决定行为，其余走真实 MCP 回写并 `quilt.finish_job` 收口。`TC-AGENT-010`（真实会话）为人工用例：投递进真实会话要在那个终端里确认接收，AI 不代按。
- 聊天模式（`REQ-CORE-023` v0.45）：`TC-CORE-039` 要本机 `claude` 已登录——脚本经 API 建一条 `agent-sdk` 通道并探测通过后才发真实回合（模型 `CHAT_MODEL`，缺省 `claude-sonnet-5`；一轮 1～5 分钟，按订阅额度计费）；`LIVE_LLM=0` 只跑通道校验与串行守卫。SDK 会话文件落在 `~/.claude/projects/` 下按 `$dataDir/chat` 编码的目录，测试库与开发库共用该目录、会话 id 各自记在项目上，互不干扰。
- MCP 与画布同面（`REQ-AGENT-002` v0.51）：`TC-AGENT-011` 由 `pnpm --filter @quilt/tests e2e:mcp` 执行，纯 MCP / REST、不开浏览器，要求 API 以 `LLM_DRIVER=stub` 启动（脚本先查 `/v1/health`，不是 stub 就退出）。为了不占用 3100 上的开发实例，可另起一套：`API_PORT=3200 PREVIEW_PORT=3201 API_ORIGIN=http://localhost:3200 PREVIEW_ORIGIN=http://preview.localhost:3201 DATABASE_URL=postgres://quilt:quilt@127.0.0.1:5439/quilt_test LLM_DRIVER=stub LLM_STUB= pnpm --filter @quilt/api dev`，脚本侧 `QUILT_E2E_API=http://localhost:3200 DATABASE_URL=…quilt_test`（种子脚本走同一个 `DATABASE_URL`）。`PREVIEW_ORIGIN` 必须一起改：`.env` 里写死的 3101 会让素材 URL 与截图渲染都打到开发实例的预览域。
- LLM 故障注入：`LLM_STUB=503 pnpm dev` 让所有调用返回 503；`LLM_STUB=fixture` 回放固定 HTML（需要确定性时使用，用例中显式注明）。真实调用会消耗额度，每条用例后置不做特殊清理。
- 工具：浏览器（自动化遵循运行环境既有约定：Playwright 驱动本机 Edge；帧率用页面内 rAF 计数 + `longtask` PerformanceObserver 采样；**在预览 iframe（跨域）内点击元素前必须先让画布处于该屏 1:1 聚焦态**——Playwright 不感知外层 CSS transform 缩放，非 1:1 下点击坐标会偏；键盘快捷键在焦点位于 iframe 内时由预览运行时转发，测试可直接对页面按键）；curl（不带凭据）；`pnpm mcp:call <tool> '<json>'` / `--resource <uri>` / `--list`（MCP 调用脚本，打印工具返回）。
- 执行脚本：`tests/e2e/core.ts`（CORE）、`proto.ts`、`edit.ts`、`agent.ts`、`install.ts`（`TC-CORE-031`）、`smoke.ts`（开发冒烟）；环境变量 `RUN=轮次`、`ONLY=用例子集`、`LIVE_LLM=0` 跳过真实生成。各套件串行执行，不并行——每套开头的 `pnpm seed` 会清掉另一套正在用的数据。
- 证据目录：`docs/test-runs/`（截图按 `run-NNN-tc-<域>-NNN.png`、响应体按 `.json` 命名；文中引用以项目根为基准）。

## 4. 用例库

### CORE · 项目

> v0.32 本地单用户版：`TC-CORE-001`（magic link 登录）、`TC-CORE-002`（过期 magic link）、`TC-CORE-021`（未登录守卫与越权 404）随 `REQ-CORE-001` 推迟到 SaaS 阶段，用例正文随之移除；ID 保留不复用。

#### `TC-CORE-003` 创建手机项目自动生成设计系统 — 对应 `REQ-CORE-002` · 级别: 冒烟 · 执行者: 皆可

前置：已按 §3 重置基线。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点开顶栏项目切换器（`project-switcher`），点底部「新建项目…」（`new-project`） | 弹窗只含名称输入与设备形态单选（手机 / 桌面）：可填字段恰好 1 个，**不出现取色器、也不出现「种子色」字样**（`REQ-CORE-002`）|
| 2 | 填名称 `Pet`，选手机，提交 | 进入 `/p/<id>` 画布；API 返回 201。未传 `seedColor` 时服务端回落到默认值，`designSystem.seedColor` 是合法 `#RRGGBB`，`tokens.colors` 含 `primary`、`onPrimary`、`surface`、`onSurface` 且 `primary` 与该种子色同色相 |
| 3 | curl `GET /v1/projects/<id>` | `project.deviceType` 为 `mobile`；`designSystem.designMd` 含 Overview、Colors、Typography、Layout、Elevation、Shapes、Components、Do's and Don'ts 八个标题；`designSystem.components` 非空数组 |

后置：无。

#### `TC-CORE-004` 非法设备形态被拒 — 对应 `REQ-CORE-002` · 级别: 回归 · 执行者: 皆可

前置：。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/projects`，body `{"name":"X","deviceType":"tablet"}` | HTTP 400，`type` 为 `/errors/validation`，`errors[]` 指向 `deviceType` |
| 2 | curl `GET /v1/projects` | 列表无名为 `X` 的项目 |

后置：无。

#### `TC-CORE-033` 删除项目与标签页标题 — 对应 `REQ-CORE-002`（v0.34）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name DelA --device mobile --screens 1 --no-shot`、同样种 `DelB`；打开 DelA。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 读 `document.title` | 「DelA · Quilt」 |
| 2 | 打开项目切换器，鼠标移到 DelB 那行 | 行内露出垃圾桶（`delete-project`，`opacity` 为 1），点它 | 
| 3 | 确认弹窗（`role=alertdialog`）写明「删除「DelB」？」与级联范围，点「删除」 | toast「已删除「DelB」」；`GET /v1/projects/<DelB>` 404；`.data/objects/projects/<DelB>` 目录已清 |
| 4 | 给 DelA 种一条 `running` 作业，`DELETE /v1/projects/<DelA>` | 409 `/errors/project-busy`；取消作业后可删 |
| 5 | 刷新，打开切换器，鼠标移到 DelA 行（当前项目）按 `Delete`，确认 | 键盘等价物同样弹确认；删掉当前项目后页面回到 `/`，落到最近更新的其它项目；`GET /v1/projects/<DelA>` 404；标题不再是 DelA |

后置：无。

#### `TC-CORE-034` 多选排列 — 对应 `REQ-CORE-018`（v0.34）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Arrange --device mobile --screens 3 --no-shot`，经 `PATCH /v1/screens/{id}` 把三屏摆到 (0, 0)、(700, 150)、(1900, −80)；打开项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点一张卡片 | 只选一屏，画布顶部没有排列条（`arrange-bar`） |
| 2 | `⌘A` | 排列条出现：「3 屏」+ 6 个对齐 + 2 个等距 + 2 个排列（排成一行 / 排成一列，v0.52）图标按钮，共 10 个 |
| 3 | `Shift` 点那张卡片去选，剩 2 屏 | 排列条仍在、写「2 屏」，「横向等距」「纵向等距」`aria-disabled`，提示里写「至少选 3 屏」 |
| 4 | `⌘A`，点「横向等距」（`arrange-hspace`） | 首尾两屏 `x` 不变（0、1900），中间那屏 `x` = 950（间隙均分）；`GET /v1/projects/{id}` 读到的位置一致 |
| 5 | 点「纵向等距」（`arrange-vspace`） | 最上（−80）与最下（150）不变，中间屏 `y` = 35 |
| 6 | 点「上对齐」（`arrange-top`） | 三屏 `y` 全为 −80 |
| 7 | 点「右对齐」（`arrange-right`） | 三屏 `x` 全为 1900（同宽，右缘对齐 = `x` 相同；此后三卡叠在一处，所以去选检查放在第 3 步） |
| 8 | 按 `⌘Z`（焦点不在输入框），再按一次 | 第一次：三屏位置回到第 7 步之前，toast「已撤销对齐」，`GET /v1/projects/{id}` 读回的坐标同步还原；第二次：toast「没有可撤销的移动」，位置不动（位置撤销栈至多 20 步，v0.41） |
| 8b | 点「排成一列」（`arrange-vcol`；此时三屏都叠在 (1900, −80)） | 三屏 `x` 全为 1900，`y` 依次 −80、844、1768（屏高 844 + 固定间距 80；顺序按当前位置，完全重合时按选中集合次序）；`GET /v1/projects/{id}` 读到的位置一致 |
| 8c | 点「排成一行」（`arrange-hrow`） | 三屏 `y` 全为 −80，`x` 依次 1900、2370、2840（屏宽 390 + 80）；起点取外接框左上角，整组没有跳走 |
| 8d | 按 `⌘Z` | 回到 8b 的一列，toast「已撤销排列」 |
| 8 | 视口调到 1024×768，`⌘A` 后 `⌥T` 打开本机 agent 面板，读排列条与面板的横向范围，再点「纵向等距」（v0.38） | 两者不重叠（排列条右端避让 `--chrome-right`）；`arrange-vspace` 中心的 `elementFromPoint` 命中它自己而不是面板，点下去位置真落库；视口窄到 768 及以下且面板开着时整条隐藏（这一档面板叠在画布上、可用区不再为它让位） |
| 9 | 焦点放到排列条第一个按钮，按 `→`、`End`、再 `→`，然后按一次 `Tab` | 工具条键盘模式（`INT-002`）：10 个按钮里恰好一个 `tabindex=0`、其余 −1；`→` 从 `arrange-left` 移到 `arrange-hcenter`，`End` 跳到 `arrange-vcol`（最后一键，v0.52），再 `→` 环回 `arrange-left`；`Tab` 一次即离开整条（焦点落到条外） |

后置：无。

#### `TC-CORE-035` 项目素材库 — 对应 `REQ-CORE-019`（v0.35）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Assets --device mobile --screens 1 --no-shot`；本地 OpenAI 桩通道（端口 3995）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/{id}/assets` 传一个 `viewBox="0 0 120 60"` 的 SVG（multipart，字段 `file`） | `201`，`asset.width/height` 为 120/60，`asset.url` 形如 `<预览域>/a/<projectId>/<assetId>` |
| 2 | 直接 `GET asset.url`（不带任何签名） | `200`，`Content-Type: image/svg+xml`，`Cache-Control` 含 `immutable` |
| 3 | 传一个 `.txt` | `422 /errors/validation`，消息点名只支持哪几种类型 |
| 3b | 把一个真 webp 改名成 `.png` 上传；再传一个 `viewBox="0 0 1.2.3 60"` 的 SVG 与一个 `viewBox="0 0 99999999999 100"` 的 SVG（v0.38） | 三次都 `201`、无 500：改名那个 `mediaType=image/webp`（按正文魔数认，不信浏览器按扩展名给的 `Content-Type`）且预览域回 `Content-Type: image/webp`；坏 `viewBox` 记 `0×0`，越界的夹到 `100000×100` |
| 3c | 向空项目并发提 60 次上传（v0.38） | 50 个 `201` + 10 个 `422`（消息点名每项目最多 50 个），`GET …/assets` 实得 50 条——「数 + 插」在同一事务里且先锁项目行，并发绕不过上限 |
| 4 | 用桩通道对该屏发一条改屏指令 | 作业成功；桩收到的 **system 前缀**含 `PROJECT ASSETS` 与第 1 步那个 URL |
| 5 | 读 `GET /v1/projects/{id}` | 响应含 `assets[]`（与素材接口同一份，风格指南卡片与面板都用它） |
| 6 | 看画布左上的风格指南卡片 | 底部有品牌素材行（`guide-assets`），瓦片按素材亮度选底（`asset-on-light` / `asset-on-dark` / `asset-thumb`），图能加载 |
| 7 | 打开设计系统面板的素材区（`assets-panel`） | 列出 1 项（`asset-item`），缩略图 `naturalWidth > 0`（展示用 `<img>` 不带 `crossOrigin`：`/a/` 的 ACAO 是常量 `webOrigin`，加了就在别的 origin 下整张图不显示） |
| 7b | 往 `assets-panel` 上拖一个 PNG（dragover → drop）；再拖一个 `text/plain` 文件（v0.38） | 拖入态：`assets-panel[data-dropping]`、虚线外框、标题槽位就地换成「松手上传到这个项目」；放下后列表多出该文件、toast「已上传「…」」、拖入态复位；非图片被就地挡住并说明「有 1 个文件不是 SVG / PNG / JPEG / WebP，已跳过」；「上传」按钮始终可用（键盘等价入口没被拖拽取代） |
| 8 | 点该项的删除（`asset-delete`），确认弹窗点「删除」 | 确认文案点明「已经用到它的屏会变成裂图」；toast「素材已删除」；列表与风格指南卡片同时少一项；再 `GET asset.url` 返回 404 |

后置：无（素材随项目删除一并清理）。

#### `TC-CORE-037` 项目重命名 — 对应 `REQ-CORE-002`（v0.40）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name RenameMe --device mobile --screens 1 --no-shot`；打开该项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开项目切换器，鼠标移到该项目那行 | 垃圾桶左边多一个重命名键（`rename-project`，`opacity` 为 1），`aria-label` 写明「重命名项目「RenameMe」」 |
| 2 | 点重命名键 | 该行的名字就地变成输入框（`rename-input`），默认值是原名、自动获得焦点；下拉没有因为这一点而关闭、也没有切走项目 |
| 3 | 在输入框里打字 | 字打得进去（Radix Select 的 typeahead 被拦住，不会把按键吃掉当成跳项） |
| 4 | 按回车 | toast「已改名为「…」」；`GET /v1/projects/{id}` 的 `name` 已更新；当前项目时顶栏与标签页标题同步变 |
| 5 | 再进一次编辑态，改几个字后按 `Esc` | 放弃：库里的名字不变，输入框收回成普通文字 |
| 6 | 再进一次编辑态，清空后失焦 | 空名当放弃，不报错、不改库 |

后置：无。

#### `TC-CORE-038` 设计预设 — 对应 `REQ-CORE-021`（v0.40）· 级别: 回归 · 执行者: AI

前置：一个带品牌色板与至少 1 个素材的项目（可用 `TC-CORE-035` 的素材 + `TC-EDIT-010` 的色板构造）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 设计系统面板 → 预设区（`presets-panel`）→「存为预设」 | 弹出取名对话框（`preset-save-dialog`），「连素材一起存」（`preset-with-assets`）默认勾上 |
| 2 | 取名后保存 | 列表出现该预设（`preset-item`），副标题写「N 个素材 · <字体> · <日期>」；`GET /v1/design-presets` 里 `assetCount` 与项目素材数一致、`palette` 非空 |
| 3 | `POST /v1/projects` 带 `presetId` 建一个**桌面**项目 | 新项目的 `tokens.colors.primary`、字体、`designMd` 与源项目一致，素材被复制了同样数量（设备形态不影响预设） |
| 4 | 在一个默认配色、**有屏**的项目里点「套用」→ 确认 | toast「已套用「…」」并写明复制了几个素材；设计系统 `version+1`、色板与源一致；随后弹出「回刷所有屏？」（`ds-apply-ask`） |
| 5 | 同样的套用发生在 **0 屏**项目 | 不弹回刷（没有屏可刷） |
| 6 | 删除该预设 | 列表少一项；第 3、4 步那两个项目的设计系统与素材**不受影响**（套用是按值复制） |

后置：删掉临时项目与预设。

### CORE · 生成与画布

#### `TC-CORE-005` 一句话生成初始多屏并落到画布 — 对应 `REQ-CORE-003` · 级别: 冒烟 · 执行者: 皆可

前置：打开空项目 `Demo Mobile`（真实 LLM）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 底部输入框输入「做一个宠物社交 APP」，发送 | 对话区出现用户消息与助手占位消息；画布出现 ≥ 3 张占位卡片并带进度指示；API `POST /v1/projects/<id>/messages` 返回 202 含 `job.status=queued` |
| 2 | 等待至多 90 s | 画布出现 ≥ 5 张截图卡片（手机比例 390×844），助手消息回填文本并列出受影响屏；作业事件流收到 `succeeded` |
| 3 | curl 依次 `GET /v1/screens/<每屏>/revisions/<current>` 并下载 HTML | 每屏 HTML 含 `data-qid` 属性；无匹配 `#[0-9a-fA-F]{6}` 的裸色值出现在 `<body>` 内；`lintReport.passed` 为 true |
| 4 | curl `GET /v1/me/usage` | `screens` 增加了本次屏数，`tokensIn`、`tokensOut` 均大于 0 |

后置：无。

#### `TC-CORE-006` 供应商持续故障导致作业失败且已产出屏保留 — 对应 `REQ-CORE-003` · 级别: 回归 · 执行者: 皆可

前置：以 `LLM_STUB=503 pnpm dev:worker` 重启 worker；打开空项目 `Demo Desktop`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 发送「做一个记账网站」 | 作业创建成功（202） |
| 2 | 等待至多 60 s | 助手消息显示失败原因并提供「重试」按钮；作业事件流收到 `failed`；curl `GET /v1/jobs/<id>` 返回 `status=failed`、`output.errorClass=provider` |
| 3 | 查看 worker 日志 | 对该作业的 LLM 调用共 3 次（首次 + 2 次退避重试） |
| 4 | 恢复 worker（去掉 `LLM_STUB`），点「重试」 | 新作业创建，完成后画布出现屏幕 |

后置：确认 worker 已恢复真实模式。

#### `TC-CORE-020` 生成结果对标 Stitch 人工评审门 — 对应 `REQ-CORE-003` · 级别: 回归 · 执行者: 人工

前置：准备 5 条需求描述（例：宠物社交 APP、记账网站、健身打卡 APP、二手书交易网站、冥想 APP）；Stitch 账号可用；Quilt 已按 §3 就绪。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 同一需求分别在 Stitch 与 Quilt 各生成一次，截屏保存到 `docs/test-runs/` | 两边各得到 ≥ 5 屏 |
| 2 | Owner 盲评每条需求：跨屏一致性（导航栏、间距节奏、色彩）、完成度、画布手感，判定「不输 / 输」 | 5 条中 ≥ 3 条判定「不输」 |

后置：评审结论与截图路径登记到执行记录明细。

#### `TC-CORE-007` 拖动屏幕后位置持久化 — 对应 `REQ-CORE-004` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Layout --device mobile --screens 3`；经 `POST /v1/projects/{id}/components` 建共享组件 `Footer`（`{name, html}`）并 `PATCH /v1/components/{id}` 摆到 (1410, 0)（第 3 屏右侧同一行）；打开该项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 用鼠标把第 1 屏卡片拖到画布右侧空白处并松开 | 空闲时画布与卡片上的指针都是箭头（`cursor: default`）；拖动中卡片上是握拳（`grabbing`），松开回箭头；卡片停在新位置；网络面板出现 `PATCH /v1/screens/<id>` 返回 200，body 含新的 `x`、`y` |
| 2 | 滚轮缩小到 25%，再按住空格拖拽平移 | 按住空格时画布指针变抓手（`grab`），拖动中是握拳（`grabbing`），松开空格回箭头；画布随之缩放平移，卡片相对位置不变 |
| 3 | 刷新页面 | 第 1 屏卡片仍在新位置；curl `GET /v1/projects/<id>` 中该屏 `x`、`y` 与步骤 1 返回一致 |
| 4 | 点第 1 屏，`Shift` 点第 2 屏与组件卡 `Footer` 加选；按住第 2 屏卡片拖动一段距离后松开（v0.47 多选批量移动） | 拖动中第 1、2 屏与组件卡都标 `dragging`；松开后三者的 `x`、`y` 各加同一个位移，第 3 屏不动；`PATCH /v1/screens/{id}` × 2 与 `PATCH /v1/components/{id}` × 1 各返回 200，`GET /v1/projects/{id}` 读回的位置一致 |
| 5 | 不拖，直接点一下第 2 屏卡片 | 选择收成只有第 2 屏（第 1 屏与组件去选）——按在已选中的卡片上按下时不换选择，松手没拖过才收 |
| 6 | 按 `⌘Z`（焦点不在输入框） | 第 1、2 屏与组件整组回到第 4 步之前的位置，toast「已撤销移动」，`GET /v1/projects/{id}` 同步还原 |
| 7 | 滚轮平移 + 缩放画布到一个新位置，等 1 s，刷新页面；逐帧采样 `.world` 的 `transform`（v0.53 视图位置留存） | `localStorage['quilt:view:<projectId>']` 里有 `{x,y,zoom}`；刷新后 `.world` 的 transform 与刷新前**完全一致**，且首 30 帧里**只出现一个 transform 值**（存过镜头就不再做适配动画，看不到「先到初始位置再跳」）。手动把该项改成 `{"zoom":9}` 或非 JSON 后刷新，画布回默认取景且不报错；按 `F`（适配视图）仍能重新装进视野 |

后置：无。

#### `TC-CORE-008` 100 屏截图画布平移缩放帧率 — 对应 `REQ-CORE-004` · 级别: 边缘 · 执行者: AI

前置：`pnpm seed:project --name Big --device mobile --screens 100`；打开该项目；Playwright 已开启 CDP 性能采样。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 等待画布首屏加载完成 | 视口内卡片显示截图；网络面板中 `img` 请求数小于 100（视口外卡片未加载图片） |
| 2 | 连续 10 s 执行平移与缩放（每 100 ms 一次滚轮或拖拽） | 采样帧率平均 ≥ 55 fps；期间无长任务超过 100 ms |
| 3 | 平移到之前视口外区域 | 新进入视口的卡片在 500 ms 内显示截图 |

后置：无。

#### `TC-CORE-023` 画布浮层外壳与快捷键 — 对应 `REQ-CORE-004` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name ShellCheck --device mobile --screens 4`；打开该项目，视口 1440×900。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 观察画布页 | 顶栏、右侧竖排工具栏、左侧对话记录面板、底部输入框四处浮层两两不重叠，画布铺满其下 |
| 2 | 读顶栏的计算样式 | 顶栏自身无底色、无底边线、无 `backdrop-filter`，`::before` 是自上而下的线性渐变且高于内容行；在遮罩下半段取 `elementFromPoint` 命中的不是顶栏（不拦指针） |
| 3 | 量工具栏每个按钮的命中盒与 Tab 序 | 命中盒均 ≥ 44×44；`tabindex=0` 的恰好 1 个；聚焦后按 ↓ 焦点移到下一个工具 |
| 4 | 悬停「补链」与「连线」工具 | 提示出现在工具栏左侧、完整可见不被裁切，含该工具的作用说明；有快捷键的工具在提示里标出按键 |
| 5 | 依次按 `F` / `L` | 分别触发适配视图、切换连线显示（`toggle-links` 的 `aria-pressed` 翻转）|
| 6 | 单独按 `D` / `T`，再按 `⌥D` / `⌥T`；另按 `⌘E` | 单键不开任何面板（URL 无 `panel=`）；带 `⌥` 才分别打开设计系统、本机 agent 面板，面板标识进 URL `?panel=`；`⌘E` 开启选择元素模式（不必先选中屏），再按一次退出 |
| 7 | 点进底部输入框，键入 `dlt` | 输入框内出现「dlt」；不触发任何工具，URL 无 `panel=` |
| 8 | 在输入框填入 12 行文本 | 输入框随内容增高到上限后内部滚动（`scrollHeight > 盒高` 且盒高 ≤ `max-height`），不顶开外框 |
| 8b | 在输入框键入「草稿」，焦点仍在输入框内按 `⌘/`；再按 `⌘/` | 第一次：输入框（`form.composer`）不可见，底部不留任何浮层（画布底部 1rem 以上 `elementFromPoint` 命中的是画布），安全区探针（`safe-area`）底边下移 > 100 px；第二次：输入框回来、内容仍是「草稿」、光标落回输入区、安全区底边复原 |
| 8c | 点工具栏「收起输入框」（`toggle-composer`），再点同一工具（此时标「显示输入框」） | 工具栏与 `⌘/` 是同一开关：收起后草稿仍在，工具的 `aria-pressed` 跟着显隐翻转 |
| 8d | 双击一屏进入交互；按 `⌘/`；再按 `⌘/`；按 `Esc` 退出 | 进入交互后输入框自动收起；聚焦期间 `⌘/` 可临时叫出、再按收回；退出后输入框回到进入前的显示状态 |
| 9 | 点对话记录头部（「折叠对话记录」）下收，再刷新页面，再点横条（「展开对话记录」）上拉 | 面板贴左下角、底部对齐（`chat-dock` 的盒子在视口下半部、贴左缘）；折叠后只剩头部横条（`data-state=collapsed`，无 `role=log`），折叠态首帧即保持、无展开态闪现；点横条重新展开出现消息列表。**折叠与重新展开都不移动底部输入框**（横向落点变化 < 1 px）|
| 9b | 按 `⌥D` 滑出右侧面板，再按 `⌥D` 收回 | 输入框可以让位但不被压住：右缘不越过面板左缘，且与面板之间只剩外壳本来的 1rem 间距（不过度退让）；收回后回到原位。输入框左右留白相等，即压在视口正中 |
| 10 | 发起一次生成，作业进行中时按 `Esc`（非聚焦态、无弹窗） | 作业进行中输入框照旧可输入（v0.36 起不禁用），输入框上方出现在跑作业行（`running-job`）并带取消键；`Esc` 取消最新那一个作业（转 cancelled），该行随之消失（多个在跑时的逐行取消见 `TC-CORE-036`）|
| 11 | 视口切到 390×844 | `documentElement.scrollWidth ≤ clientWidth`（无横向滚动）；工具栏底部仍在视口内；对话记录（横条或展开面板）停在输入框上方，两者盒子不重叠（输入框在窄视口下工具条折行、变高，安全区底部占位跟着实际高度走） |
| 12 | 在「造」态（不选中任何屏）逐个视口量工具条：对 `.composer-bar` 里每对 `[data-testid]` 控件做矩形相交；再点动词段控切到「聊天」，用 `requestAnimationFrame` 逐帧采样 `.composer` 的宽 / 高（v0.50 工具条几何） | ① 任意两个控件相交面积为 0（此前通道名一长，`add-image` 就压在 `count-group` 上 21×32 px、屏数的「1」点不到）；② 宽度等于工具条一行排满所需（造态实测 709 px，工具条右缘余量 0），不是固定值；③ 切模式时宽度**单调变化、有中间帧**（不是硬切），而**高度全程只有一个值**（此前宽度动画中途工具条折成两行又弹回，高度来回跳）；④ 可用宽度装不下时 `.composer` 带 `data-bar="wrap"`，允许折成两行，控件仍全部可见可点 |

后置：无。

#### `TC-CORE-024` 多选屏幕作为对话上下文 — 对应 `REQ-CORE-006` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name MultiSel --device mobile --screens 4`；打开该项目并按「适配视图」。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 单击第 1 屏，再按住 Shift 单击第 3 屏 | 两屏都带选中态；底部输入框列出两个可移除的目标标签，并显示「目标：2 屏」 |
| 2 | 点其中一个标签上的移除按钮 | 该屏取消选中，只剩 1 屏；输入框恢复单屏文案「目标：<名> <路由>」 |
| 3 | 在画布空白处按住拖出覆盖全部 4 屏的选框 | 拖拽过程中出现选框，且**尚未松手时命中的 4 屏就已高亮**（不是松手后才亮）；松手后 4 屏全部选中，顶栏显示「已选 4 屏」 |
| 4 | 按 `⌘A` | 4 屏全部选中（与步骤 3 一致）；输入框动词行（`verb-line`）为「改全部 4 屏」 |
| 5 | 发送一条修改指令 | `POST /v1/projects/<id>/messages` 的 `targetScreenIds` 等于选中的 4 屏；助手消息的 `affectedScreenIds` 与之一致 |
| 5b | 作业进行中点画布空白处，再点目标区「清空」（`clear-targets`） | 点空白只清画布高亮：4 枚目标标签（`target-chip`）仍在、动词行仍为「改全部 4 屏」（`REQ-CORE-006` 目标标签只被点屏 / × / 清空改变）；点「清空」后标签为 0、动词行变为「造 …」 |
| 6 | 选中 2 屏，查看工具栏 | 出现「删除 2 屏」，不出现「修订」（修订链是单屏概念）；点删除后确认框标题为「删除选中的 2 屏？」 |

后置：无。

#### `TC-CORE-025` 生成通道可选 — 对应 `REQ-CORE-011` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Runner --device mobile --screens 2`；打开；记录 `GET /v1/me/usage`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `GET /v1/runners` | 返回用户自己配的云端通道（`source=channel`，`pnpm seed` 按 `.env` 的 `GEMINI_API_KEY` 建了一条已验证的 Gemini）与「交给本机 agent」两类，没有「系统预置」（v0.34）；响应中无任何凭据形态的串（`sk-…`/`AIza…`/PEM）；未验证 / 验证失败的通道照样列出但 `available=false` 且带 `unavailableReason` |
| 2 | 打开画布，看输入框工具条左端的通道选择器 | 触发器的 `data-value` 等于 `GET /v1/runners` 返回的 `default`，且显示该项名称 |
| 3 | 点开选择器 | 只列 `available=true` 的通道，项数等于清单中可用项数；不可用项不出现（原因在设置页看，`REQ-CORE-013`）；仍按「云端模型 / 本机 agent」分组；末尾有「管理通道…」入口；每项只有厂商图标 + 显示名——取一个显示名不含模型 id 的可用通道，其模型 id（如 `gemini-3.8-flash`）不出现在任何下拉项里（模型 id 在设置弹层看，见 `TC-CORE-028` 第 7 步） |
| 4 | 列表开着时按 `Esc`；再选中一屏、点开列表、按 `Esc` | 列表关闭、焦点回到触发器；画布上那一屏仍处于选中态（`Esc` 没有漏给画布） |
| 5 | 点开列表，选另一个可用通道，然后刷新页面 | 触发器 `data-value` 变为所选项；刷新后仍是所选项（偏好跨会话记忆） |
| 6 | 选一个可用的云端模型并发送 | `POST /messages` 返回 202，作业 `input.runner` 带上该 `driver` 与 `model` |
| 7 | `GET /v1/agent/sessions`；再直接 `POST …/messages` 两次，`runner` 分别为 `{kind:"agent",tool:"claude-code"}`（缺 sessionId）与带一个不存在的 sessionId | 会话列表接口返回 `items` 数组（`API-AGENT-010`）。本机有 `claude` 时：两次都在建作业前返回 400 `/errors/validation`，后者的错误信息为「会话已关闭或不存在，重新选一个」；`GET /v1/projects/<id>/jobs?runner=agent` 条数不变（被拒的发送不留作业）。投递、回执、屏锁、不记用量、不占输入框见 `TC-AGENT-009`。本机没有 `claude` 时：清单里该项 `available=false` 并带 `setupHint`，发送返回 400 `/errors/validation` 且错误信息给出安装步骤 |

后置：步骤 6、7 产生的作业随即取消。

#### `TC-CORE-026` 品牌接入一致性 — 对应 `REQ-CORE-004`（§13.1）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Brand --device mobile --screens 2`；视口 1440×900。品牌基准值取自 `brand/Quilt-Brand-Design/brand.json` 与 `qa/mechanical.json`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `pnpm seed --empty` 后打开 `/`（PAGE-FIRST，首次运行的第一屏），量品牌符号 | `naturalWidth > 0`（资产真的取到）；渲染边长 ≥ 64 px（品牌下限）；外层安全区 = 边长的 1/8 |
| 2 | 在同一页读字标的计算样式，再 `pnpm seed` 打开画布看顶栏 | `document.fonts.check` 确认 Space Grotesk 已加载；字标 `font-family` 为 Space Grotesk、`font-weight` 500、字距 = −0.03 em。画布顶栏里没有 `.wordmark`，左上第一个元素是项目切换器（品牌不上画布顶栏，§13.1） |
| 3 | 读外壳 token 与对比度 | `--color-panel` = 品牌 Ink `rgb(20, 32, 51)`；`--color-accent` = 界面蓝 `rgb(53, 111, 214)`；正文/次级/强调/动作色前景六组配对全部 ≥ 4.5:1 |
| 4 | 读 `link[rel=icon]` 并请求它 | href 指向 `/brand/`，返回 200 |
| 5 | 读画布上的风格指南卡片 | 不出现 Space Grotesk——工具品牌字体不得渗进用户项目的设计系统（§13.1 边界） |

后置：无。

#### `TC-CORE-027` 参考图输入 — 对应 `REQ-CORE-012` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name ImgRef --device mobile --screens 2 --no-shot`；打开该项目。用例只验通道，不真跑生成（带图的真实出屏见 `RUN-051` 执行记录）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/projects/<id>/attachments`，分别传 `image/svg+xml` 与 50 MB | 两者都返回 400 `/errors/validation`——类型与大小在签发签名 PUT 时就挡住，不等正文传完 |
| 2 | curl `GET /v1/runners` | 每一项都带 `vision` 布尔标记；至少有一个 `vision=true` 且可用的云端通道 |
| 3 | 若通道清单中存在 `vision=false` 的项（v0.24 起当前没有，脚本自动跳过），切过去再选图 | 「加参考图」按钮为 `aria-disabled`；即使绕过按钮直接选文件也贴不上（缩略图数为 0），提示换通道 |
| 4 | 切到支持视觉的通道，选 1 张图；再选 4 张；移除 1 张 | 出现缩略图；上限 4 张、超出被截断；可逐张移除 |
| 5 | 填一句指令并回车 | 请求体带 3 个 `attachmentIds`；作业 `input.imageKeys` 同样是 3 个；对话记录里能看到这 3 张缩略图 |
| 6 | 若存在 `vision=false` 的通道（当前没有，脚本自动跳过），直接 curl 发消息带 `attachmentIds` 并指定它 | 返回 400 `/errors/validation`——前端护栏被绕过时服务端仍拒，不静默丢图 |

后置：步骤 5 产生的作业随即取消。

#### `TC-CORE-028` 生成通道可配置 — 对应 `REQ-CORE-013` · 级别: 回归 · 执行者: AI

前置：服务端 `.env` 已配置 `QUILT_SECRETS_KEY`；`pnpm seed:project --name Chan --device mobile --screens 1 --no-shot`；本地起一个 OpenAI 兼容桩（`tests/e2e/openai-stub.ts`，只认 Key `good-key-0001`，回放该屏当前 body 并加标记）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/channels` 建 OpenAI 兼容通道但不给端点 | 400 `/errors/validation` |
| 2 | 建通道（端点指向桩、模型 `stub-1`、Key `good-key-0001`） | 201，`status=unverified`，响应只含 `apiKeyHint=0001`、不含明文；`GET /v1/runners` 里该项 `source=channel`、`available=false` |
| 3 | `POST /v1/runners/channel:<id>/probe` | `ok=true`；目录里该项 `available=true`、`status=verified` |
| 4 | 用该通道发一条改屏消息 | 202；作业成功，`input.runner={kind:"channel",channelId}`；桩收到 `model=stub-1` 的请求；`GET /v1/me/usage` 的 `tokensIn` 增加 ≥ 42（按通道记账）；屏的新修订含桩标记 |
| 5 | `PATCH` 把 Key 改成错的，再探测 | 改后 `status=unverified`；探测 `ok=false` 且 `error` 含供应商的 401；目录里 `available=false`、原因含「验证失败」；`GET /v1/channels` 与更新响应均不含任何 Key 明文 |
| 6 | `DELETE` 该通道，再用它发消息 | 204；发消息返回 404 |
| 7 | 打开 `/p/<id>?settings=runners`，看设置弹层（`settings-modal`） | 弹层分栏：左栏 2 个 `role=tab`（本月用量 / 生成通道），「生成通道」为选中态；把焦点放到该 tab 按 `↑` 切到「本月用量」且 URL 变为 `settings=usage`，按 `↓` 切回。右栏的管理器（`channel-manager`）分「本机 agent / 我的通道」两组（v0.34 起没有系统预置，云端通道都是自己配的）；取一个显示名不含模型 id 的通道，其行内写出了模型 id（画布下拉不显示，这里是它的家）；每行有厂商图标、状态药丸（`runner-status`）与「验证」（`probe-runner`）；本机通道行可展开配置步骤（`setup-hint`） |
| 7b | 建一条「本机 Claude 订阅」类型的通道，不填 Key；再改它的模型名 | 201 且 `apiKeyHint=null`（这类通道用本机的 `claude` 登录态，没有 Key）；改模型名后 `status` 回 `unverified`；其它类型缺 Key 仍返回 400 |
| 8 | 点「添加通道」（`add-channel`），面板（`channel-dialog`）内连按 Tab 若干次，再按 Esc | 焦点始终在面板内循环；Esc 只关内层面板：设置弹层仍开着、背景 `#root` 仍是 `inert`（弹层叠弹层按引用计数隔离），焦点回到「添加通道」按钮。选 OpenAI 兼容 → 厂商预设，端点自动填入；填模型与 Key 点「保存并验证」→ 行内出现「已验证」 |
| 9 | 回到画布看输入框下拉 | 只列 `available=true` 的通道，每项带厂商图标，末尾有「管理通道…」（`manage-channels`）入口打开设置弹层；未验证 / 验证失败的通道不出现 |

后置：删除用例创建的通道；桩服务关闭。

#### `TC-CORE-029` 锚点造屏：一屏三版候选、造一组反向连线 — 对应 `REQ-CORE-014`、`REQ-CORE-003`、`REQ-CORE-015`、`REQ-CORE-016` · 级别: 回归 · 执行者: AI

前置：服务端 `.env` 已配置 `QUILT_SECRETS_KEY`；`pnpm seed:project --name Blank --device mobile --screens 1 --no-shot`；本地起 OpenAI 兼容桩（`tests/e2e/openai-stub.ts`，Key `good-key-0002`）：单屏规划提示（含 `Requested screen:`）固定回 `{"name":"Order Detail","route":"/order-detail","purpose":"show one order",…,"links":[],"entryFrom":null}`；整组规划提示（含 `Request:`）回 `{"entryFrom":"/s1","screens":[Cart /cart, Checkout /checkout]}`；出屏 / 改屏提示回放种子屏 body 并编号；以 API 建好指向桩的通道并探测通过。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开画布，无目标时看输入框；在空白处双击；点锚点药丸上的 × | 动词行（`verb-line`）为「造 1 屏 · 自动摆放」；双击后画布出现虚线锚点（`anchor`）、焦点落在输入框（`#chat-input`）、目标区出现「新屏 · 此处」药丸（`anchor-chip`）、动词行为「造 1 屏 · 此处」；× 撤掉锚点 |
| 2 | 点空白让焦点离开输入框，按 `⌥G`；再点工具栏「新建屏幕」（`new-screen`） | 两个入口都在可见区中心放锚点；「清空」（`clear-targets`）撤掉 |
| 3 | 再次双击同一空白点，通道下拉选桩通道，版数选 3（`versions-3` 的 `aria-checked=true`），填描述，回车 | 动词行为「造 1 屏 × 3 版 · 此处 = 7 次调用」（3 × 2 + 规划 1）；请求体无 `targetScreenIds`、`count=1`、`versions=3`、`anchor` 等于双击点的画布坐标 |
| 4 | 等 `kind=generate` 作业结束后 `GET /v1/projects/<id>` 与该屏的修订列表 | **只新增 1 屏**（候选不是独立屏、无 `-2` 后缀）：`/order-detail`、`purpose=show one order`、以锚点为中心（误差 ≤ 2）；3 条修订同 `jobId`、`candidateIndex` 0/1/2、`candidateSettledAt` 为空；`currentRevisionId` = 第 0 版；`ScreenDto.pendingCandidates.count=3`；项目 `exemplarScreenId` = 新屏（首轮默认样板）；桩收到 1 次规划 + 3 次出屏且出屏提示含「does not need to navigate」；画布上造完自动把新屏设为目标：动词行变为「改 1 屏」、目标标签为 Order Detail |
| 5 | 点卡片角标「3 版 · 展开」（`candidate-badge`），在就地展开层（`candidate-stack`）点第 2 格右上角的 ✓「就用这一版」（`adopt-one-1`）；选中该屏按 `⌥R` | 收起态卡片后面叠着错位底板（`cand-ghost`）；展开层 3 格（`candidate-cell`）横向一行：第 1 版留在卡片原位并标「当前」、带 ×「收起」，其余按卡片同尺寸排到右边；每格是该版的活 iframe（`candidate-cell iframe` 3，src 带各自 `rev=`），在格内能滚动；动作是每格上方右缘对齐的浮层图标胶囊；采用后 current 指向 index 1、同批结清、展开层自动收起、角标与底板消失、修订不增；修订面板把 3 版折成一组（`candidate-group` 1）且没有可采用项 |
| 6 | 先点选 `/order-detail` 卡片、在输入框键入一句草稿（目标与草稿都摆好），再 `POST /v1/projects/<id>/messages`（无目标，`count=2`、`versions=1`、`anchor={x:2600,y:400}`、桩通道）——等价于 MCP 或另一个标签页在后台造屏 | 作业成功：新增 `/cart`、`/checkout` 两屏，按流程顺序在同一行向右排开、第一张以锚点为中心；入口屏 `/s1` 多一条修订（反向连线：对入口屏跑了一次补链）；回执含「已生成 2 屏」与「已把「Screen 1」接到新屏」 |
| 6b | 看这一叠在跑作业行与输入框（v0.38） | 页面认领了这个后台作业（`running-job` 出现过、进度兜底写「排队中…」而不是空着）；**作业收口后目标标签仍是 Order Detail 一枚、草稿一字不变**——「造完自动选中新屏」只在目标为空时接管，否则用户手写的指令会被改投到刚造出来的屏上 |

后置：删除用例创建的通道；桩服务关闭。

#### `TC-CORE-030` 改 3 屏出 2 版并整组采用 — 对应 `REQ-CORE-006`、`REQ-CORE-015` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Versions --device mobile --screens 3 --no-shot`；本地起 OpenAI 兼容桩（Key `good-key-0003`，改屏提示回放种子屏 body 并编号）；以 API 建好指向桩的通道并探测通过。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开画布选桩通道，单击一屏后 `⌘A`，版数选 2（`versions-2`） | 动词行为「改全部 3 屏 × 2 版 = 12 次调用」；改的时候不出现屏数控件（无 `count-group`） |
| 2 | 填指令回车，等「已更新 3 屏」 | 请求体 `targetScreenIds` 3 屏、`versions=2`；`GET /v1/projects/<id>` 每屏 `pendingCandidates.count=2` 且三屏 `jobId` 相同；画布上 3 枚候选角标 |
| 3 | 点任一角标；随后点画布空白让焦点离开输入框、按 `⌘A` 全选 | 该屏就地横向展开 2 格（`candidate-cell` 2）；多屏作业每格右上角带 ⧉「采用这一组（3 屏）」（`adopt-group-i`，图标按钮，`aria-label` 带屏数）；**展开期间排列条不在场**（`arrange-bar` 0 个）——胶囊与它争同一条横带且它压在上面，不让位就会把「收起」点成「右对齐」并把新位置落库 |
| 3b | 给三屏各种一条在跑作业（`pnpm seed:job --project <id> --screen <每一屏>`），点「采用这一组」（`adopt-group-1`），再取消这三条作业 | 服务端逐屏跳过（屏上有作业）→ toast「3 屏都跳过了（已在某一版上改过或正在生成），稍后再试或逐屏采用」（错误样式）；**展开层仍在**、三屏 `pendingCandidates` 不变、候选未结清——一屏都没采用就不该报成功、也不该自动收起。部分跳过时文案为「已采用 N 屏，M 屏跳过（已在某一版上改过或正在生成）」，有采用就照常收起 |
| 4 | 点第 2 列列头「采用这一组」（`adopt-group-1`） | 三屏 `currentRevisionId` 都指向各自 `candidateIndex=1` 的修订、候选全部结清、`pendingCandidates=null`；画布角标全部消失；展开层**自动收起**（不必按 `Esc`）、排列条随之回来（三屏仍在选中） |

后置：删除用例创建的通道；桩服务关闭。

#### `TC-CORE-009` 删除屏幕并从画布与地图移除 — 对应 `REQ-CORE-004` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Del --device mobile --screens 3`（第 1 屏链接到第 2 屏）；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 选中第 2 屏，按 Delete 并确认 | 卡片从画布消失；`DELETE /v1/screens/<id>` 返回 204 |
| 2 | curl `GET /v1/projects/<id>/app-map` | 第 1 屏指向原第 2 屏路由的边 `toScreenId` 为 null（断链） |
| 3 | `pnpm seed:job --project <id> --screen <第 3 屏> --status running` 后对第 3 屏按 Delete | 提示「生成中，无法删除」；API 返回 409，`type` 为 `/errors/screen-busy` |

后置：无。

### CORE · 聚焦交互

#### `TC-CORE-010` 双击聚焦后屏内可点按滚动且与主站隔离 — 对应 `REQ-CORE-005` · 级别: 冒烟 · 执行者: 皆可

前置：`pnpm seed:project --name Focus --device mobile --screens 2`（fixture 第 1 屏含一个点击后切换文本的按钮与一个 30 项可滚动列表）；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击第 1 屏卡片 | 卡片位置出现 iframe，其 `src` 主机为 `preview.localhost:3001` 且 URL 含 `t=` 签名参数；卡片外框显示「交互中」标记 |
| 2 | 在 iframe 内点击按钮 | 按钮文本按 fixture 逻辑切换（例如「关注」变「已关注」） |
| 3 | 在 iframe 内滚动列表 | 列表滚动到第 30 项；画布本身不平移 |
| 3b | 在有头 Edge 里量屏内滚动根（`getComputedStyle(documentElement).scrollbarWidth`、`innerWidth - documentElement.clientWidth`、`scrollHeight`/`clientHeight`）（v0.48 预览不露滚动条） | `scrollbarWidth` 为 `none`、槽宽 0（卡片右缘看不到滚动条），同时 `scrollHeight > clientHeight` 且步骤 3 的滚轮照旧滚得动；屏宽等于设备宽（390，不被挤成 375）。无头浏览器默认 overlay 条、槽宽恒 0，这一步在无头下不成立区分力 |
| 3c | 记下预览请求的 `Cache-Control`，按 `Esc` 退出交互后再双击进一次（v0.49 预览不再 immutable） | 响应头是 `no-cache`；第二次聚焦仍走一次真实网络请求（不是 `(disk cache)`）——运行时是每次下发现换的，缓存住等于把 Quilt 自己的代码冻在旧版 |
| 4 | 在 iframe 内执行 fixture 提供的「读取父页 cookie」按钮 | 显示为空字符串（预览域与主站不同 origin；本地版主站本就没有会话 cookie，这一步守的是域隔离） |
| 5 | 按 Esc | iframe 卸载，卡片恢复截图；第 2 屏全程保持截图态 |
| 5b | 重新双击第 1 屏；在 iframe 内点一下（焦点进入预览文档）后按 `⌘E`；再按 `⌘E` | 运行时把 `⌘E` 转发给父页：角标变「选择元素中」；再按一次退出选择元素态、卡片回到静态（v0.34 前焦点在 iframe 里时 `⌘E` 被吞掉） |

后置：无。

#### `TC-CORE-011` 预览签名过期后自动恢复 — 对应 `REQ-CORE-005` · 级别: 边缘 · 执行者: 皆可

前置：同 `TC-CORE-010` 的项目；`pnpm seed:preview-token --screen <第 1 屏> --expired` 得到过期 URL；打开画布并在浏览器内把该屏的预览 URL 替换为过期 URL（Playwright 路由改写或手工在 devtools 中修改）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 直接 curl 过期 URL | HTTP 403，`type` 为 `/errors/preview-token-invalid` |
| 2 | 双击第 1 屏 | 前端在 2 s 内重新请求 `GET /v1/projects/<id>` 取新签名，iframe 用新 URL 加载成功，屏内内容可见，无错误弹窗 |

后置：无。

#### `TC-CORE-032` 聚焦态热更新：屏出新修订不退出交互即更新 — 对应 `REQ-CORE-005` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Hot --device mobile --screens 2 --form`（`--form` 让 /s1 高过一屏、可滚动）；本地起 OpenAI 兼容桩（Key `good-key-0032`，改屏提示回放种子屏 body 并把 `Follow` 改成 `热更新`），以 API 建好指向桩的通道并探测通过；打开项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击 /s1 进交互，把屏内滚到 150 px；记录 iframe `src` | 角标「交互中」；输入框已自动收起 |
| 2 | `⌘/` 叫出输入框，通道选桩，发送「改文案」 | 目标即 /s1（聚焦即选中）；作业完成后**不退出交互**，8 s 内 iframe 内 `#toggle` 文案变为「热更新」；iframe `src` 与步骤 1 相同（未重挂）；`scrollY` 仍为 150（±2）；角标仍「交互中」 |
| 3 | 点 /s1 里的 `href=/s2` 链接（导航栈 s1 → s2），再按 `⌥D` 把种子色改为 `#C2410C` 保存并「回刷所有屏」 | 回刷完成后 iframe 内正显示的 /s2 原地更新：`#toggle` 背景色等于新 primary（`<head>` 变了走整份重写）；`src` 不变；角标仍显示 /s2 |
| 4 | 按 Alt+← 回到 /s1 | /s1 也已是新色（回刷产生的新修订）且文案仍是「热更新」 |
| 5 | 按 Esc | 退出交互，卡片回截图态 |

后置：删除桩通道、关闭桩。

### CORE · 对话迭代与修订

#### `TC-CORE-012` 对话只修改选中屏 — 对应 `REQ-CORE-006` · 级别: 冒烟 · 执行者: 皆可

前置：`pnpm seed:project --name Iter --device mobile --screens 5`；打开；记录 5 屏当前 revisionId（真实 LLM）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 单击选中「/s3」屏，底部输入框输入「把这一页改成分组列表」发送 | 助手占位消息出现；仅 /s3 卡片显示生成中 |
| 2 | 等待至多 60 s | /s3 卡片截图更新；助手消息列出受影响屏仅 /s3；`GET /v1/projects/<id>/messages` 最新助手消息 `affectedScreenIds` 长度为 1 |
| 3 | curl `GET /v1/projects/<id>` | /s3 的 `currentRevisionId` 变化，其余 4 屏 `currentRevisionId` 与前置记录一致 |

后置：无。

#### `TC-CORE-013` 同一屏并发编辑被拒 — 对应 `REQ-CORE-006` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Busy --device mobile --screens 2`；`pnpm seed:job --project <id> --screen <第 1 屏> --status running`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/projects/<id>/messages`，body `{"content":"改一下","targetScreenIds":["<第 1 屏>"]}` | HTTP 409，`type` 为 `/errors/screen-busy` |
| 2 | 在画布选中第 1 屏，往输入框里键入一句 | 输入框照旧可输入（v0.36 起不因有作业在跑而禁用）；发送键 `aria-disabled`，其上方 `send-blocked-reason` 点名「Screen 1」正在改（前端按覆盖屏集预判，后端 409 仍是最终判据，`REQ-CORE-020`）|
| 3 | 同样请求 targetScreenIds 指向第 2 屏 | HTTP 202（未被占用的屏可编辑） |

后置：无。

#### `TC-CORE-036` 并行作业 — 对应 `REQ-CORE-020`（v0.36）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Parallel --device mobile --screens 3 --no-shot`；本地起 OpenAI 兼容桩（`tests/e2e/openai-stub.ts`，端口 3994，Key `good-key-0036`，改屏提示回放种子屏 body 并编号），以 API 建好指向桩的通道并探测通过。两个「一直在跑」的长作业用种子构造（`pnpm seed:job` 的作业不入队，worker 不碰，能稳定停在 `running`）：`seed:job --project <id>`（`kind=generate`，占项目级造屏名额）与 `seed:job --project <id> --screen <Screen 1>`（`kind=edit_screens`，占住 Screen 1）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开画布，看输入框上方 | 在跑作业行（`running-jobs`）出现，恰好 2 行 `running-job`：`data-job-id` 就是那两个作业，按创建时间倒序（改屏那条建得晚，排最上），行文案分别写「造 1 屏」与「改「Screen 1」」并带进度——种子作业没有任何事件，这里验的正是兜底：进度位写「排队中…」而不是空着（v0.38；认领来的作业在下一个实时事件到达前都是这种状态，只剩「造 1 屏」时与卡死不可分辨），每行各有一个取消键（`cancel-job`）；这一叠落在输入框上方（与输入框同一块面板，不另起一层浮层）|
| 2 | 往 textarea 里键入一句，点开通道选择器选桩通道 | 输入框没有被整体锁死：`#chat-input` 不带原生 `disabled`、字打得进去；通道选择器与版数档位（`versions-1`）都不禁用（后端本就允许并行，前端不该因「有作业在跑」上锁）|
| 3 | 不给目标（= 造屏）看发送键，再按 `Enter` | 发送键 `aria-disabled=true`，其上方就地写出理由（`send-blocked-reason`）含「上一批屏还在造」；按 `Enter` 不发出 `POST …/messages`（前端就拦住，不浪费一次 409），草稿原样留着 |
| 4 | 点「Screen 1」卡片（正被改屏作业占着），再按 `Enter` | 同样拦下且点名是哪一屏：`send-blocked-reason` 含「Screen 1」；仍然不发请求、草稿留着 |
| 5 | 点「Screen 2」卡片换成空闲屏 | 放行：`send-blocked-reason` 不存在、发送键没有 `aria-disabled`（造屏 + 改另一屏、改 A + 改 B 都不冲突）|
| 6 | 填指令回车发出（目标 Screen 2），紧接着 `POST /v1/projects/<id>/messages` 对 Screen 3 发第二条 | 两条都 202；发的时候前置那两个作业仍是 `running`——四个作业同时在跑，后端一个都没拦 |
| 7 | 等这两个作业收口 | 两个都 `succeeded`，Screen 2、Screen 3 各多一条含桩标记的修订（各自落地，谁也没顶掉谁）；两个作业的运行窗口真重叠（`max(startedAt) < min(finishedAt)`，不是排队跑） |
| 8 | 点画布空白让焦点离开输入框，按一次 `Esc` | 只取消**最新**那一个（改「Screen 1」那条，它建得晚）：它转 `cancelled`、行消失；另一条（造 1 屏）仍 `running`、行还在——按一次取消一个 |
| 9 | 点剩下那行的 `cancel-job`；再「清空」目标、键入一句 | 那个作业转 `cancelled`，`running-jobs` 整块消失；造屏名额一松，无目标发送立刻恢复：`send-blocked-reason` 不存在、发送键没有 `aria-disabled` |
| 10 | 在第 6~7 步那两个作业还在跑时，读页面里活跃的 `EventSource` 条数（用例脚本在 `addInitScript` 里包一层计数） | 恒为 **1**（只有项目事件流；作业进度走它的 `job_changed` 投影）。浏览器对同源 HTTP/1.1 只给 6 条并发连接且跨标签页共用，按作业各开一条的话三个标签页各跑一个作业就占满、普通请求全部排队 5 s 不返回 |

后置：删除用例创建的通道；桩服务关闭；前置种的两个作业已在步骤 8、9 取消（脚本收尾再兜一次）。

#### `TC-CORE-014` 回溯到任意历史版本并保留完整链 — 对应 `REQ-CORE-007` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Hist --device mobile --screens 1 --revisions 6`（seq 1..6，各版 HTML 标题含版本号）；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 选中该屏，打开修订面板 | 列出 6 个修订，倒序，当前为 seq 6；每条标出「派生自第 n 版」（修订树，`REQ-CORE-007`） |
| 2 | 点 seq 2 的「回溯到此版」并确认 | 面板新增 seq 7 并标为当前；卡片截图在 10 s 内更新为版本 2 的画面；API 返回 201，`revision.sourceKind` 为 `restore`、`parentRevisionId` 为 seq 6 |
| 3 | curl `GET /v1/screens/<id>/revisions` | 共 7 条，seq 1..7 全在，seq 7 的 HTML 与 seq 2 相同 |

后置：无。

#### `TC-CORE-015` 回溯时版本已变化被拒 — 对应 `REQ-CORE-007` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-CORE-014` 的项目（未执行过回溯，当前 seq 6）；记下 seq 5 与 seq 6 的 revisionId。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/screens/<id>/revisions/<seq2>/restore`，body `{"expectedRevisionId":"<seq5>"}` | HTTP 409，`type` 为 `/errors/revision-conflict` |
| 2 | curl `GET /v1/screens/<id>/revisions` | 仍为 6 条，未创建新修订 |
| 3 | 同请求改用 `expectedRevisionId=<seq6>` | HTTP 201 |

后置：无。

#### `TC-CORE-039` 聊天模式 — 对应 `REQ-CORE-023`（v0.45）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Chat --device mobile --screens 2 --no-shot`；本机 `claude` 已登录；账号里暂无 `agent-sdk` 通道（`pnpm seed` 已清）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/<id>/messages` 带 `mode:"chat"`、`runner:{kind:"model",driver:"gemini",…}`；再发一条不带 `runner` | 都 `400 /errors/validation`，`path=runner`，后者消息点名「本机 Claude 订阅」；随后经 `POST /v1/channels` 建 `kind=agent-sdk` 通道并 `probe` 通过 |
| 2 | `pnpm seed:job --project <id> --kind chat` 种一个在跑的 chat 作业，再发一句 `mode:"chat"` | `409 /errors/screen-busy`（一个项目一条会话，回合串行）；取消种子作业 |
| 3 | 发「这个项目现在有哪些屏？每张各是做什么的？只回答，不要改任何东西。」 | `202`，作业 `kind=chat`；≤ 7 min 内 `succeeded`；助手回执点到两屏（名字或路由），`affectedScreenIds` 为空；两屏 `currentRevisionId` 不变 |
| 4 | 发「把刚才说的第一张屏（/s1）的标题改成「Hello Chat」，其他都别动。」 | `succeeded`；/s1 出新修订 `sourceKind=agent_ingest`、`jobId` = 本作业，HTML 含 `Hello Chat`；/s2 `currentRevisionId` 不变；回执 `affectedScreenIds` 只含 /s1 |
| 5 | 打开画布，点段控 `mode-chat`；打开通道下拉；在输入框发「第二张屏（/s2）是做什么的？只回答，别改。」 | `count-group` / `versions-group` 不在；动词行「聊 · 整个项目」；`runner-select` 自动落到该 agent-sdk 通道，下拉只有它 + 「管理通道…」；在跑作业行写「聊「…」」并随工具调用更新进度；作业成功后对话记录里出现回执正文；刷新后 `mode-chat` 仍 `aria-checked` |

后置：无（SDK 会话文件留在 `~/.claude/projects/` 下，不影响别的用例）。

### CORE · 用量与恢复

#### `TC-CORE-016` 台账无硬上限且在途预估可见 — 对应 `REQ-CORE-008` · 级别: 回归 · 执行者: 皆可

前置：打开 `Demo Mobile`；`pnpm seed:job --project <id> --status running --tokens 3000 --screens 400` 预写一笔超过旧上限（300 屏）的台账并取消该作业。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `GET /v1/me/usage` | `screens ≥ 400`；响应无 `quota` / `resetAt` 字段 |
| 2 | 对另一个种子项目（`seed:project --name Usage --screens 1`）curl `POST /v1/projects/<id>/jobs`，body `{"kind":"generate","input":{"prompt":"x","count":1,"versions":1}}`，带 `Idempotency-Key` | HTTP 202（v0.32 起台账只记不拦），随即取消（进程内队列即刻开跑，取消前可能已落一屏，所以不用 `Demo Mobile`） |
| 3 | `seed:job --status queued --input '{"prompt":"x","count":4,"versions":2}'`；`GET /v1/me/usage` | `inflight.screens` 比之前多 8（在途预估从 queued 作业的 payload 派生） |
| 4 | 取消那个 queued 作业后再 `GET /v1/me/usage` | `inflight.screens` 回到之前的值 |

后置：`pnpm seed` 重置。

#### `TC-CORE-022` 设置弹层「本月用量」按驱动分列并给出 MCP 接入命令 — 对应 `REQ-CORE-008`、`REQ-AGENT-002` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-CORE-016`（台账里至少有一笔带驱动的记录）；打开 `Demo Mobile`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `/p/<id>?settings=usage` | 设置弹层（`settings-modal`）落在「本月用量」节：三格汇总（`usage-totals`：生成屏数 / 输入 token / 输出 token）与 `GET /v1/me/usage` 一致；按驱动分列的表（`usage-by-driver`）行数等于 `byDriver.length`；弹层里没有 `role=meter` 进度条、没有「/300」这类上限文案 |
| 2 | 切到「生成通道」一节，看底部「让本机 agent 接入 Quilt（MCP）」 | 一行可复制命令 `claude mcp add --transport http quilt http://<本机 API>/mcp`（`mcp-add`），点「复制」提示已复制 |

后置：无。

#### `TC-CORE-017` 取消运行中作业仍记用量 — 对应 `REQ-CORE-008` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:job --project <Demo Mobile id> --status running --tokens 3000` 得到 jobId；记录 `GET /v1/me/usage` 当前 tokens。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/jobs/<jobId>/cancel` | HTTP 200，`job.status` 为 `cancelled` |
| 2 | curl `GET /v1/me/usage` | `tokensIn + tokensOut` 比前置记录多 3000；`screens` 不变 |
| 3 | 再次 curl 取消同一作业 | HTTP 409，`type` 为 `/errors/job-finished` |

后置：无。

#### `TC-CORE-018` 刷新后画布、对话、修订完整恢复 — 对应 `REQ-CORE-009` · 级别: 冒烟 · 执行者: 皆可

前置：`pnpm seed:project --name Persist --device mobile --screens 8 --revisions 4`（附带 12 条对话消息由种子写入）；打开并拖动第 2 屏到新位置。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 刷新页面 | 8 张截图卡片按之前位置显示（第 2 屏在新位置）；对话区显示 12 条消息顺序不变 |
| 2 | 打开第 1 屏修订面板 | 列出 4 个修订，当前为 seq 4 |
| 3 | 新开一个标签页从 `/` 进入，再打开该项目 | 与步骤 1、2 观察一致（本地版无会话，`/` 直接落到最近项目；顶栏左上是项目切换器） |

后置：无。

#### `TC-CORE-019` 风格指南卡片与 token 同步 — 对应 `REQ-CORE-010` · 级别: 回归 · 执行者: 皆可

前置：打开 `Demo Mobile`（seedColor `#3B5BDB`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 查看画布左上 | 存在风格指南卡片：色板区含 `primary` 色块、字阶样例、间距与圆角示意、按钮/卡片/输入框组件样例 |
| 2 | 读取 `primary` 色块的计算样式颜色 | 与 curl `GET /v1/projects/<id>` 返回的 `designSystem.tokens.colors.primary` 相同 |
| 3 | 点击卡片 | 右侧贴工具栏内侧滑出设计系统面板，显示 DESIGN.md 全文；面板标识进 URL `?panel=design`。M3 起该面板可编辑（种子色 / 字体 / 圆角 + 保存 + 回刷所有屏，见 `REQ-EDIT-003`），编辑与回刷行为本身由 `TC-EDIT-005` 覆盖，本用例只验风格指南与 token 同步 |
| 4 | curl `GET /v1/projects/<id>/app-map` | `nodes` 中不含风格指南卡片 |

后置：无。

### CORE · 安装与运行

#### `TC-CORE-031` 一键安装冷启动 — 对应 `REQ-CORE-017` · 级别: 冒烟 · 执行者: AI

前置：`pnpm --filter @quilt/web build && pnpm --filter quilt-canvas build`；`npm pack` 得到 `quilt-canvas-<ver>.tgz`；一个空的临时目录作为 `--home`；端口 3410 / 3411 空闲。脚本 `tests/e2e/install.ts` 全自动执行，全程不碰仓库 `.data` 与 `~/.quilt`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `npm install <tgz>` 到临时 prefix | 装出 `node_modules/.bin/quilt`；依赖里是 `playwright-core`（安装时不下载浏览器） |
| 2 | `quilt --home <空目录> --port 3410 --preview-port 3411 --no-open` | 120 s 内 `GET /v1/health` 200；`<home>/config.env` 生成且含随机 `QUILT_SECRETS_KEY` 与 `PREVIEW_SIGNING_SECRET`；`<home>/db` 存在（PGlite） |
| 3 | `GET /`、`GET /assets/*.js`、`GET /p/不存在` | 主页是打包的前端（含 `<div id="root">` 与 `/assets/*.js`）；静态资源 `Content-Type` 为 JavaScript；SPA 路径回退到 `index.html` |
| 4 | `GET /v1/config`；`GET http://127.0.0.1:3411/healthz`；`POST /mcp` initialize | `local=true`、`previewOrigin=http://127.0.0.1:3411`、`home` 等于临时目录；预览域 200；MCP 免鉴权返回 200 |
| 5 | `POST /v1/projects` 建项目 | 201；`<home>/db` 非空 |
| 6 | 杀掉进程再以同样参数启动 | 二次启动就绪且日志无「首次运行」；`GET /v1/projects` 仍含步骤 5 的项目 |

后置：停进程、删临时目录。

### PROTO · 原型播放

#### `TC-PROTO-001` 屏内链接跳转保持状态并可后退 — 对应 `REQ-PROTO-001` · 级别: 冒烟 · 执行者: 皆可

前置：`pnpm seed:project --name Play --device mobile --screens 3`（fixture：/s1 含输入框与 `href=/s2` 按钮，/s2 含 `href=/s3`）；打开；记录浏览器 `history.length`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击 /s1 聚焦，在输入框输入「上海市」 | 输入框显示「上海市」 |
| 2 | 点击 `href=/s2` 的按钮 | 同一 iframe 内内容切换为 /s2（无整页白屏闪烁，有过渡动画）；iframe `src` 不变；画布上的导航栈指示器显示 s1 → s2 |
| 3 | 按 Alt+← （或点画布「后退」） | iframe 内容回到 /s1，输入框仍显示「上海市」 |
| 4 | 读取浏览器 `history.length` | 与前置记录相同（主站历史未被污染） |
| 5 | 按 Esc | 退出交互，/s1 卡片回截图态 |

后置：无。

#### `TC-PROTO-002` 应用地图派生与断链标红 — 对应 `REQ-PROTO-002` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Map --device mobile --screens 2 --dangling`（/s1 含 `href=/settings`，项目无该路由）；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `GET /v1/projects/<id>/app-map` | `edges` 含一条 `fromScreenId=/s1 屏`、`href=/settings`、`toScreenId=null` |
| 2 | 查看画布 | 从 /s1 卡片引出一条红色断链标记，标注 `/settings` |
| 3 | 查看 /s1 到 /s2 的正常链接 | 画布上显示为普通连线，`app-map` 中该边 `toScreenId` 为 /s2 屏 id |

后置：无。

#### `TC-PROTO-003` 改路由后地图重派生 — 对应 `REQ-PROTO-002` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-PROTO-002` 的项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `PATCH /v1/screens/<s2 屏>`，body `{"route":"/settings"}` | HTTP 200，`screen.route` 为 `/settings` |
| 2 | curl `GET /v1/projects/<id>/app-map` | 原断链边 `toScreenId` 变为 /s2 屏 id |
| 3 | 刷新画布 | 红色断链标记消失，变为普通连线 |
| 4 | curl `PATCH /v1/screens/<s1 屏>`，body `{"route":"/settings"}` | HTTP 409，`type` 为 `/errors/route-taken` |

后置：无。

#### `TC-PROTO-004` 懒生成缺失页面 — 对应 `REQ-PROTO-003` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-PROTO-002` 的项目（断链 /settings 仍在）；打开（真实 LLM）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击 /s1 聚焦，点击 `href=/settings` 的元素 | 画布弹出「/settings 尚不存在，生成它？」确认框 |
| 2 | 点确认 | 创建 `kind=generate_missing_screen` 作业（202）；画布出现新占位卡片 |
| 3 | 等待至多 60 s | 新卡片截图就绪，`route` 为 `/settings`；`app-map` 中原断链 `toScreenId` 指向新屏 |
| 4 | 在聚焦的 /s1 内再次点击该链接 | iframe 内切换到新生成的 /settings 内容 |

后置：无。

#### `TC-PROTO-005` 导出单文件原型可离线跳转 — 对应 `REQ-PROTO-004` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Export --device mobile --screens 6`（6 屏互链）；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点工具栏「导出原型」 | 创建 `kind=export_prototype` 作业，工具栏显示导出进度 |
| 2 | 作业完成后点「下载」 | 浏览器下载一个 `.html` 文件（`GET /v1/jobs/<id>/export` 返回 302 到签名 URL） |
| 3 | 断网后用浏览器打开该文件 | 显示 /s1 内容；点击链接后 URL hash 变为 `#/s2` 且内容切换；6 屏均可到达 |
| 4 | 对比导出文件中 /s1 的截图与画布上 /s1 的截图 | 主色、布局一致（视觉比对留证据截图） |

后置：删除下载文件。

#### `TC-PROTO-006` 导出未完成时下载被拒 — 对应 `REQ-PROTO-004` · 级别: 边缘 · 执行者: 皆可

前置：`pnpm seed:job --project <Export 项目 id> --status running`（kind 由脚本参数 `--kind export_prototype` 指定）得到 jobId。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `GET /v1/jobs/<jobId>/export` | HTTP 409，`type` 为 `/errors/job-not-finished` |

后置：无。

#### `TC-PROTO-007` 表单提交与 data-href 按钮跳转 — 对应 `REQ-PROTO-001` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Form --device mobile --screens 3 --form --dangling`（fixture：/s1 含 `<form action="/s2">` 带 `input[name=email]` 与 `type=submit` 的「Sign in」按钮、`<button data-href="/s3">`、断链 /settings）；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `GET /v1/projects/<id>/app-map` | `edges` 含 /s1 → `/s3`（`toScreenId` 为 /s3 屏）与 /s1 → `/s2` 的表单边（/s1→/s2 边 ≥ 2 条） |
| 2 | 双击 /s1 聚焦，在 email 框输入「a@b.co」，点「Sign in」 | 同一 iframe 内切到 /s2（`iframe` 未重建，浏览器无整页跳转）；导航指示器显示 /s2 |
| 3 | 按 Alt+← | 回到 /s1，email 框仍为「a@b.co」 |
| 4 | 点「Skip to /s3」按钮（`data-href`） | iframe 内切到 /s3 |
| 5 | 按 Esc | 退出交互 |

后置：无。

#### `TC-PROTO-008` 画布连线显示与开关 — 对应 `REQ-PROTO-002` · 级别: 回归 · 执行者: 皆可

前置：先执行 `TC-PROTO-007`（Form 项目）；打开该项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 查看画布 | 卡片之间有带箭头的连线（`data-testid=link-edge`）≥ 4 条（s1→s2、s1→s3、s2→s3、s3→s1）；同一对屏合并为一条并标注条数，最大计数 ≥ 3 |
| 2 | 点工具栏「连线」 | 连线全部消失；/s1 卡片上的「断链 /settings」标记仍在 |
| 3 | 再点「连线」 | 连线恢复；刷新页面后开关状态保持 |

后置：无。

#### `TC-PROTO-009` 接上跳转（补链）修复轮 — 对应 `REQ-PROTO-002` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Repair --device mobile --screens 2 --unlinked`（/s1 含无跳转目标的主按钮「Continue」）；打开（真实 LLM）；记录 `app-map` 边数。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 不选中任何屏，点工具栏「接上跳转」 | 提示「正在为 2 屏补链」（未选中时作用于全部屏）；对话面板出现该作业 |
| 2 | 等待作业完成（≤ 240 s） | 对话面板显示「已生成」；/s1 新修订里「Continue」变为带 `href` 或 `data-href="/s…"` 的导航元素 |
| 3 | curl `GET /v1/projects/<id>/app-map` | 边数比前置记录多 |
| 4 | 只选中 /s1 后再点「接上跳转」 | 提示「正在为 1 屏补链」；该作业的 `screenIds` 只含 /s1 |

后置：无。

#### `TC-PROTO-010` 未设计的交互只提示不跳转 — 对应 `REQ-PROTO-001` · 级别: 回归 · 执行者: 皆可

前置：先执行 `TC-PROTO-007`（Form 项目，/s1 含 `href="#"` 的「Coming soon」链接）；打开该项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击 /s1 聚焦，点「Coming soon (not designed)」 | iframe 仍显示 /s1（标题不变、`iframe` 未重建）；画布出现 toast「这个交互还没有设计…」 |
| 2 | curl `GET /v1/projects/<id>/app-map` | `edges` 中没有 `href="#"` 的边 |

后置：按 Esc 退出交互。

#### `TC-PROTO-011` 聚焦屏内捏合缩放画布 — 对应 `REQ-PROTO-001` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-PROTO-010`；聚焦 /s1 后记录顶栏缩放百分比与 `window.scrollY` / `visualViewport.scale`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 指针在 iframe 内触发带 ctrlKey 的 wheel（deltaY = −100，触控板捏合放大） | 顶栏缩放百分比上升；`visualViewport.scale` 仍为 1，`window.scrollY` 仍为 0，顶栏可见 |
| 2 | 同样操作 deltaY = +100 | 缩放百分比回落 |

后置：按 Esc 退出交互。

### EDIT · 元素编辑与设计系统

#### `TC-EDIT-001` 元素文案本地直改零 token — 对应 `REQ-EDIT-001` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Edit --device mobile --screens 1`（fixture 含文案「登录」的按钮，qid 由响应可查）；打开；记录 `GET /v1/me/usage`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 不选中任何屏，按 `⌘E` 开启选择元素模式，再单击卡片进入，点击「登录」按钮元素 | 按键即开模式（不必先选中屏）；进入后卡片角标显示「选择元素中」而非「交互中」；元素上出现常驻选中框（`[data-quilt-selection]`，标签写 `button · <qid>`），鼠标移开仍在；右侧检查器显示其文案与样式字段 |
| 2 | 把文案改为「立即登录」，回车 | 800 ms 内卡片内文案变为「立即登录」；iframe 不重挂（`src` 与进入时相同，角标仍「选择元素中」）；检查器仍选中同一元素且「文案」字段已刷成「立即登录」（热更新后按 qid 重选，不退回空态），选中框仍在该元素上，元素出现「已更新」角标（`[data-quilt-mark][data-kind=done]`，4 s 后自撤）；`POST /v1/screens/<id>/elements/<qid>` 返回 201，`revision.sourceKind` 为 `manual` |
| 3 | curl `GET /v1/me/usage` | tokens 与前置记录完全相同 |
| 4 | 等待至多 10 s | 卡片截图更新为新文案 |

后置：无。

#### `TC-EDIT-002` 直改引入违规样式被拒 — 对应 `REQ-EDIT-001` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-EDIT-001` 项目；记录当前 revisionId。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/screens/<id>/elements/<qid>`，body `{"ops":[{"type":"style","value":"color:#ff0000"}],"expectedRevisionId":"<当前>"}` | HTTP 422，`type` 为 `/errors/lint-failed`，`violations[]` 指出裸色值 |
| 2 | curl `GET /v1/screens/<id>/revisions` | 修订数未增加 |
| 3 | 在检查器里把颜色改为 token 选项 `primary` | 返回 201，新修订生效 |

后置：无。

#### `TC-EDIT-003` 子树 AI 重生成只替换选中子树 — 对应 `REQ-EDIT-002` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Subtree --device mobile --screens 1`（fixture 含 qid 为 `q40` 的卡片列表容器与其兄弟元素）；打开，`⌘E` 后单击卡片进入选择元素态（角标「选择元素中」），记录 iframe `src`；下载当前 HTML 留存（真实 LLM）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1a | 看检查器「用 AI 重生成这块」下方的通道选择器（`el-runner-select`）；改选另一个可用云端通道；刷新页面、重新进入选择元素态并点选同一容器 | 默认等于输入框当前通道（`runner-select` 的值）；改选后刷新重进仍是改选的那个（记忆独立），输入框的通道不变 |
| 1 | 选中 q40 容器，检查器「用 AI 重生成这块」里输入「改成横向滑动」，在文本框里按 `Shift+Enter`（按钮旁标有该键） | 创建 `kind=regenerate_subtree` 作业（202），`input.runner` 是检查器里改选的通道；检查器仍停在 q40 上（说明框清空、字段还在），不退回「点选一个元素」空态；屏内 q40 出现「修改中…」角标（`[data-quilt-mark][data-kind=working]`），检查器写明「这块正在修改中」 |
| 2 | 等待至多 60 s | 新修订生效；**不退出交互**：作业完成后 10 s 内 iframe 内 q40 子树换成新内容（旧列表首行文本消失），`src` 不变、角标仍「选择元素中」；q40 上出现「已更新」角标（`data-kind=done`）；检查器仍停在 q40（根沿用原 qid，热更新后重选）；新 HTML 中 q40 子树内容变化 |
| 3 | 比对新旧 HTML | 新 HTML 里 `data-qid="q40"` 恰好一次（替换后的根沿用原 qid）；q40 之外所有元素的 `data-qid` 与文本内容逐一相同 |

后置：无。

#### `TC-EDIT-004` 子树 qid 不存在 — 对应 `REQ-EDIT-002` · 级别: 边缘 · 执行者: 皆可

前置：同 `TC-EDIT-003` 项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/projects/<id>/jobs`，body kind `regenerate_subtree`、`qid` 为 `q999` | HTTP 404，`type` 为 `/errors/element-not-found`；不创建作业 |

后置：无。

#### `TC-EDIT-005` 设计系统改色后一键回刷所有屏 — 对应 `REQ-EDIT-003` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name DS --device mobile --screens 10`；打开（真实 LLM 或 `LLM_STUB=fixture`，回刷不需要模型时由服务端确定性完成）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点风格指南卡片打开设计系统面板，把种子色改为 `#C2410C`，先看「回刷所有屏」再点「保存」 | 改完未保存时版本行标「· 有未保存改动」、「回刷所有屏」不可点且写明「先保存——回刷用的是已保存的那份设计系统」；`PUT /v1/projects/<id>/design-system` 返回 200，`version` 加 1；面板色板 `primary` 变为橙色系；toast「设计系统已保存」 |
| 2 | 保存成功后弹出「回刷所有屏？」（`ds-apply-ask`，v0.38；只改 DESIGN.md 正文不会弹，v0.39），点「回刷 10 屏」（`ds-apply-confirm`） | 弹层是 `role=dialog`、`#root` 被置 `inert`、初始焦点在「以后再说」（选它则关掉弹层、焦点落到「回刷所有屏」——「保存」此刻已是原生 disabled 接不住焦点，v0.39）；确认后创建 `kind=apply_design_system` 作业；10 张卡片依次显示更新中 |
| 3 | 等待至多 120 s | 10 屏各新增一条 `sourceKind=apply_ds` 修订；任取 3 屏 HTML，`:root` 内 `--color-primary` 均为新值 |
| 4 | 双击任一屏聚焦 | 主色按钮显示为橙色系 |

后置：无。

#### `TC-EDIT-006` 设计系统版本冲突 — 对应 `REQ-EDIT-003` · 级别: 边缘 · 执行者: 皆可

前置：同 `TC-EDIT-005` 项目；`pnpm seed:design-system --project <id> --bump`（服务端版本已抬升）；面板仍持旧版本打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 在面板修改字体并保存 | 提示「设计系统已被更新，请刷新后重试」；API 返回 409，`type` 为 `/errors/version-conflict` |
| 2 | 刷新页面后重做修改并保存 | 返回 200 |

后置：无。

#### `TC-EDIT-007` 检查器手动连线零 token — 对应 `REQ-EDIT-001` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Link --device mobile --screens 2 --form`（/s1 含无跳转的 `#toggle` 按钮「Follow」与 `<form action="/s2">`）；打开；记录 `GET /v1/me/usage` 与 `app-map` 中 /s1→/s2 边数。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 按 `⌘E` 开启选择元素模式，单击 /s1 进入 → 点「Follow」按钮 | 卡片角标显示「选择元素中」；检查器「跳转到」下拉为「不跳转」，选项含 /s1、/s2 |
| 2 | 选 /s2，点「保存（零 token）」 | 提示「已更新」；`POST /v1/screens/<id>/elements/<qid>` 返回 201，新修订 `sourceKind=manual`，该按钮带 `data-href="/s2"` |
| 3 | curl `GET /v1/projects/<id>/app-map`、`GET /v1/me/usage` | /s1→/s2 边数比前置多 1；tokens 与前置完全相同 |
| 4 | 退出选择元素态 | 卡片回到静态截图（两种模式互斥，退出不会落到交互态）|
| 5 | 双击 /s1 重新进交互态，点「Follow」 | iframe 内切到 /s2 |
| 6 | curl `POST /v1/screens/<s1>/elements/<表单 qid>` ops=`[{type:"link",value:null}]` | **HTTP 201**（v0.43：偏离不阻断写入）；新修订的 `lintReport.violations` 含 `form-action` 一条，画布卡片标「1 处偏离」 |

后置：无。

#### `TC-EDIT-008` 元素批注攒批发送 — 对应 `REQ-EDIT-004` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Anno --device mobile --screens 1`；打开（真实 LLM）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 不选中任何屏，按 `⌥N`（或点工具栏「批注」）；再单击 /s1 | 按键即开模式：画布光标变准星并出现「批注模式：点任意一屏开始」提示；单击 /s1 后进入该屏，角标显示「批注中」，右侧打开批注面板 |
| 2 | 点屏内「Follow」按钮，写「这个按钮改成次要样式」，点「记下（不发送）」 | 批注落库为 `open`；面板列出该条；画布上该元素旁出现编号气泡 |
| 3 | 再点另一个元素，写第二条并记下 | 能选中**另一个** qid（保存过一条后仍可换元素）；面板 2 条、画布 2 个气泡，编号依次为 1、2 |
| 4 | 点「一起发送」 | **2 条批注只产生 1 个 `edit_screens` 作业**（不是 2 个）；作业指令含两条说明与各自 `data-qid`；两条批注状态转 `sent` 且 `sentJobId` 相同 |
| 5 | 等作业完成（≤ 240 s） | 作业成功；两条批注转 `resolved`；刷新后画布上不再有这两个气泡 |

后置：无。

#### `TC-EDIT-009` 记为约定：提炼、预览、写入 — 对应 `REQ-EDIT-003` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Conv --device mobile --screens 2 --no-shot`；本地起 OpenAI 兼容桩（Key `good-key-0004`：提炼提示（以 `INSTRUCTION:` 开头）回 `{"summary":…,"conventions":["正文字号 text-base（16px）…","页面标题 text-xl"],"regenerate":true}`，改屏提示回放种子屏 body）；以 API 建好指向桩的通道并探测通过；记录设计系统 `version`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 画布选桩通道，`⌘A`，发送「所有页面正文字再大一点」，等「已更新 2 屏」 | 设计系统 `version` 不变（`⌘A` + 发送 = 普通改全部，不碰设计系统） |
| 2 | 点该助手回执上的「记为约定」（`remember-convention`） | 创建 `kind=propose_design_system` 作业，`input.instruction` 为原指令、`input.screenId` 为一张改后的屏；作业成功后弹预览（`ds-proposal`）：2 条可勾选的约定，文案是绝对规则、不含「再大一点」 |
| 3 | 点「确认写入」（`ds-proposal-confirm`）→ 出现「按新约定重生成所有屏？」→ 点「只写入」（`ds-proposal-write-only`） | `PUT design-system` 带 `conventions`；DESIGN.md 出现 `## 约定` 节且含那两条；`version+1`；设计系统面板（`ds-conventions`）列出 2 条 |
| 4 | 在面板删除第 1 条 | 剩 1 条；`version` 再 +1 |

后置：删除用例创建的通道；桩服务关闭。

#### `TC-EDIT-010` 品牌色板 — 对应 `REQ-EDIT-005`（v0.35）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Palette --device mobile --screens 2 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 读新项目的 `designSystem.tokens.colors` | 含 `success` / `onSuccess` / `warning` / `onWarning`（没挂色板也有语义色） |
| 2 | `PUT design-system` 带 `palette.light = {primary:#284CCA, background:#F4F1EA, success:#1D7153}` | `200`、`version+1`；这三键取原值，`secondary` 等没覆盖的键与第 1 步一致 |
| 3 | 跑 `apply_design_system screenIds=all` | 作业成功；新修订的 prelude 含 `--color-primary:#284CCA` 与 `--color-success:#1D7153`，`<body>` 内容与回刷前逐字相同 |
| 4 | 没有 `palette.dark` 时 `PUT colorMode=dark` | `400 /errors/validation`，消息说明要先给 `palette.dark` |
| 5 | `PUT` 带 `palette.dark`（只覆盖 `primary`）且 `colorMode=dark` | `200`；`tokens.colors.primary` 为暗色色板的值；**未覆盖键取 Material 暗色方案**（v0.38）：`surfaceVariant` 是暗值（如 `#45464f`，不是亮色的 `#e2e1ec`），`text-on-surface-variant` 压在 `bg-surface-variant` 上的对比度 ≥ 4.5:1；语义色也切到暗档（`success` 亮、`onSuccess` 深，与 `error`/`onError` 同规则） |
| 5b | 存量仍是 `colorMode=dark` 时只 `PUT {palette:null}`（不带 `colorMode`）；另起一次 `PUT {palette:{light:{primary},dark:{}}}`（不带 `colorMode`）；再显式 `PUT {colorMode:"dark"}`（此时无暗色色板）（v0.38） | 前两次都 `200`、`version+1`、落库 `colorMode=light` 且 `tokens` 是纯亮色派生（撤掉暗色色板就回落亮色——否则面板的亮 / 暗段控消失、模式却停在暗，用户没有退路；`dark:{}` 等同于没有暗色色板）；第三次仍 `400 /errors/validation`（`path=colorMode`） |
| 6 | `PUT palette=null, colorMode=light` | `200`；`tokens.colors` 回到第 1 步的种子派生值 |
| 7 | 打开设计系统面板的色板区（`palette-section`） | 来源写「种子派生」；展开后 `palette-grid` 有 26 个色键、`data-source="brand"` 为 0 个 |
| 8 | 用 `psql` 把该项目 `design_systems.tokens` 里的四个语义色键（`success/onSuccess/warning/onWarning`）删掉（模拟 `0009` 升 `0010` 的存量行），重启 API 进程（v0.38） | 启动日志出「语义色回填 N 个项目」；`GET /v1/projects/<id>` 的 `tokens.colors` 四个语义键回来了且与 `tokensFromSeed(seedColor,{colorMode})` 一致，其余键未变、`designSystem.version` **不变**（回填不碰乐观锁基线）；再重启一次回填 0 个（幂等） |

后置：无。

#### `TC-EDIT-011` 字体来源 — 对应 `REQ-EDIT-003`（v0.44）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Fonts --device mobile --screens 1 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `PUT design-system` 带 `fontFamily="Plus Jakarta Sans"`（不在候选清单里）、`fontSource="google"`，随后跑 `apply_design_system screenIds=all` | `200`、`tokens.typography.fontSource="google"`；新修订 `<head>` 含 `fonts.googleapis.com/css2?family=Plus%20Jakarta%20Sans` 链接，`font-family` 为 `"Plus Jakarta Sans",system-ui,sans-serif` |
| 2 | `PUT` 带 `fontFamily="PingFang SC"`、`fontSource="system"`，回刷 | `200`；`<head>` **没有** `fonts.googleapis.com` 链接；`font-family` 以 `"PingFang SC",-apple-system` 开头（本机字体栈） |
| 3 | `PUT` 带 `fontSource="url"`、`fontUrl="https://fonts.bunny.net/css?family=manrope:400,600"`、`fontFamily="Manrope"`，回刷 | `200`；`<head>` 含 `<link href="https://fonts.bunny.net/css?family=manrope:400,600" rel="stylesheet">`，不含 Google Fonts 链接 |
| 4 | `PUT {fontSource:"url", fontUrl:null}`；另起 `PUT {fontFamily:'Inter"; }'}` | 都 `400 /errors/validation`（前者 `path=fontUrl`——族名与链接会进 `<link>`、CSS 与 JS 字符串，带引号的族名不能放行）；`version` 不变 |
| 5 | 打开设计系统面板 | 来源段控 `ds-font-source` 的 `data-value` 为 `url`，`ds-font-url` 回显第 3 步的地址；清空地址点「保存」（`ds-save`）→ 输入框下方出 `#ds-font-url-error`、不提交（`version` 不变）；切到「本机字体」→ 链接框收起 |

后置：无。

#### `TC-EDIT-012` 共享组件 — 对应 `REQ-EDIT-006`（v0.46）· 级别: 核心 · 执行者: AI

前置：`pnpm seed:project --name Comp --device mobile --screens 3 --no-shot`（三屏 `/s1`…`/s3`，每屏 depth-1 一个三 tab 的 `<nav>`；记三屏 `currentRevisionId`，从 `/s1` 当前修订 HTML 里取 `<nav` 的 qid）；步骤 8 要真实 LLM（`LIVE_LLM=0` 时跳过）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/{id}/components` 带 `{ name:"TabBar", fromScreenId:/s1, qid:<nav qid>, applyToScreens:true }` | `201`；`component.name="TabBar"`、`version=1`、`nav=false`（fixture 四个 tab 类名相同且无 `aria-current`，分不出激活态）、`summary` 以 `nav` 开头且含 `links:`；`applied` 恰含 /s2、/s3，`skipped` 为空；三屏 `currentRevisionId` 都变、新修订 `sourceKind=component`；三屏 HTML 里 `<nav data-component="TabBar"` 各恰好出现一次，nav 里仍是 3 条 `<a href="/s…">`；`GET /v1/projects/{id}` 的 `components[0].usedBy` 含三屏 |
| 2 | `PATCH /v1/components/{cid}` 带 `html` 为只有 2 个 tab 的 `<nav …>` 与 `expectedVersion:1` | `200`、`component.version=2`、`applied` 为三屏；三屏再出新修订（`sourceKind=component`），nav 里 `<a href="/s…">` 变 2 条；步骤 1 的修订仍在各屏修订列表里 |
| 3 | 再 `PATCH` 同样的 `html`、`expectedVersion:1` | `409 /errors/version-conflict`；`version` 仍为 2、三屏修订数不变 |
| 4 | 取 /s1 当前 HTML 里 nav 内第一条 `<a>` 的 qid，`POST /v1/screens/{s1}/elements/{qid}` 改文案 | `409 /errors/component-locked`，体 `component="TabBar"`；随后对同一 qid 发 `ops=[{type:"detach"}]` → `201`，新修订 `sourceKind=manual`，/s1 HTML 里的 `<nav` 不再带 `data-component`（nav 内容不变）；再改文案 → `201`，文案已换 |
| 5 | `PATCH /v1/components/{cid}` 带 `name:"BottomNav"`、`expectedVersion:2` | `200`、`version=3`、`applied` 恰为 /s2、/s3；两屏 HTML 里实例根变为 `data-component="BottomNav"`，/s1（已脱离）`currentRevisionId` 不变 |
| 6 | `DELETE /v1/components/{cid}` | `204`；三屏 `currentRevisionId` 都不变，/s2 HTML 里仍有 `data-component="BottomNav"`（已展开的留着）；详情 `components` 为空 |
| 7 | 重新按步骤 1 提取（名 `TabBar`）；打开 `/p/{id}` | 画布出现 `component-card`（`data-name="TabBar"`），标签含「用于 3 屏」；在空白处框选到它 → 目标区出现 `component-chip`「组件 · TabBar」、动词行含「改组件「TabBar」」且无 `count-group` / `versions-group`；`⌘E` 点 /s1 进选择元素态，点 nav 里一个 tab → 检查器出现 `el-component-lock`（含「共享组件「TabBar」」）与 `el-edit-component`、`el-detach`，无 `#el-text`；点 `el-edit-component` → 目标区只剩「组件 · TabBar」、输入框获得焦点；工具栏 `new-component`（`⌥C`）填名 `Footer` 确认 → `component-card` 数变 2、目标区为「组件 · Footer」 |
| 8 | （真实 LLM）目标为 `TabBar` 组件，输入框发「把第二个 tab 的文案改成 Search，其他都别动」 | `POST messages` 带 `targetComponentIds=[cid]`，作业 `kind=edit_component`；在跑作业行写「改组件「TabBar」」；作业成功后组件 `version+1`、`summary` 含 `Search`，用它的每一屏各出一条 `sourceKind=component`、`jobId=本作业` 的新修订且 HTML 含 `Search`；助手消息以「已更新组件「TabBar」」开头并写「同步 N 屏」 |
| 9 | 双击画布上的组件卡；按 `Esc`（v0.53 组件卡可交互） | 双击前后世界层 `.world` 的 `transform` **完全一致**（组件进交互不动镜头，与屏的「推到 1:1 居中」不同）；卡片带 `focused`、手势罩 `.gesture` 已移除、iframe 的 `pointer-events` 为 `auto`（组件里的按钮点得动）、右上出现呼吸绿点（`.live-dot`，`aria-label="交互中"`，8 px、`sk-pulse` 动画，不透明度在变）；此时双击一张屏卡进交互，组件的 `focused` 自动退掉（两态互斥）；`Esc` 退出交互态（焦点在组件 iframe 内按也有效）。再往组件里塞一个 `href="#"` 的链接并点它（v0.55 链接惰性）：不出现任何 toast、iframe 也不跳走 |
| 10 | 目标为该组件，发「顶部一级频道导航：关注 / 推荐 / 附近 / 活动，默认选中「推荐」，点任意一条要真切换」；产出按组件预览文档渲染后点第 3 条（v0.54 组件交互契约） | 产出通过 `validateComponentHtml`（单根、无 `<script>`）；HTML 里每条是 `<label>` 且首个孩子是 `type="radio" class="peer sr-only"`、`name` 带组件名前缀，选中态全部写成 `peer-checked:` 变体、默认值只在 `checked` 上（**没有任何一条把选中样式硬编码进 class**），焦点环走 `peer-focus-visible:`，条目带 `data-slot` / `data-part`；渲染后点第 3 条：该条 `input.checked` 为 true、字重与字号升到选中档、indicator `opacity` 为 1，原选中项三项同时回落；容器高度前后一致（选中态变粗变大不得顶高）|
| 11 | 双击组件卡进交互态 → 按 `⌘E` → 点组件里某条 tab 的文字 → 检查器把「文案」改掉并保存（v0.57 组件选元素直改） | 检查器标题为「检查器 · <组件名>」；**文案框读得到那条文字**（组件把文字设成 `pointer-events:none` 时也要能选中——选择元素态临时解除这层限制）；面板里没有「用 AI 重生成这块」与「记为共享组件」，取而代之是一句指向「改组件」的说明（`el-component-hint`）；保存后组件 `version` +1、HTML 里那条文案已变、用它的屏被回刷；**同一条上与旧文案逐字符相等的 `aria-label` / `title` 跟着改，邻条的不受影响；与文案原本就不同的（图标按钮那种）一个字都不动**（v0.59）；`expectedVersion` 过期时报「组件已被更新」而不是静默覆盖。**退出路径逐条查残留**（`⌘E` 再按一次 / `Esc` / 双击另一个组件 / 点画布空白 / 带着选择态刷新 / 只进不选就退出）：组件文档里不得留下选中框、`tag · qid` 标签、`[data-qid]{pointer-events:auto}` 那条样式或 `crosshair` 光标——组件卡的 iframe 常驻，不像屏那样退出即卸载 |

后置：无。

### AGENT · MCP 与本机 agent

> v0.32 本地单用户版：`TC-AGENT-002`（scope 不足）、`TC-AGENT-005`（长轮询领取）、`TC-AGENT-006`（租约过期）、`TC-AGENT-007`（deeplink）、`TC-AGENT-008`（伴侣进程）随 `REQ-AGENT-001` 的 OAuth 与 `REQ-AGENT-004/005` 推迟，用例正文移除；ID 保留不复用。

#### `TC-AGENT-001` 本机 agent 免鉴权接入 MCP 并生成屏幕 — 对应 `REQ-AGENT-002`（`ADR-016`）· 级别: 冒烟 · 执行者: 皆可

前置：已按 §3 重置基线；打开 `Demo Mobile`（真实 LLM，`LIVE_LLM=0` 时跳过生成步骤）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 不带任何凭据连接 `http://127.0.0.1:3100/mcp`（`pnpm mcp:call --list`） | 连接成功；工具含 `quilt.list_projects` / `generate_screens` / `edit_screens` / `get_design_contract` / `validate_screen` / `create_screen` / `update_screen` / `get_screenshot`，**没有任何 `*task*` 工具**；资源模板含 `design.md` 与 `golden` |
| 2 | `pnpm mcp:call quilt.list_projects '{}'`；`GET /v1/config` | 返回项目列表含 `Demo Mobile`；配置 `local=true`、`previewOrigin` 指向本机 |
| 3 | `pnpm mcp:call quilt.generate_screens '{"projectId":"<id>","prompt":"A todo app…","count":2}'`，轮询 `quilt.get_job` | 返回作业句柄；最终 `succeeded`；`GET /v1/me/usage` 的 `screens` 增加；画布出现新屏 |
| 4 | 打开 `/p/<id>?settings=runners` | 「让本机 agent 接入 Quilt（MCP）」给出的命令是 `claude mcp add --transport http quilt http://localhost:3100/mcp` |

后置：无。

#### `TC-AGENT-003` agent 自带 HTML 经校验推进画布 — 对应 `REQ-AGENT-002` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Ingest --device mobile --screens 1 --no-shot`；准备一份只用 CSS 变量与白名单组件的 HTML（脚本内置 `OK_HTML`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `pnpm mcp:call --resource quilt://projects/<id>/design.md` 与 `tokens.json` | 返回 DESIGN.md 文本与 token JSON |
| 2 | `pnpm mcp:call quilt.validate_screen` 传入该 HTML | 返回 `violations` 为空数组 |
| 3 | `pnpm mcp:call quilt.create_screen '{"projectId":"<id>","html":"<文件内容>","route":"/agent","name":"Agent 屏"}'` | 返回 `screenId`、`revisionId` |
| 4 | `quilt.get_screen` 取该屏 | 含服务端注入的 `data-qid` 与 `:root` 变量 prelude |
| 5 | `quilt.get_screenshot '{"screenId":"<id>"}'`（20 s 内） | 返回 image 类型 content block（PNG），非 URL 字符串；画布出现 `/agent` 卡片 |

后置：无。

#### `TC-AGENT-004` 违规 HTML 被 lint 拒绝 — 对应 `REQ-AGENT-002` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-AGENT-003` 项目；含裸色值 `#123456` 的 HTML。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `quilt.create_screen` 传入该 HTML | **写入成功**（v0.43），返回体带 `lintReport.violations`（含裸色值、内联 style 等条目）与 `screenId`；项目详情里该屏 `deviations` 等于条数 |
| 2 | curl `GET /v1/projects/<id>` | 屏数未增加 |

后置：无。

#### `TC-AGENT-009` 本机 agent 作为执行者：会话列表 / 会话下拉 / 投递 / 屏锁 / 取消 / 收口 / 记忆与失效 — 对应 `REQ-AGENT-003`（`ADR-015` v0.34、`ADR-016`）· 级别: 回归 · 执行者: AI

前置：API 与脚本都以 `QUILT_CLAUDE_SESSIONS_DIR=/tmp/quilt-e2e-sessions` 运行（§3），本机 `claude` 在 PATH 上；脚本起两个假会话——「Stub 会话」（`nameSource=user`）与 `quilt-ab`（`nameSource=derived`、`status=busy`、活跃时间早 1 分钟）；`pnpm seed:project --name AgentJob --device mobile --screens 2 --no-shot`。未设该变量或 `claude` 不可用时登记「跳过」。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `GET /v1/agent/sessions` | 两个假会话都在：「Stub 会话」`named=true`；派生名的 `named=false`、`status=busy`；按最近活跃排序（Stub 会话在前） |
| 2 | 打开项目，通道下拉选「交给本机 Claude Code」，打开旁边出现的会话下拉（`session-select`） | 屏数 / 版数档位（`count-group` / `versions-group`）不再显示，动词行写「…交给本机会话」；起过名的项显示「Stub 会话」，派生名的项显示其会话 UUID，各带目录名与 空闲 / 忙 小标；选「Stub 会话」后触发器 `data-value` 为其 sessionId |
| 3 | 点选 s1 卡片，输入框发「HANG 把首页改成分组列表」 | 画布切到 agent 面板；假会话收到一行 JSON 用户消息，提示词含 `(job <id>)`、`expectedRevisionId=<s1 current>`、`quilt.finish_job`、`claude mcp add`；作业 `running`、`output.delivery.name=Stub 会话`；助手回执含「已投递到本机 Claude Code 会话「Stub 会话」」；`GET /v1/me/usage` 的 token 与 `inflight.screens` 不变；输入框未禁用；**面板开着且 agent 作业在跑时页面活跃 `EventSource` 仍为 1**（v0.38：面板轮询 `API-CORE-029`，不再按作业各开一条 `API-CORE-008`——5 个 agent 作业同时跑就占满同源 6 条额度），且后台标签页（`document.hidden`）不发轮询请求 |
| 4 | 对 s1 直改（`API-EDIT-001`）；同屏再派一次（带同一 sessionId） | 都返回 409 `/errors/screen-busy`（作业持锁） |
| 5 | 面板首条卡（`agent-job`）：状态 running、`agent-line` 等到含「已投递」（v0.38 面板靠 1.5 s 轮询推进，投递窗口内先显示「正在投递…」，所以这一条要等、不能一次性断言）、`agent-session` 为「Stub 会话」；点「取消」 | 作业 `cancelled`（不杀任何进程）；随后对 s1 直改返回 201（锁已释放）；用 MCP 对该作业调 `quilt.finish_job` → 409 `/errors/job-finished` |
| 6 | 再派一条含 `FAIL`（假会话直接 `finish_job status=failed summary="simulated failure"`） | 作业 `failed`、`output.errorClass=agent`、`output.summary=simulated failure` |
| 7 | 再派一条含 `STALE`（假会话用假 `expectedRevisionId` 调 `quilt.update_screen` 后报失败） | 作业 `failed`、`output.summary` 含 `revision-conflict`；s1 的 current 不变 |
| 8 | 先双击 s1 进交互（画布不开任何面板），再派一条普通指令（假会话按提示词基线回写，再 `finish_job summary="rewrote Screen 1 as asked"`） | **不做任何操作**，15 s 内聚焦屏原地换成假会话写的内容（h1 含 `by fake session`，项目级事件 → 热更新，`API-CORE-030`）；作业 `succeeded`、`output.screenIds=[s1]`、`output.summary` 为该摘要；current 变化；助手回执「本机 agent 已完成…rewrote Screen 1…」且 `affectedScreenIds=[s1]`；面板列 4 条，完成那条写「回写了 1 屏 · rewrote Screen 1 as asked」 |
| 9 | 刷新页面；关掉「Stub 会话」；打开会话下拉；在输入框键字；直接 `POST` 带旧 sessionId | 刷新后会话下拉仍选中「Stub 会话」（跨会话记忆）；关掉后打开下拉重取，触发器回到「选择会话」、发送钮 `aria-disabled`（提示「先选要投递的会话」）；直接 POST 返回 400 `/errors/validation` |

后置：脚本关闭假会话并删掉登记文件与 socket。

#### `TC-AGENT-010` 投递到真实 Claude Code 会话 — 对应 `REQ-AGENT-003` · 级别: 回归 · 执行者: 人工

前置：本机 `claude` 已登录；在任意目录开一个交互式会话并 `/rename 设计稿`，在该会话里执行设置页给的 `claude mcp add --transport http quilt http://127.0.0.1:3100/mcp` 并 `/mcp` 确认连上；`pnpm seed:project --name RealAgent --device mobile --screens 1 --no-shot`；记录 `GET /v1/me/usage`。AI 轮次登记「待人工」——投递进真实会话要在那个终端里确认接收。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 画布通道选「交给本机 Claude Code」，会话下拉选「设计稿」，点选 s1 发「Change the h1 heading text to "Hello from Claude Code" and keep everything else the same.」 | 画布切到 agent 面板：运行中 · 已投递到「设计稿」；那个终端里出现投递来的消息（可能先要确认接收） |
| 2 | 在终端看会话干活，等它调 `quilt.finish_job` | 作业 `succeeded`、`output.screenIds=[s1]`、`output.summary` 是它的一句话；s1 新修订含 `Hello from Claude Code`；`GET /v1/me/usage` 与前置相同（会话用自己的登录态，不记 Quilt 台账）；面板该条为「完成」并显示摘要 |
| 3 | 再发一条并在终端里不处理，等 30 分钟 | 作业 `failed errorClass=timeout`，面板写「投递后 30 分钟没有收口」 |

后置：无。

#### `TC-AGENT-011` MCP 与画布同面：删 / 修订 / 候选 / 摆放 / 直改 / 全部作业 / 素材 / 预设 / 批注 / 项目 — 对应 `REQ-AGENT-002`（v0.51）· 级别: 回归 · 执行者: AI

前置：API 以 `LLM_DRIVER=stub` 启动（作业类步骤只验作业输入与终态，模型行为由 `TC-CORE-005` / `TC-EDIT-004` / `TC-EDIT-009` / `TC-EDIT-012` / `TC-PROTO-005` 各自覆盖）；`pnpm seed`；`pnpm seed:project --name Parity --device mobile --screens 3 --no-shot`；经 `POST /v1/projects/{id}/components` 建共享组件 `Footer`；脚本在 `$TMPDIR` 现造一张 1×1 PNG（结束即删）。执行与独立端口的起法见 §3。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `--list`；`quilt.list_runners` | 54 个工具（含 v0.51 新增 32 个）、7 类资源；通道目录 `{ items, default }`，响应文本不含 `apiKey` |
| 2 | `validate_screen` OK_HTML → `create_screen /agent` → `get_screen` → `get_screenshot`（20 s 内）；违规 HTML `create_screen /bad` → `delete_screen` | 无违规；注入 qid + prelude；返回 image；违规屏照常写入且 `lintReport.violations` 非空；删后项目 4 屏、`/bad` 不在 |
| 3 | `update_screen` 只传 `html` + `expectedRevisionId`；`get_revision` 取第 1 版；`restore_revision`（expectedRevisionId = 当前）；再用第 1 版 id 作 expectedRevisionId 回溯 | name / route 沿用、current 推进；返回第 1 版 HTML 文本（`seq=1`、无 v2）；产生 `sourceKind=restore` 修订并成为 current；`409 /errors/revision-conflict` |
| 4 | `edit_screens` 对 `/agent` `versions=2` → `list_candidates` → `adopt_candidate` 第 2 版 → `adopt_candidates index=3` | 作业 succeeded；1 屏 × 2 版未结清；current 指向第 2 版、该批结清；`adopted=[]`、`skipped=[/agent]` |
| 5 | `move_screens`：s1 (100, 200)、s2 (600, 200)、`Footer` (−300, 0)、一个假组件 id | `moved.screens` 2、`moved.components` 1、`failed=[{ 假 id, /errors/not-found }]`；详情里位置落库、`Footer.version` 不变 |
| 6 | `edit_element` q1 `text`；再用旧 expectedRevisionId 直改 | `sourceKind=manual`、`get_screen` 含新文案；`409 /errors/revision-conflict` |
| 7 | `create_attachment_upload_url` → PUT PNG；`create_asset`（本机 PNG 绝对路径）→ `list_assets` / 设计契约 `assets[]` / 预览域 GET；`create_asset` 相对路径、不存在的文件；`delete_asset` | `putUrl` 绝对地址、PUT 204；素材 `image/png`、URL 为 `/a/{pid}/{id}`，三处都能看到、预览域 200 `image/png`；`400 /errors/validation`、`404 /errors/not-found`；删后列表不含 |
| 8 | `generate_screens count=2 anchor=(5000,0) attachmentIds componentIds`；`generate_screens route=/settings name=Settings fromScreenId=s1`；`regenerate_subtree s1 q1`；`propose_design_system`；`edit_component` 带 `runner.kind=agent`、再不带；`export_prototype` → `get_export`；`get_export` 对非导出作业；`list_jobs`；`get_job_events`（含 `after`）；`seed:job running` → `cancel_job` ×2；`edit_screens` 带不属于自己的 `channelId` | 作业输入落 `anchor` / `imageKeys`（1 张）/ `componentIds`；succeeded 且有一屏中心落在锚点（左上角 `(5000 − 195, 0 − 422)`，与画布双击放锚点同一语义）；懒生成 `/settings` 屏出现；子树作业 succeeded、s1 最新修订 `subtree`；提炼作业建成（stub 下终态记入明细）；`400 /errors/validation`、作业 `edit_component` 建成；导出 succeeded、下载 200 且正文含全部屏；`409 /errors/job-not-finished`；列表含各作业；事件 seq 递增、末条 `succeeded`、`after=末尾` 为空；`cancelled`、再取消 `409 /errors/job-finished`；`404 /errors/not-found` |
| 9 | `create_design_preset Brand` → `list_design_presets` → `create_project FromPreset presetId` → `apply_design_preset expectedVersion applyToScreens=true` → 过期版本再套 → `delete_design_preset` | 预设在列；新项目种子色 = 预设；`version+1`、回刷作业 succeeded；`409 /errors/version-conflict`；删后不在列 |
| 10 | REST 建两条批注（s2、s3）→ `list_annotations { projectId }` → `update_annotation a1 resolved` → `list_annotations { projectId }` / `{ projectId, screenId: s2 }` → `send_annotations [a2]` → `delete_annotation a1` | 两条 open 在列；resolved 后项目级未处理列表不含 a1、单屏列表含 a1（resolved）；建 1 条 `edit_screens` 作业（`screenIds=[s3]`），succeeded 后 a2 `resolved`；删后 s2 单屏列表为空 |
| 11 | `update_project exemplarScreenId=s2` → 读 `golden` 资源 → `exemplarScreenId=null` → 空 patch；`update_design_system conventions=[…]`；REST 发一条消息（`count=2`）→ `list_messages` | 样板屏落库、golden 是 s2 正文、能回落；`400 /errors/validation`；DESIGN.md 出现 `## 约定` 与两条、`version+1`；列表含该轮 user 与 assistant（带 jobId） |
| 12 | `delete_component Footer`；`seed:job running` → `delete_project` → `cancel_job` → `delete_project`；再删 `FromPreset`；`list_projects`、`get_project` | 详情无组件；`409 /errors/project-busy`；取消后删除成功；两个项目都不在列表、详情 `404 /errors/not-found` |

后置：脚本删掉临时 PNG；证据为 `docs/test-runs/run-<RUN>-tc-agent-011.txt`（无浏览器，无截图）。

## 5. 回归策略

冒烟级 = `TC-CORE-003`、`TC-CORE-005`、`TC-CORE-010`、`TC-CORE-012`、`TC-CORE-018`、`TC-CORE-031`、`TC-PROTO-001`、`TC-AGENT-001`——建项目 → 生成 → 聚焦 → 对话改屏 → 恢复 → 一键安装冷启动，加播放与 MCP 各一条主链路。

- **全量轮**（全部用例）：首次成稿、每个里程碑出口、跨功能域改动、地基变更（环境 / 数据模型 / prelude 与 lint 规则 / 运行形态）。
- **局部轮**（受影响用例 + 冒烟级）：单一功能改动。受影响用例 = 本次设计文档改动触及的 `REQ-*` 所对应的 TC（如只改回溯逻辑 → `REQ-CORE-007` → `TC-CORE-014`、`TC-CORE-015`）；无 REQ 变更的改动按功能域圈定；影响面不确定时升级为全量轮。
- **复测轮**（上轮失败用例 + 冒烟级）：修复失败项之后。
- **人工收口轮**（仅上轮「待人工」用例：`TC-CORE-020`）：AI 轮之后由人工补测收口。

## 6. 执行记录

轮次汇总：

| 轮次 | 日期 | 被测版本 | 执行者 | 范围 | 结果 |
| --- | --- | --- | --- | --- | --- |
| RUN-001 | 2026-09-10 | 未提交工作树（M1 首版，待 commit） | AI(Claude Code) | 全量（M1 范围 = CORE 域 TC-CORE-001~022；PROTO/EDIT/AGENT 域里程碑未到不跑） | 通过 14/22 · 失败 6 · 待人工 1 · 跳过 1 |
| RUN-002 | 2026-09-10 | 未提交工作树 | AI(Claude Code) | 复测（RUN-001：TC-CORE-005、010、017、018、019、022 + 冒烟级 TC-CORE-001/003/012 + 前置依赖 TC-CORE-011/016） | 通过 9/11 · 失败 2 |
| RUN-003 | 2026-09-10 | 未提交工作树 | AI(Claude Code) | 复测（RUN-002：TC-CORE-012、022 + 冒烟级 TC-CORE-001/003/005/010/018 + 前置依赖 TC-CORE-016） | 通过 8/8 |
| RUN-004 | 2026-09-10 | 未提交工作树 | AI(Claude Code) | 局部（REQ-CORE-003 故障分支→TC-CORE-006，worker 以 `LLM_DRIVER=stub LLM_STUB=503` 启动） | 通过 1/1 |
| RUN-005 | 2026-09-10 | 未提交工作树（M2 首版） | AI(Claude Code) | 全量（PROTO 域 TC-PROTO-001~006） | 通过 4/6 · 失败 2 |
| RUN-006 | 2026-09-10 | 未提交工作树（M3 首版） | AI(Claude Code) | 全量（EDIT 域 TC-EDIT-001~006） | 通过 2/6 · 失败 4 |
| RUN-007 | 2026-09-10 | 未提交工作树 | AI(Claude Code) | 复测（RUN-005：TC-PROTO-003、004 + 冒烟级 TC-PROTO-001 + 前置依赖 TC-PROTO-002） | 通过 2/4 · 失败 2 |
| RUN-008 | 2026-09-10 | 未提交工作树 | AI(Claude Code) | 复测（RUN-006：TC-EDIT-001、002、003、005 + 前置依赖 TC-EDIT-004、006） | 通过 6/6 |
| RUN-009 | 2026-09-10 | 未提交工作树（M4/M5 首版） | AI(Claude Code) | 全量（AGENT 域 TC-AGENT-001~008） | 通过 5/8 · 失败 2 · 待人工 1 |
| RUN-010 | 2026-09-10 | 未提交工作树 | AI(Claude Code) | 复测（RUN-007：TC-PROTO-003、004 + 冒烟级 TC-PROTO-001 + 前置依赖 TC-PROTO-002） | 通过 4/4 |
| RUN-011 | 2026-09-09 | 未提交工作树 | AI(Claude Code) | 复测（RUN-009：TC-AGENT-005、007） | 通过 1/2 · 失败 1 |
| RUN-012 | 2026-09-09 | 未提交工作树 | AI(Claude Code) | 复测（RUN-011：TC-AGENT-007） | 通过 1/1 |
| RUN-013 | 2026-09-11 | 未提交工作树（设计文档 v0.6） | AI(Claude Code) | 局部轮（受影响：TC-PROTO-001~009、TC-EDIT-001/002/007 + 冒烟级 TC-CORE-001/003/005/010/012/018、TC-AGENT-001） | 通过 18/19 · 失败 1 · 待人工 1（TC-CORE-020） |
| RUN-014 | 2026-09-11 | 未提交工作树 | AI(Claude Code) | 复测（RUN-013：TC-PROTO-009） | 通过 0/1 · 失败 1 |
| RUN-015 | 2026-09-11 | 未提交工作树 | AI(Claude Code) | 复测（RUN-014：TC-PROTO-009） | 通过 1/1 |
| RUN-016 | 2026-09-11 | 未提交工作树（连线双向错开、桌面骨架微调） | AI(Claude Code) | 局部轮（TC-PROTO-002、007、008） | 通过 3/3 |
| RUN-017 | 2026-09-14 | 未提交工作树（设计文档 v0.7） | AI(Claude Code) | 局部轮（PROTO 全域 TC-PROTO-001~011，含新用例 010、011） | 通过 11/11 |
| RUN-018 | 2026-09-14 | 未提交工作树（`link` 操作「不跳转」在 `<a>` 上落为 `href="#"`） | AI(Claude Code) | 局部轮（TC-EDIT-007） | 通过 1/1 |
| RUN-019 | 2026-09-14 | 未提交工作树（设计文档 v0.8，`LLM_DRIVER=gemini` + gemini-3.1-pro-preview） | AI(Claude Code) | 局部轮（TC-CORE-001、003、005） | 通过 2/3 · 失败 1 |
| RUN-020 | 2026-09-14 | 未提交工作树（`LLM_DRIVER=gemini` + gemini-3-flash-preview） | AI(Claude Code) | 复测（RUN-019：TC-CORE-005 + TC-CORE-001、003） | 通过 3/3 |
| RUN-021 | 2026-09-14 | 未提交工作树（`LLM_DRIVER=gemini` + gemini-3.8-flash，lint 放宽 `data-href="#"`） | AI(Claude Code) | 局部轮（TC-CORE-001、003、005） | 通过 3/3 |
| RUN-022 | 2026-09-15 | 未提交工作树（gemini 驱动改走 Vertex AI 计费路径 `GEMINI_VERTEX=1`，项目 quilt-508702 / global） | AI(Claude Code) | 局部轮（TC-CORE-001、003、005） | 通过 2/3 · 失败 1 |
| RUN-023 | 2026-09-15 | 未提交工作树（GCP 账号激活后） | AI(Claude Code) | 复测（RUN-022：TC-CORE-005 + TC-CORE-001、003） | 通过 2/3 · 失败 1 |
| RUN-024 | 2026-09-15 | 未提交工作树（模型换 gemini-3.7-flash） | AI(Claude Code) | 复测（RUN-023：TC-CORE-005 + TC-CORE-001、003） | 通过 2/3 · 失败 1 |
| RUN-025 | 2026-09-15 | 未提交工作树（请求超时收紧 75 s、SDK 内部重试关闭） | AI(Claude Code) | 复测（RUN-024：TC-CORE-005 + TC-CORE-001、003） | 通过 2/3 · 失败 1 |
| RUN-026 | 2026-09-15 | 未提交工作树（全局 fetch 关闭 HTTP/2，`apps/api/src/lib/http-agent.ts`） | AI(Claude Code) | 复测（RUN-025：TC-CORE-005 + TC-CORE-001、003） | 通过 3/3 |
| RUN-027 | 2026-09-15 | 未提交工作树（设计文档 v0.9：画布外壳改为浮层 chrome） | AI(Claude Code) | 局部轮（CORE 全域 TC-CORE-001~023，含新用例 023；外壳重排波及全部走画布 UI 的用例） | 通过 18/22 · 失败 2 · 待人工 1 · 跳过 1 |
| RUN-028 | 2026-09-15 | 未提交工作树（画布可用区探针 + 聚焦保 1:1） | AI(Claude Code) | 复测（RUN-027：TC-CORE-010、018、019、023） | 通过 2/4 · 失败 2 |
| RUN-029 | 2026-09-15 | 未提交工作树（挂载即适配视图；TC-CORE-019 的 M1 断言按 M3 更正） | AI(Claude Code) | 复测（RUN-028：TC-CORE-010、018、019、023）+ PROTO 全域 TC-PROTO-001~011 + EDIT 全域 TC-EDIT-001~007 | 通过 22/22 |
| RUN-088 | 2026-09-18 | 同 RUN-087 工作树 | AI(Claude Code) | 复测（TC-CORE-022 第 2 步改到「生成通道」节后未执行过 + 前置依赖 TC-CORE-016） | 通过 2/2 |
| RUN-089 | 2026-09-19 | 未提交工作树（设计文档 v0.33：输入框可收起 `⌘/` + 聚焦态热更新；运行时 `quilt:swap` 增 `keepScroll` 与 `<head>` 比对重写） | AI(Claude Code) | 局部轮（受影响：TC-CORE-023、032 + 运行时全部消费者 PROTO 全域 11、EDIT 全域 9 + 冒烟级 TC-CORE-003/005/010/012/018、TC-CORE-031、TC-AGENT-001）——prelude 只动 swap 处理器，影响面确定，未升全量轮 | 通过 29/29 · 待人工 1 · 跳过 1（TC-CORE-032 首跑因脚本问题失败，同轮改脚本复跑通过） |
| RUN-091 | 2026-09-20 | 未提交工作树（设计文档 v0.44：字体来源——族名自由文本 + Google / 本机 / 自定义链接三种来源；迁移 `0012`） | AI(Claude Code) | 局部轮（受影响 `REQ-EDIT-003` → `TC-EDIT-005`、`TC-EDIT-010`、新 `TC-EDIT-011`；`TC-CORE-038` 无脚本未跑） | 通过 3/3（`TC-EDIT-010` 与 `TC-EDIT-011` 各首跑失败 1 次，见失败记录） |
| RUN-092 | 2026-09-20 | 未提交工作树（设计文档 v0.45：聊天模式——`kind=chat` 作业走 Agent SDK 回路 + Quilt MCP，`quilt.get_outline`，输入框动词段控；迁移 `0013`） | AI(Claude Code) | 局部轮（新 `REQ-CORE-023` → 新 `TC-CORE-039`；本机 Claude 订阅通道真实回合，模型 `claude-sonnet-5`） | 通过 1/1（三轮真实回合首跑即过：只问不改 27.1K/0.4K token、跨轮指代改一屏 68.9K/3.0K、画布发问 27.0K/0.2K；证据 `docs/test-runs/run-092-tc-core-039.png`） |
| RUN-093 | 2026-09-20 | 未提交工作树（设计文档 v0.46：共享组件——`components` / `component_uses` 表与迁移 `0014`、写入时展开 `expandComponents`、`kind=edit_component` 作业、`API-EDIT-004`、MCP `create_component` / `update_component`、画布组件卡与检查器锁） | AI(Claude Code) | 局部轮（新 `REQ-EDIT-006` → 新 `TC-EDIT-012`；`tests/e2e/components.ts`，真实回合走 Gemini 通道 `gemini-3.7-flash`） | 通过 1/1（第一次跑在步骤 1 失败：脚本按「四 tab」断言而 fixture 三屏只有三 tab，修正用例与脚本口径后重跑通过；真实回合 1.1K/0.4K token、同步 3 屏、回执「已更新组件「TabBar」，同步 3 屏：Screen 1、Screen 2、Screen 3」；证据 `docs/test-runs/run-093-tc-edit-012.png`、`run-093-tc-edit-012-canvas.png`） |
| RUN-094 | 2026-09-21 | 未提交工作树（设计文档 v0.47：多选批量移动——按在已选卡片上整组（屏 + 组件）同位移、松手逐张 PATCH 等全部有结果再决定、位置撤销栈同时记组件） | AI(Claude Code) | 局部轮（`REQ-CORE-004` → `TC-CORE-007` 增第 4～6 步；受同一手势入口与撤销栈改动影响的 `TC-CORE-018`、`TC-CORE-034`、`TC-EDIT-012`（`LIVE_LLM=0`）） | 通过 4/4（`TC-CORE-007` 前两次在第 4 步点卡片超时，都是脚本 fixture 几何问题、功能零改动：第 1 步把第 1 屏拖到了第 2、3 屏身上，中心点被盖住点不到，改为第 4 步前经 API 挪到一行之下再重载；组件放在屏上方 (0, −1000) 时适配视图后落进排列条横带被盖住，改放第 3 屏右侧 (1410, 0)；重跑整组位移 (791, 297)、第 3 屏不动、⌘Z 整组还原并 toast「已撤销移动」；证据 `docs/test-runs/run-094-tc-core-007.png`） |
| RUN-095 | 2026-09-21 | 未提交工作树（设计文档 v0.48：预览运行时注入 `*{scrollbar-width:none}*::-webkit-scrollbar{display:none}`） | AI(Claude Code) | 局部轮（`ADR-003` → `TC-CORE-010` 第 3b 步；有头 Edge，改前 / 改后同源对照） | 通过 1/1（用户报的 Ofcourt `/book-court/venue` 聚焦态：改前 `scrollbarWidth=auto`、槽宽 15 px、可滚 603 px，改后 `none`、槽宽 0、可滚 588 px，滚轮仍滚得动 400 px，屏宽由 375 回到 390；真实画布里同一张卡的改前 / 改后见 `docs/test-runs/run-095-tc-core-010-before.png`、`run-095-tc-core-010.png`，预览文档层的两张见同名 `-doc-*`。改后那张靠拦截预览响应就地换运行时取得——开发 API 是无 watch 的 `tsx src/main.ts`，要在日常使用中生效得重启它） |
| RUN-096 | 2026-09-21 | 同 RUN-095 工作树，开发 API 重启后 | AI(Claude Code) | 复测（RUN-095 的 `TC-CORE-010` 第 3b 步，这次不拦截、走真实预览下发） | 通过 1/1（预览响应本身含 `scrollbar-width:none`；聚焦 iframe 内量到 `declared=none`、槽宽 0、宽 390、可滚 588；证据 `docs/test-runs/run-096-tc-core-010.png`。用户报「还是有」的原因是 API 进程没重启——`RUNTIME_JS` 是模块常量，`tsx src/main.ts` 无 watch；另有一层是预览响应带 `Cache-Control: private, max-age=600, immutable`，已开着的标签页最长 10 分钟内仍吃旧文档，硬刷新即可） |
| RUN-097 | 2026-09-21 | 未提交工作树（设计文档 v0.49：预览响应 `no-cache`） | AI(Claude Code) | 复测（`TC-CORE-010` 第 3b、3c 步；有头 Edge，同一 context 连聚焦三次） | 通过 1/1（① 把预览响应换成改前文档 + 老的 `private, max-age=600, immutable` 头，复现用户报的现象：槽宽 15；② 换回真实服务器再聚焦，槽宽 0，走网络 2 次、命中缓存 0 次；③ 再聚焦一次仍走网络 1 次——`no-cache` 下每次聚焦都取新的。注：本轮的 ① 是拦截构造的，Playwright 拦截响应不进 HTTP 缓存，所以这轮证明的是「旧文档必然长这样」与「现在每次都取新的」，没有在浏览器里复现缓存命中本身） |
| RUN-098 | 2026-09-21 | 未提交工作树（设计文档 v0.50：工具条左组去掉 `min-w-0`） | AI(Claude Code) | 局部轮（`TC-CORE-023` 第 12 步；有头 Edge，1600 / 1280 / 1024 / 768 / 390 五个视口，改前改后各量一次） | 通过 1/1（改前 1600 下 `add-image × count-group` 相交 21×32 px、`add-image × count-1` 18×28 px，左组盒宽 270 而内容宽 383、`min-width:0px`、行数 1；改后全部视口相交为 0、左组 `min-width:auto`、行数 2，bar 无横向溢出。遗留（既有、本次未改，改前改后同为 177 px）：390 视口下输入框只分到 206 px 宽，右组档位 370 px 放不下，工具条内容横向溢出 177 px） |
| RUN-100 | 2026-09-22 | 未提交工作树（设计文档 v0.52：排列条增「排成一行」「排成一列」，固定 80 px 间距） | AI(Claude Code) | 局部轮（`REQ-CORE-018` → `TC-CORE-034` 第 2、8b～8d、9 步；同一撤销栈的 `TC-CORE-007`；冒烟级里这套环境跑得动的 `TC-CORE-003`、`TC-CORE-012`、`TC-CORE-018`、`TC-AGENT-001`（`LIVE_LLM=0`）） | 通过 6/6（`TC-CORE-034`：⌘A 后 10 键；三屏叠在 (1900, −80) 时「排成一列」→ y 依次 −80 / 844 / 1768，「排成一行」→ x 依次 1900 / 2370 / 2840，`⌘Z` 回到一列并 toast「已撤销排列」；证据 `docs/test-runs/run-100-tc-core-034.png`（截图里排列条三组十键、分隔线两道，悬停提示「按当前左右顺序排成一行，间距 80」）。跑在**打包形态的隔离栈**上——3100 / 5173 被另一会话用着，改用 `WEB_DIST=apps/web/dist` 让 3200 的 API 同端口托管前端（`QUILT_E2E_WEB` 指过去），开发实例与开发库全程未动。未跑：`TC-CORE-010`（断言预览域主机写死 `preview.localhost:3101`，本栈是 3201，按环境不成立记，非回归）、`TC-CORE-005`（要真实模型）、`TC-CORE-031`（打包冷启动）、`TC-PROTO-001`（要 3101 预览域）） |
| RUN-099 | 2026-09-21 | 未提交工作树（设计文档 v0.51：MCP 与画布同面——32 个新工具，`generate_screens` / `edit_screens` / `update_screen` / `update_project` / `update_design_system` / `create_project` 签名补齐） | AI(Claude Code) | 局部轮（`REQ-AGENT-002` → 新 `TC-AGENT-011`；纯 MCP / REST，跑在独立端口 3200 / 3201 + `quilt_test` + `LLM_DRIVER=stub` 的第二套 API 上——3100 的开发实例当时被另一会话用着，未动） | 通过 1/1（12 步全过：54 工具 / 7 资源；推屏 / 截图 / 删屏；修订取 / 回溯 / 旧基线 409；候选列 / 采用 / 整组跳过；摆放逐张成败；直改；参考图直传 / 素材建取删；作业——锚点造屏、懒生成、子树、提炼（stub 下 succeeded）、AI 改组件（succeeded）、导出 503,607 B 可下载、事件 / 取消；预设存 / 按预设建项目 / 套用回刷 / 版本过期 409 / 删；批注列 / 改 / 发 / 删；样板屏 + golden 资源 / 约定写回 / 对话记录；删组件 / 删项目 busy→409→取消→删。第一次跑在第 8 步断言错了锚点语义（脚本按「左上角 = 锚点」断言，实际与画布双击放锚点同一语义是「首屏中心 = 锚点」，落在 (4805, −422)），改脚本与用例文案后重跑通过，功能零改动；证据 `docs/test-runs/run-099-tc-agent-011.txt`。未跑：`TC-AGENT-001` / `003` / `004` / `009` 的浏览器部分（要 3100 + 5173 那套，被另一会话占用），其 MCP 部分已由 `TC-AGENT-011` 第 1、2 步覆盖） |
| RUN-101 | 2026-09-21 | 同 RUN-098 工作树 + 输入框宽度上限 680 → 880 px | AI(Claude Code) | 复测（`TC-CORE-023` 第 12 步；无头 Edge，1920 / 1600 / 1440 / 1280 / 1152 / 1024 / 900 / 768 / 390 九个视口） | 通过 1/1（工具条一行所需 695 px；1920~1440 composer 880、bar 848，1280 composer 860、bar 828，1152 composer 732、bar 700——四档均**一行**；1024 / 900 / 768 / 390 可用宽不够，折两行。全部视口控件两两相交面积为 0；证据 `docs/test-runs/run-099-tc-core-023.png`） |
| RUN-102 | 2026-09-21 | 同 RUN-101 工作树 + 宽度改为按工具条自适应、过渡期间不折行 | AI(Claude Code) | 复测（`TC-CORE-023` 第 12 步；无头 Edge，1600 与 1024 两个视口，逐帧采样切模式） | 通过 1/1（1600：`data-bar` 未置位，造态 709→聊天 480，8 个中间帧、单调，**高度全程 151 px 一个值**；1024：`data-bar=wrap` 正确置位，宽度 604↔480 单调，高度在造态两行 199 / 聊天态一行 151 之间一步到位（内容真的需要两行，非中途抖动）。修掉一处：折行判据原本 parse `--chrome-left`，自定义属性取回来是未求值的 `calc(...)` → NaN → 判断恒假，1024 下工具条会被裁掉够不到，改读画布可用区探针。证据 `docs/test-runs/run-100-tc-core-023-transition.png`） |
| RUN-103 | 2026-09-22 | 未提交工作树（设计文档 v0.53：画布视图留存 + 组件卡交互态 + `assertTestApi`） | AI(Claude Code) | 局部轮（`TC-CORE-007` 第 7 步、`TC-EDIT-012` 第 9 步；认库闸四路径自测；无头 Edge 1440×900） | 通过 3/3（① 落盘 `{x:929.87,y:-50.50,zoom:0.363}`，刷新后 transform 与刷新前逐字符一致、首 30 帧只出现一个值；② 双击组件卡：`focused` / 手势罩移除 / iframe `pointer-events:auto` / 角标「交互中 · Header Tab」，双击前后 `.world` transform 完全一致，`Esc` 退出；③ 认库闸：打 3100（`database=quilt`）拦住并点名、打 3200（`quilt_test`）放行、`ALLOW_E2E_DEV=1` 放行、连不上也拦住） |
| RUN-104 | 2026-09-22 | 未提交工作树（设计文档 v0.54：组件交互契约进 `componentSystemPrompt`） | AI(Claude Code) | 局部轮（`TC-EDIT-012` 第 10 步；机制验证 + 真实模型回合，通道 Gemini `gemini-3.7-flash`，**对测试库 3200/quilt_test**） | 通过 2/2（① 机制：手写一版 CSS-only tab 按真实组件预览文档渲染，硬校验通过、点击后字重 500→700 / 字号 16→19px / indicator opacity 0→1 转移到新条目——Tailwind Play CDN 在运行时生成 `peer-checked:` 变体，预览运行时只劫持 `<a href>` / `[data-href]` 不吃 `<label>` 的点击；② 真实回合：1.7K/2.7K token，产出 7/7 命中契约（隐藏 radio、`peer-checked:`、默认值在 `checked`、`<label>` 整块可点、`data-part`、无 script、`peer-focus-visible:` 焦点环），渲染后点第 3 条状态正确转移、容器高度 49px 前后不变；证据 `docs/test-runs/run-104-tc-edit-012-component-switch.png`。首次跑错在脚手架：消息体字段写成 `componentIds` 而非 `targetComponentIds`，被路由成 `generate` 造了 5 屏，改字段后重跑。验证用的两个测试项目已删，3200 那套临时 API 已停） |
| RUN-105 | 2026-09-22 | 同 RUN-104 工作树，开发 API 重启后 | AI(Claude Code) | 用户点名：按 v0.54 契约重做 Ofcourt 项目的 `Header Tab` 组件（真实回合，Gemini `gemini-3.7-flash`，**对开发库**——用户显式要求改他自己的组件） | 通过 1/1（v3 → v5，4.4K/2.7K token，契约 7/7 命中。渲染后鼠标点「活动」：该条 700/19px/indicator 1，原选中项三项同时回落；容器高 60px、四条各 98px，切换前后不变。键盘：焦点在选中项上按 ←，选中移到「附近」并画出焦点环。证据 `docs/test-runs/run-105-header-tab-switch.png`。中间出过一版 v4 契约 0/7——3100 那套 API 是改契约之前起的（`tsx src/main.ts` 无 watch），跑的还是旧系统提示；重启后重跑即 7/7，与 RUN-096 同一个坑） |
| RUN-106 | 2026-09-22 | 未提交工作树（设计文档 v0.55：`window.__quiltComponent` + 运行时惰性链接），开发 API 重启后 | AI(Claude Code) | 复测（`TC-EDIT-012` 第 9 步；无头 Edge，镜头经 `quilt:view` 钉到 1:1 且把组件推进可用区） | 通过 1/1（组件 v5 里 `<a>` 0 个 / `<label>` 4 个；手工注入一个 `href="#"` 并点击：toast 数 0、iframe 未跳走；tab 仍可切「推荐 → 活动」；焦点在组件内按 `Esc` 退出交互态） |
| RUN-107 | 2026-09-22 | 未提交工作树（设计文档 v0.56：组件交互态呼吸绿点） | AI(Claude Code) | 复测（`TC-EDIT-012` 第 9 步的角标断言；无头 Edge） | 通过 1/1（文字角标 0 个；绿点 9×9（8 px + 光晕）、`rgb(95,211,164)` = `--color-success`、`sk-pulse 1.2s`、`aria-label=交互中`；隔 150 ms 采样不透明度 0.93→0.71→0.45→0.35→0.43 确认在呼吸；证据 `docs/test-runs/run-107-component-live-dot.png`） |
| RUN-108 | 2026-09-22 | 未提交工作串（设计文档 v0.57：组件 qid + `API-EDIT-005` + 检查器组件态 + 选择态解除 pointer-events），开发 API 重启后 | AI(Claude Code) | 局部轮（`TC-EDIT-012` 第 11 步；无头 Edge，镜头经 `quilt:view` 钉 1:1） | 通过 1/1（启动回填给存量组件补上 18 个 qid，版本不动；画布里双击组件卡 → `⌘E` → 点「附近」→ 检查器标题「检查器 · Header Tab」、文案框读到「附近」、面板出现 `el-component-hint`；保存后版本 +1、HTML 里文案已换。中途两次失败都指向同一个真问题：组件把文字 `<span>` 设成 `pointer-events:none`，选中的永远是外层 `<label>`（无直接文案），保存文案会挂一个游离文本节点——改为选择元素态临时注入 `[data-qid]{pointer-events:auto !important}` 后一次通过；被测试弄脏的那两版已用同一个接口改回去，组件现在 tab 文案为「关注 / 推荐 / 附近 / 活动」）。遗留（已记入下方遗留问题）：直改只改所选元素，同一条 tab 的 `aria-label` 与 HTML 注释不会跟着变 |
| RUN-109 | 2026-09-22 | 未提交工作树（设计文档 v0.57 补两处：离开时打回 interact、组件 iframe 转发 ⌘E/⌘/） | AI(Claude Code) | 边界轮（`TC-EDIT-012` 第 11 步；无头 Edge + 接口直调；临时建一个组件测 A→B 切换与错误码，跑完即删） | 通过 11/11（画布：选中后 `⌘E` 退出 ✅、`Esc` 退出 ✅、双击另一个组件后前一个复位 ✅、点画布空白 ✅、带选择态刷新 ✅、只进不选就退出 ✅、退出后未聚焦的卡片点 tab 不响应（手势罩盖着）✅，六条路径组件文档里都不留选中框 / 标签 / pointer-events 样式 / crosshair；接口：版本冲突 409 `/errors/version-conflict` ✅、qid 不存在 404 `/errors/element-not-found` ✅、删根元素 400 `/errors/validation` 拒掉 ✅、`detach` 被 schema 拒掉 ✅。修掉的两条都是这轮打出来的：`⌘E` 在组件 iframe 内是死键（只转发了 Escape）、离开时没把组件运行时打回 interact。临时组件已删（204）） |
| RUN-110 | 2026-09-22 | 未提交工作树（设计文档 v0.58：10 条缺陷修复），开发 API 重启后 | AI(Claude Code) | 缺陷轮（多 agent 审查 5 个子系统 + 对抗验证给出 14 条确认项，去重后 10 个不同缺陷，逐条修复并实测） | 通过 10/10（① 选中卡片后再点内部按钮上报 q1→q2（修前第二次点击完全无效）；② 提取建组件 qid 数 3（修前 0）；③ 组件重载后光标仍 crosshair、pierce 仍在；④ 删掉激活那条链接后 active/inactive 类对仍是 `text-primary font-bold` / `text-on-surface-variant`（修前变 null|null）；⑤ 惯性平移后立刻刷新 transform 逐字符一致；⑥ 画布渲染正常、不卡在加载态；⑦⑧ 1440→820→390→1440 四档「点不到的控件」均为空数组，`data-bar` 随之在 wrap / null 间正确切换；⑨ `overflow: clip / 32px`；⑩ 作业跑着时直改 409 `/errors/component-busy`。过程中发现一次**重启假成功**：kill 后旧进程仍占着 3100，新进程 EADDRINUSE 当场退出而 `/v1/health` 照常应答，导致第一轮验证测的还是旧代码——重启脚本改为轮询确认端口空闲后再起。验证用的三个临时项目已删，剩余项目为 Ofcourt / Ofcourt Merchant / Omnivia / Demo Desktop） |
| RUN-111 | 2026-09-22 | 未提交工作树（设计文档 v0.59：`applyElementOps` 的 text op 联动无障碍名），开发 API 重启后 | AI(Claude Code) | 局部轮（`TC-EDIT-012` 第 11 步的三条新断言；核心函数四组用例 + 真实接口一遍） | 通过 4/4（① `<label><input aria-label="附近"><span>附近</span></label>` 改 span 文案 → `aria-label` 变「同城」；② 元素自带的 `aria-label` 与 `title` 一起跟；③ 图标按钮 `aria-label="关闭对话框"` 配可见「×」→ 改「✕」后无障碍名一个字未动；④ 两条同名 tab 只改被选那条，邻条的 `aria-label="附近"` 保持不变。真实接口复测：组件直改后 HTML 为 `aria-label="同城"` + `aria-label="活动"`，旧的「附近」不再出现。临时项目已删） |
| RUN-090 | 2026-09-19 | 同 RUN-089 工作树（验收反馈：输入框收起后底部不再留「显示输入框」圆钮，安全区底部占位缩到 1rem） | AI(Claude Code) | 局部轮（TC-CORE-023 第 8b~8c 步改为断言底部无浮层、工具栏同一开关双向切换） | 通过 1/1 |
| RUN-087 | 2026-09-18 | 同 RUN-086 工作树 + 打包脚本修正（`@material/material-color-utilities` 打进 bundle） | AI(Claude Code) | 复测（RUN-086：TC-CORE-031） | 通过 1/1（包 508 KB；冷启动 2017 ms、二次 1009 ms；PGlite 落库、SPA / 预览域 / MCP 就绪） |
| RUN-086 | 2026-09-18 | 同 RUN-085 工作树 + 打包脚本修正（workspace 包打进 bundle） | AI(Claude Code) | 复测（RUN-085：TC-CORE-031） | 失败 1/1 |
| RUN-085 | 2026-09-18 | 同 RUN-084 工作树 + agent 失败信息只留命令名 | AI(Claude Code) | TC-AGENT-010（真实 Claude Code，API 不带桩）+ TC-CORE-031（`npm pack` → 临时目录 `npx` 冷启动） | AGENT 1/1（真活 60 s：回写 1 屏、文案到位、不记台账）· INSTALL 0/1（`@quilt/core` 未打进 bundle） |
| RUN-084 | 2026-09-18 | 同 RUN-083 工作树 + 桩 CLI 修正 | AI(Claude Code) | 复测（RUN-083：TC-AGENT-009） | 通过 1/1（挂起持锁 / 取消杀进程释放锁 / 退出码 1 → failed(agent) / 旧基线 409 / 正常回写 succeeded + 回执 + 面板） |
| RUN-083 | 2026-09-18 | 同 RUN-082 工作树 + 脚本修正 | AI(Claude Code) | 复测（RUN-082：TC-CORE-016、019、023、026）+ 全量 PROTO / EDIT + AGENT（TC-AGENT-001 免 LLM、003、004、009，API 以桩 CLI 启动） | CORE 复测 4/4 · PROTO 11/11 · EDIT 9/9 · AGENT 3/4（TC-AGENT-009 失败） |
| RUN-082 | 2026-09-18 | 未提交工作树（v0.32 本地单用户版 M10 首版：去账号 / 去硬上限 / agentRunner / PGlite + 进程内队列 / `quilt-canvas` 打包；测试库 `quilt_test`） | AI(Claude Code) | 全量 CORE（TC-CORE-003~030，001/002/021 已推迟；LIVE gemini） | 通过 24/27 · 失败 3 · 待人工 1 · 跳过 1 |
| RUN-081 | 2026-09-18 | 同 RUN-079 工作树 + 输入框档位组可换行 | AI(Claude Code) | 复测（RUN-079：TC-CORE-005、017、022、023 + 前置依赖 TC-CORE-003、016） | 通过 6/6（TC-CORE-005 真实 gemini 造 6 屏 76 s，应用简介与样板屏落库） |
| RUN-080 | 2026-09-18 | 同 RUN-078 工作树 | AI(Claude Code) | 复测（RUN-078：TC-EDIT-001） | 通过 1/1 |
| RUN-079 | 2026-09-18 | 同 RUN-077 工作树 + 空项目屏数默认「自动」+ 工具条可换行 + TC-CORE-024 选择器改为 `target-chip` / `verb-line` | AI(Claude Code) | 复测（RUN-067 / RUN-077：TC-CORE-005、017、022、023、024） | 通过 1/5 · 失败 4（见明细：005 / 022 / 017 为 `ONLY` 子集缺前置依赖，023 为档位组自身不换行） |
| RUN-078 | 2026-09-18 | 同 RUN-077 工作树 | AI(Claude Code) | 局部轮（聚焦几何受 `--chrome-bottom` 影响：TC-EDIT-001、007） | 通过 1/2 · 失败 1（TC-EDIT-001，见明细） |
| RUN-077 | 2026-09-18 | 同 RUN-076 工作树（`--chrome-bottom` 11.5rem、Esc 兜底关弹层） | AI(Claude Code) | 局部轮（聚焦与外壳几何：TC-CORE-010、018、019、023、024） | 通过 3/5 · 失败 2（TC-CORE-023、024，修复在 RUN-079/081） |
| RUN-076 | 2026-09-18 | 同 RUN-075 工作树 | AI(Claude Code) | 复测（RUN-074：TC-PROTO-001、004 + 前置依赖 TC-PROTO-002、003） | 通过 4/4 |
| RUN-075 | 2026-09-18 | 同 RUN-074 工作树 + 覆盖层采用后焦点收回容器、画布 Esc 兜底关弹层 | AI(Claude Code) | 复测（RUN-073：TC-CORE-029） | 通过 1/1 |
| RUN-074 | 2026-09-18 | 同 RUN-073 工作树 + `--chrome-bottom` 11.5rem、TC-PROTO-001 先滚画布再点屏底按钮 | AI(Claude Code) | 复测（RUN-070：TC-PROTO-001、004） | 失败 2/2（见明细） |
| RUN-073 | 2026-09-18 | 同 RUN-072 工作树 + 新屏落地即派生地图、覆盖层行首 `scroll-margin-top` | AI(Claude Code) | 复测（RUN-069：TC-CORE-029） | 失败 1/1（见明细） |
| RUN-072 | 2026-09-18 | 同 RUN-067 工作树 | AI(Claude Code) | 全量（AGENT 域 TC-AGENT-001~009，含新用例 009） | 通过 8/9 · 待人工 1（TC-AGENT-008） |
| RUN-071 | 2026-09-18 | 同 RUN-067 工作树 | AI(Claude Code) | 全量（EDIT 域 TC-EDIT-001~009，含新用例 009） | 通过 9/9 |
| RUN-070 | 2026-09-18 | 同 RUN-067 工作树 | AI(Claude Code) | 全量（PROTO 域 TC-PROTO-001~011） | 通过 9/11 · 失败 2（TC-PROTO-001、004，见明细） |
| RUN-069 | 2026-09-18 | 同 RUN-068 工作树 + 采用前先适配视图 | AI(Claude Code) | 复测（RUN-068：TC-CORE-029） | 失败 1/1（见明细） |
| RUN-068 | 2026-09-18 | 同 RUN-067 工作树 + 脚本修正（等响应取 jobId、等候选行出现、TC-CORE-012 按目标标签断言、TC-CORE-016 在途改按增量） | AI(Claude Code) | 复测（RUN-067：TC-CORE-012、016、029、030） | 通过 3/4 · 失败 1（TC-CORE-029，见明细） |
| RUN-067 | 2026-09-18 | 未提交工作树（设计文档 v0.31：动词版 M9——generate 三合一、锚点、候选修订、目标标签粘性、设计系统约定、agent 作业映射、在途预估） | AI(Claude Code) | 全量轮（CORE 域 TC-CORE-001~030，含新用例 029 重写 / 030） | 通过 21/30 · 失败 9 · 待人工 1（TC-CORE-020）· 跳过 1（TC-CORE-006） |
| RUN-066 | 2026-09-18 | 同 RUN-065 工作树 | AI(Claude Code) | 复测（RUN-065：TC-CORE-008） | 通过 1/1（100 屏 58 fps，长任务 0） |
| RUN-065 | 2026-09-18 | 未提交工作树（设计文档 v0.30：通道下拉只给图标 + 显示名 / 画布顶栏去品牌 / 分段控件同心圆角） | AI(Claude Code) | 全量轮（CORE + PROTO + EDIT + AGENT 全域） | 通过 51/52 · 失败 1（TC-CORE-008，同 RUN-061 的长任务抖动）· 待人工 2（TC-CORE-020、TC-AGENT-008）· 跳过 1 |
| RUN-064 | 2026-09-17 | 同 RUN-063 工作树 + 多屏摆位改为「第一张在双击点、其余向右」 | AI(Claude Code) | 复测（TC-CORE-029） | 通过 1/1 |
| RUN-063 | 2026-09-17 | 未提交工作树（设计文档 v0.29：画布指针 / 设置弹层分栏 / 多屏生成改为独立屏） | AI(Claude Code) | 局部轮（受影响：TC-CORE-007、016、018、022、028、029 + AGENT 全域，含新增指针断言、tab 键盘换节断言、TC-CORE-029 重写） | 通过 13/13 · 待人工 1（TC-AGENT-008） |
| RUN-062 | 2026-09-17 | 同 RUN-061 工作树 | AI(Claude Code) | 复测（RUN-061：TC-CORE-008） | 通过 1/1（100 屏 58 fps，长任务 0） |
| RUN-061 | 2026-09-17 | 未提交工作树（设计文档 v0.28 全部：画布即主界面 + 新屏浮框 + 多版候选） | AI(Claude Code) | 全量轮（CORE + PROTO + EDIT + AGENT 全域） | 通过 51/52 · 失败 1（TC-CORE-008，见明细）· 待人工 2（TC-CORE-020、TC-AGENT-008）· 跳过 1 |
| RUN-060 | 2026-09-17 | 同 RUN-059 工作树 + 应用地图节点只列有 current 的屏 | AI(Claude Code) | 复测（RUN-059：TC-CORE-029） | 通过 1/1 |
| RUN-059 | 2026-09-17 | 未提交工作树（设计文档 v0.28 ②③：新屏浮框 + 多版候选 `REQ-CORE-014`） | AI(Claude Code) | 局部轮（新增 TC-CORE-029） | 失败 1/1（见明细） |
| RUN-058 | 2026-09-17 | 未提交工作树（设计文档 v0.28 ①：画布即主界面——项目切换器 + 设置弹层 + 层栈 inert） | AI(Claude Code) | 局部轮（受影响：TC-CORE-001、003、016、018、022、028，含新增「内层 Esc 后外层弹层仍在」「查看用量留在当前项目」断言） | 通过 6/6 |
| RUN-057 | 2026-09-17 | 未提交工作树（设计文档 v0.27：预置 / 本机通道按账号移除、可恢复） | AI(Claude Code) | 局部轮（受影响：TC-CORE-025、028，含新增第 7d 步与下拉过滤断言） | 通过 2/2 |
| RUN-056 | 2026-09-17 | 未提交工作树（设计文档 v0.26 全部修复 + 脚本改用 Radix 下拉助手） | AI(Claude Code) | 全量轮（CORE + PROTO + EDIT + AGENT 全域） | 通过 54/54 · 待人工 1（TC-AGENT-008）· 跳过 1 |
| RUN-055 | 2026-09-17 | 同 RUN-054 工作树 + 脚本修正 | AI(Claude Code) | 复测（RUN-054：TC-CORE-028、TC-EDIT-006、007 + EDIT 全域） | 通过 9/9 |
| RUN-054 | 2026-09-17 | 未提交工作树（设计文档 v0.26：本机订阅通道免 Key、探测超时分档、可用性与探测结果分离、五处下拉换 Radix） | AI(Claude Code) | 局部轮（CORE + PROTO + EDIT 全域） | 通过 44/47 · 失败 3 · 待人工 1 · 跳过 1 |
| RUN-053 | 2026-09-17 | 未提交工作树（设计文档 v0.25：生成通道可配置） | AI(Claude Code) | 全量轮（CORE + PROTO + EDIT） | 通过 44/46 · 失败 2 · 待人工 1 · 跳过 1 |
| RUN-052 | 2026-09-17 | 未提交工作树（设计文档 v0.24：本机三条通道传图 + 伴侣 ack 重试） | AI(Claude Code) | 复测 TC-CORE-025、027 + AGENT 全域（伴侣 socket / MCP / 派活 payload 受影响）+ 三条通道手工实证：① agent-sdk 带图改屏，产出三块 `rounded-lg`、0 hex、tokensIn 8948；② MCP `quilt.await_task` 结果含 image 块（3597 B，等于原图），附件资源可读、资源模板已列出；③ 伴侣 `--runner print` 提示词含本地图片路径，任务结束临时目录已清 | 通过 9/9 · 待人工 1（TC-AGENT-008）· 手工实证 3/3 |
| RUN-051 | 2026-09-17 | 未提交工作树（设计文档 v0.23：参考图输入 `REQ-CORE-012` + `emitJobEvent` 未捕获拒绝修复） | AI(Claude Code) | 局部轮（新功能跨 UI/契约/驱动/worker 四层，按全域走 CORE + PROTO + EDIT，含新用例 `TC-CORE-027`） | 通过 46/46 · 待人工 1 · 跳过 1 |
| RUN-050 | 2026-09-17 | 未提交工作树（设计文档 v0.22：字体白名单加 Archivo 并收敛为单一源、风格指南卡改报项目自己的字体） | AI(Claude Code) | 局部轮（受影响 `REQ-EDIT-003` → EDIT 全域；风格指南相关 TC-CORE-003、026） | 通过 10/10 |
| RUN-049 | 2026-09-17 | 同 RUN-048 工作树 | AI(Claude Code) | 复测（RUN-048：TC-EDIT-008） | 通过 1/1 |
| RUN-048 | 2026-09-17 | 未提交工作树（设计文档 v0.21：新建项目不再问种子色） | AI(Claude Code) | 局部轮（受影响 `REQ-CORE-002` → TC-CORE-003、004；冒烟级 TC-CORE-001、005、010、012、018、TC-PROTO-001；另加 EDIT 全域确认建后改种子色仍可用） | 通过 15/16 · 失败 1 |
| RUN-047 | 2026-09-16 | 未提交工作树（设计文档 v0.20：输入框改为视口居中、不随侧边浮层开合平移） | AI(Claude Code) | CORE 全域（TC-CORE-001~026）+ 受输入框几何影响的复测 | 通过 24/25 · 失败 1 · 待人工 1 · 跳过 1；`TC-CORE-023` 修正断言后复测通过 |
| RUN-046 | 2026-09-16 | 未提交工作树（RUN-045 缺陷修复：聚焦纵向落点改按安全区居中 / 顶到上沿；角标快捷键补齐；登录邮件接入品牌后重启 API） | AI(Claude Code) | 复测（RUN-045：TC-PROTO-001）+ PROTO 全域 + EDIT 全域 + 受聚焦几何影响的 CORE 子集（001、010、018、019、023、026） | 通过 25/25 |
| RUN-045 | 2026-09-16 | 未提交工作树（设计文档 v0.19：品牌接入——配色改走品牌语义色、Space Grotesk 自托管、字标与符号分工、骨架改 Paper→Line） | AI(Claude Code) | 局部轮（配色与字体是全局改动，走 UI 三域全量：CORE + PROTO + EDIT，含新用例 TC-CORE-026） | 通过 44/45 · 失败 1 · 待人工 1 · 跳过 1 |
| RUN-044 | 2026-09-16 | 未提交工作树（设计文档 v0.18：输入框按参考件重做、通道下拉改为 Radix Select、画布底部安全区随输入框增高） | AI(Claude Code) | 局部轮（受影响：TC-CORE-023、024、025 + 安全区变化波及的 TC-CORE-010、018、019） | 通过 6/6 |
| RUN-042 | 2026-09-16 | 未提交工作树（设计文档 v0.17：选择元素/批注改为全局模式、`⌘E` 改绑选择元素、导出取消快捷键） | AI(Claude Code) | 全量轮（CORE + PROTO + EDIT + AGENT 全域） | 通过 50/50 · 待人工 1 · 跳过 1 |
| RUN-041 | 2026-09-16 | 未提交工作树（M6 实现 + 聚焦期钉住 iframe src 的缺陷修复） | AI(Claude Code) | 全量轮（CORE + PROTO + EDIT + AGENT 全域） | 通过 49/50 · 待人工 1 · 跳过 1（TC-CORE-005 首次因模型产出未过 lint 失败，复测通过） |
| RUN-038 | 2026-09-16 | 未提交工作树（M6 实现：元素批注 + 生成通道可选） | AI(Claude Code) | 复测（RUN-037：TC-EDIT-008）+ AGENT 全域 TC-AGENT-001~008 | 通过 15/15 · 待人工 1 |
| RUN-037 | 2026-09-16 | 未提交工作树（M6 实现：`ENT-Annotation` + `API-EDIT-003` + runner 按作业解析） | AI(Claude Code) | 全量轮（CORE 全域 TC-CORE-001~025 含新用例 025 + PROTO 全域 + EDIT 全域 TC-EDIT-001~008 含新用例 008） | 通过 42/43 · 失败 1 · 待人工 1 · 跳过 1 |
| RUN-036 | 2026-09-15 | 未提交工作树（设计文档 v0.14：选择元素可直接进入、与交互态互斥、批注锚点改为一次性记录矩形） | AI(Claude Code) | 全量轮（CORE 全域 + PROTO 全域 + EDIT 全域） | 通过 40/40 · 待人工 1 · 跳过 1（TC-CORE-008 首次报长任务 4，单独复测 0） |
| RUN-034 | 2026-09-15 | 未提交工作树（设计文档 v0.11 / v0.12：Esc 取消生成、接上跳转按选中屏、框选实时高亮、退出账号移到设置页、聚焦态补元素选择提示） | AI(Claude Code) | 全量轮（CORE 全域 + PROTO 全域 + EDIT 全域） | 通过 40/40 · 待人工 1 · 跳过 1（TC-CORE-012 首次因供应商 429 失败，冷却后复测通过） |
| RUN-032 | 2026-09-15 | 未提交工作树（设计文档 v0.10：多选屏幕作上下文、快捷键分档、工具提示补作用说明） | AI(Claude Code) | 全量轮（CORE 全域 TC-CORE-001~024 含新用例 024 + PROTO 全域 + EDIT 全域；选择语义与手势改动波及全部走画布 UI 的用例） | 通过 40/40 · 待人工 1 · 跳过 1 |

明细（仅登非「通过」项）：

| 轮次 | 用例 | 结果 | 现象 / 证据 | 跟进 |
| --- | --- | --- | --- | --- |
| RUN-089 | TC-CORE-032 | 失败（脚本） | 第 3 步 `⌥D` 没开出设计系统面板：刚点过 iframe 里的链接，键盘焦点还在预览文档内，运行时只转发 Esc / Alt+←，`⌥D` 到不了父页；第 1~2 步（桩通道改屏后 iframe 原地换文案、src 不变、scrollY 保持）已通过 | 脚本改为点工具栏「设计系统」按钮开面板；同轮复跑通过（改屏后 811 ms 热更新；回刷后 /s2 原地换色、后退到 /s1 也是新色） |
| RUN-086 | TC-CORE-031 | 失败 | 冷启动进程退出：`@material/material-color-utilities` 外置后 Node 原生加载失败（它的 ESM 用无扩展名相对导入 `./dynamic_color`，只有打包器能解析） | 该包不登记为外部依赖、由 esbuild 打进 bundle；`RUN-087` 复测通过（包 508 KB，冷启动 2.0 s、二次 1.0 s） |
| RUN-085 | TC-CORE-031 | 失败 | 冷启动进程立即退出：`ERR_MODULE_NOT_FOUND @quilt/core`——esbuild 的 `packages: 'external'` 把 workspace 包也当成外部依赖留在 bundle 里，npm 安装后没有这个包 | 打包脚本改为只外置 `package.json` 里登记的第三方依赖，workspace 包一律打进 bundle；`RUN-086` 复测 |
| RUN-083 | TC-AGENT-009 | 失败 | 第 5 步（旧基线回写）拿到的是 422 `lint-failed`（`no-script`）而不是 409：桩从 `quilt.get_screen` 的完整文档里抠 body 时把 head 的 prelude 脚本一起带进了回写 HTML，lint 先于修订守卫拒掉 | 桩改为只取 `<body>…</body>` 内容并去掉 `<script>`；`RUN-084` 复测通过 |
| RUN-082 | TC-CORE-019 | 失败 | 第 4 步「应用地图不含风格指南」实际 `nodes` 里有一屏 `/dashboard`：新版 `TC-CORE-016` 在 `Demo Mobile` 上真发了一个 `generate`（无硬上限放行）并随即取消，进程内队列即刻开跑、取消前已落一屏（取消保留已产出的屏是设计内行为，§11） | 脚本：放行那一下改用独立种子项目 `Usage`；`RUN-083` 复测通过 |
| RUN-082 | TC-CORE-023 | 失败 | 第 6 步 `⌥T` 断言仍等 `panel=tasks`，新面板标识是 `panel=agent` | 脚本更正；`RUN-083` 复测通过 |
| RUN-091 | TC-EDIT-010 | 失败 | 第 3 步「回刷不该动 body」不成立：`extractBody` 取回的 `innerHTML` 自带上一次拼装的首尾换行，`assembleDocument` 再包一层 `<body>\n…\n</body>`，每回刷一次 body 就多两个空行（v0.35 起存在，该用例此前从未执行过，本轮首次暴露） | 产品修复：`assembleDocument` 对 body 两侧 `trim()`；同轮复测通过 |
| RUN-091 | TC-EDIT-011 | 失败 | 第 2 步断言「`<head>` 不含 `fonts.googleapis.com`」误判：预览运行时脚本里有 `link[href*="fonts.googleapis.com/css"]` 这个选择器字面量，字符串永远命中 | 脚本更正为只认 `<link href="https://fonts.googleapis.com` 标签本身；同轮复测通过 |
| RUN-082 | TC-CORE-026 | 失败 | 第 1、2 步移到套件开头量 PAGE-FIRST 后，用例尾部仍引用旧变量 `wm`（`ReferenceError`） | 脚本更正（外壳字体常量化、备注复用首屏结论）；`RUN-083` 复测通过，符号 96 px、六组对比度 ≥ 4.78 |
| RUN-001 | TC-CORE-005 | 失败 | 第 2 步预期全部屏 lint 通过，实际脚本在第 6 屏生成完成前就断言（`lintPassed` 为 null）；作业本身成功、数据库无 lint 未过修订；证据：执行输出（本轮脚本失败时未截图，RUN-002 起已修正） | 测试脚本时序修正（先等助手消息「已生成」），RUN-002 复测通过 |
| RUN-001 | TC-CORE-010 | 失败 | 第 2 步预期 iframe 内按钮可点，实际点击超时；根因：`CanvasView` 每次父组件渲染都重建 XYPanZoom 实例，聚焦推镜头到 1:1 被打断，画布停在 50%（冒烟截图 `docs/test-runs/smoke-focused.png` 可见）；证据：同上 | 前端缺陷，修复于 `CanvasView.tsx`（回调经 ref 稳定化），RUN-002 复测通过 |
| RUN-001 | TC-CORE-017 | 失败 | 前置构造用全量 `seed` 清用量，连会话一起清掉 → API 401；证据：执行输出 | 测试脚本改用 `seed:quota --reset`（新增），RUN-002 复测通过 |
| RUN-001 | TC-CORE-018 | 失败 | 同 TC-CORE-017（会话失效后页面跳登录）；证据：执行输出 | 同上，RUN-002 复测通过 |
| RUN-001 | TC-CORE-019 | 失败 | 同 TC-CORE-017；证据：执行输出 | 同上，RUN-002 复测通过 |
| RUN-001 | TC-CORE-022 | 失败 | 第 2 步预期设置页显示 300/300，实际本轮已生成 6 屏为 306/300，断言过严；产品行为（禁用 + 引导）正确；证据：执行输出 | 断言改为 ≥ 300/300，RUN-003 复测通过（`docs/test-runs/run-003-tc-core-022.png`） |
| RUN-001 | TC-CORE-020 | 待人工 | 对标 Stitch 盲评为主观判定，AI 按纪律跳过；素材：`docs/test-runs/run-003-tc-core-005.png`（Pet 项目 6 屏） | 待 Owner 人工收口轮 |
| RUN-001 | TC-CORE-006 | 跳过 | 需 worker 以 stub 503 模式启动，与全量轮环境冲突 | RUN-004 单独执行通过（`docs/test-runs/run-004-tc-core-006.png`） |
| RUN-002 | TC-CORE-012 | 失败 | 第 2 步预期助手消息「已更新 1 屏」，实际 120 s 未出现；作业 26 s 已成功；根因：`refresh()` 在中间事件时把 `activeJob` 置空、提前关闭 SSE，丢失终态事件（RUN-001 通过属时序运气）；证据：执行输出 + 数据库作业记录 | 前端缺陷，修复于 `Canvas.tsx`（终态由 SSE 宣告，refresh 发现作业消失时同步刷新消息），RUN-003 复测通过 |
| RUN-002 | TC-CORE-022 | 失败 | 同 RUN-001（断言 300/300 过严，实际 306/300）；证据：执行输出 | RUN-003 复测通过 |
| RUN-002 | TC-CORE-020 | 待人工 | 同 RUN-001 | 待人工收口轮 |
| RUN-003 | TC-CORE-020 | 待人工 | 同 RUN-001 | 待人工收口轮 |
| RUN-005 | TC-PROTO-003 | 失败 | 第 3 步断言「断链标记消失」错误：把 /s2 改成 /settings 后，原指向 /s2 的 5 条链接反而成为断链（产品行为正确）；证据 `docs/test-runs/run-005-tc-tc-proto-003-fail.png` | 断言改为「不再标 /settings」，RUN-007 复测 |
| RUN-005 | TC-PROTO-004 | 失败 | 因 TC-PROTO-003 断言先抛错，脚本未执行「改回 /s2」，/settings 仍存在 → 点击直接跳转而非弹生成对话框；证据 `docs/test-runs/run-005-tc-tc-proto-004-fail.png` | 随 003 修正，RUN-007 复测 |
| RUN-006 | TC-EDIT-001 | 失败 | 脚本点「保存」后未等请求完成即查修订（截图中按钮仍在转圈）；产品行为正确；证据 `docs/test-runs/run-006-tc-tc-edit-001-fail.png` | 脚本改为等待「已更新」提示，RUN-008 复测通过 |
| RUN-006 | TC-EDIT-002 | 失败 | 脚本取 qid 的正则假设 `data-qid` 在属性末尾，linkedom 序列化把它放在最前 → qid 为空 → 404；证据 `docs/test-runs/run-006-tc-tc-edit-002-fail.png` | 正则兼容两种顺序，RUN-008 复测通过 |
| RUN-006 | TC-EDIT-003 | 失败 | 同 TC-EDIT-002（qid 正则）；证据 `docs/test-runs/run-006-tc-tc-edit-003-fail.png` | RUN-008 复测通过 |
| RUN-006 | TC-EDIT-005 | 失败 | 第 2 步预期对话出现「设计系统已回刷 10 屏」，实际经 API-CORE-006 直接创建的作业不写对话消息——产品缺口（回刷/导出/局部重生成/懒生成无可见反馈）；证据 `docs/test-runs/run-006-tc-tc-edit-005-fail.png` | 产品修复：此类作业也写入对话记录（设计文档 v0.5 ④），RUN-008 复测通过 |
| RUN-007 | TC-PROTO-003 | 失败 | 第 4 步预期占用路由返回 409，实际 500：drizzle 0.45 把 pg 唯一冲突包在 `error.cause`，`code` 判定没接住；证据 API 日志 `duplicate key … screens_project_route_uq` | 产品修复：统一 `isUniqueViolation`（两层判定），RUN-010 复测 |
| RUN-007 | TC-PROTO-004 | 失败 | 同 RUN-005（被 003 中断连带）；证据 `docs/test-runs/run-007-tc-proto-004-fail.png` | RUN-010 复测 |
| RUN-009 | TC-AGENT-005 | 失败 | 脚本解析长轮询输出时只取最后一行，而工具返回的是多行 JSON；领取本身成功；证据 执行输出 | `mcp:await` 改为输出紧凑 JSON，RUN-011 复测 |
| RUN-009 | TC-AGENT-007 | 失败 | 脚本从 deeplink 命令里抠 onceToken 的正则未考虑被转义的引号；证据 执行输出 | API-AGENT-008 响应增加 `onceToken` 字段（设计文档 v0.5 ③），脚本改用该字段，RUN-011 复测 |
| RUN-009 | TC-AGENT-008 | 待人工 | 通道自动化部分通过：`quilt connect --runner print` 出站连接 → 派活即推送 → ack 领取（claimedBy=companion:…）→ 完成；注入运行中 Claude Code 会话与拉起新会话需真机 | 待人工收口轮 |
| RUN-011 | TC-AGENT-007 | 失败 | 第 3 步用一次性 token 领取返回 410：脚本先经 API 签发 token，再点「用 Claude Code 打开」又签发一枚，每任务只保留最新一枚，先前那枚已作废（符合 `API-AGENT-008` 契约）；证据 `docs/test-runs/run-011-tc-agent-007-fail.png` | 脚本改为从界面显示的命令里取 token，并把派活项目夹具抽为共用前置（单跑用例不再依赖 TC-AGENT-005），RUN-012 复测 |
| RUN-013 | TC-PROTO-009 | 失败 | 第 2 步等「已生成」超时 240 s：作业本身 37 s 成功且「Continue」已带 `data-href="/s2"`，但顶栏直发的 `edit_screens` 作业没有对话记录（`describeJob` 未覆盖该类型），且脚本等的文案应为「已更新」；证据 `docs/test-runs/run-013-tc-proto-009-fail.png` | 产品修复：直发 `edit_screens` 也写对话记录（补链显示「补链：把 N 屏的按钮 / 表单连上路由」）；脚本改等「已更新」，RUN-014 复测 |
| RUN-014 | TC-PROTO-009 | 失败 | 第 1 步 5 s 内对话面板未出现「补链：…」：记录已落库，但顶栏发起作业后前端只在作业结束时刷新消息；证据 `docs/test-runs/run-014-tc-proto-009-fail.png` | 产品修复：发起作业后立即刷新对话面板（补链 / 导出 / 回刷 / 懒生成同受益），RUN-015 复测 |
| RUN-019 | TC-CORE-005 | 失败 | 第 2 步 150 s 内屏未就绪：gemini-3.1-pro-preview 首屏耗时 172 s，其余屏触发 180 s 超时重试；同一契约提示单独对比 6 种配置，3.1-pro 还写 arbitrary value / 外链违规；证据 `docs/test-runs/run-019-tc-core-005-fail.png`、作业事件 | 换模型 gemini-3-flash-preview（10–17 s / 屏，契约通过），RUN-020 复测 |
| RUN-022 | TC-CORE-005 | 失败 | 第 2 步 90 s 内截图卡片不足：作业本身成功、6 屏契约首次全过，但耗时 172 s（≥5 屏截图在 145 s）。同一提示实测 Vertex 路径并行 4 屏被排队串行（18 / 39 / 67 / 86 s），串行单屏 36 s，均慢于 AI Studio 路径（13–16 s / 屏、6 屏 118 s）；证据 作业事件时间线、`docs/test-runs/run-022-tc-core-005-fail.png` | 疑为免费试用账号的配额限制：激活完整账号或申请 gemini-3.8-flash 的每分钟请求配额后复测；期间开发可切回 AI Studio 路径（`GEMINI_VERTEX=` 留空） |
| RUN-023 | TC-CORE-005 | 失败 | 激活账号后仍超时：作业 213 s 成功，4 屏 html 每 25–35 s 到一屏；关掉 SDK 重试后独立进程 4 路并发 3 路正常 1 路 `429 RESOURCE_EXHAUSTED`；证据 `docs/test-runs/run-023-tc-core-005-fail.png` | 换 gemini-3.7-flash（独立进程 4 路并发 20–26 s 零 429），RUN-024 复测 |
| RUN-024 | TC-CORE-005 | 失败 | 换模型后仍超时（215 s）：worker 内加时间日志证实 4 路同时发出、却在 34 / 70 / 99 / 138 s 依次返回；独立进程同一封装 4 路 30 s 并行完成；证据 `docs/test-runs/run-024-tc-core-005-fail.png`、API 日志 | 收紧超时 75 s 并关闭 SDK 内部重试以暴露真实错误，RUN-025 复测 |
| RUN-079 | TC-CORE-005 / 022 / 017 | 失败 | `ONLY` 子集缺前置：005 的 `petProjectId` 由 003 建、022 的 300/300 用量由 016 种、017 的 `seed:job` 撞上 022 留下的进行中 generate 作业（`generation_jobs_active_project_uq`）；均为脚手架依赖，非产品缺陷 | `RUN-081` 连同 003、016 一起复测通过 |
| RUN-079 | TC-CORE-023 | 失败 | 390px 视口横向溢出 72px：工具条已允许换行，但右侧档位组自身 `shrink-0` 且 370px 宽（屏数 + 版数 + 发送），比 ≤ 48rem 时约 240px 的输入框还宽 | 产品修复：档位组改为 `min-w-0 flex-wrap justify-end`，各控件可折行；`RUN-081` 复测通过 |
| RUN-078 | TC-EDIT-001 | 失败 | ⌘E 后单击卡片 20 s 内未进入「选择元素中」：截图为模式已开、卡片未选中——点击落在首批屏到达后的 300 ms 适配视图动画期间；`RUN-071` 同一脚本通过 | 原样复测通过（`RUN-080`），不改代码 |
| RUN-077 | TC-CORE-023 / 024 | 失败 | 023：390px 横向溢出 80px（新增的屏数 / 版数档位组不换行）；024：脚本仍按旧结构找 `ul[aria-label="本次对话的目标屏"]`，新输入框的目标区标签是 `target-chip`、单屏也列标签 | 023 产品修复（工具条 + 档位组换行）；024 脚本改用 `target-chip` / `verb-line`；`RUN-079` / `RUN-081` 复测通过 |
| RUN-074 | TC-PROTO-001 | 失败 | 输入框因目标区常驻增高到 162px，1000px 视口里聚焦屏底的「Go to /s2」压在输入框底下，跨域 iframe 内的点击被输入框接走（与 `RUN-045` 同类）；本轮脚本已加「滚画布露出按钮」但滚轮落点在对话面板上、滚的是面板 | `--chrome-bottom` 调到 11.5rem；脚本改为用 `elementFromPoint` 找画布空白点再滚；`RUN-076` 复测通过 |
| RUN-074 | TC-PROTO-004 | 失败 | 页面 404：`ONLY` 子集缺 TC-PROTO-002（它建 `mapProject`），`/p/` 空 id | `RUN-076` 连同 002、003 复测通过 |
| RUN-073 | TC-CORE-029 | 失败 | 第 5 步覆盖层里「采用这一版」点不到：`scrollIntoView` 把该行顶到 sticky 列头底下，每格上方的动作条被列头遮住；随后又发现采用后按钮消失、焦点掉到 body，`Esc` 关不掉弹层 | 产品修复：行首 `scroll-margin-top`、动作条放缩略图上方、采用后焦点收回容器、画布 Esc 兜底关弹层；`RUN-075` 复测通过 |
| RUN-070 | TC-PROTO-001 | 失败 | 同 `RUN-074` 的根因（输入框增高压住屏底按钮） | 见 `RUN-074` |
| RUN-070 | TC-PROTO-004 | 失败 | 「生成后断链未解析」：脚本在新屏截图到达时就查地图，而作业此时还在对入口屏 `/s1` 跑反向连线（真实 LLM，20–40 s），`deriveLinks` 在作业收尾才跑 | 产品修复：新屏落地即派生地图，不等反向连线；脚本另等作业终态；`RUN-076` 复测通过 |
| RUN-069 | TC-CORE-029 | 失败 | 候选角标点不到：锚点由双击点决定，新卡片落在对话面板底下 | 脚本在点角标前先「适配视图」；`RUN-073` 继续暴露覆盖层问题 |
| RUN-068 | TC-CORE-029 | 失败 | 角标 `click` 30 s 超时：卡片压在对话面板下（同上） | 见 `RUN-069` |
| RUN-067 | TC-CORE-029 / 030 | 失败 | 029：`waitForRequest` 在请求发出即返回，`activeJobs` 里还没有作业；030：覆盖层 `waitFor` 在数据到达前就数行 | 脚本改为等响应取 jobId、等 `candidate-row` 出现；`RUN-068` 复测 030 通过、029 继续暴露布局问题 |
| RUN-067 | TC-CORE-012 | 失败 | 脚本等旧文案「目标：Screen 3 /s3」，新输入框的目标区是标签 + 动词行 | 脚本改按 `target-chip` / `verb-line` 断言；`RUN-068` 复测通过 |
| RUN-067 | TC-CORE-016 | 失败 | 在途预估断言写死 8 屏，账号名下还有别的用例留下的进行中作业（实际 11） | 脚本改按增量断言；`RUN-068` 复测通过 |
| RUN-067 | TC-CORE-005 | 失败 | **产品缺陷**：空项目首轮只造了 1 屏——前端屏数档位默认 1 且总是随请求发送，服务端只在 `count` 缺省时取「自动」，设计要求空项目默认自动 | 产品修复：前端按项目此刻是否为空取默认档位（空 → 自动、非空 → 1）；`RUN-081` 复测通过（6 屏） |
| RUN-067 | TC-CORE-023 | 失败 | 390px 横向溢出 80px（新档位组） | 见 `RUN-077` / `RUN-079` |
| RUN-067 | TC-CORE-024 | 失败 | 脚本旧选择器（见 `RUN-077`） | 见 `RUN-077` |
| RUN-067 | TC-CORE-022 / 017 | 失败 | 022：016 失败后未取消种子作业，Demo Mobile 挂着 queued generate → 022 的发送被 `screen-busy`/占位挡住、`#chat-input` 不可填；017 的 `seed:job` 撞唯一索引 | 016 修正后连锁消失；`RUN-081` 复测通过 |
| RUN-065 | TC-CORE-008 | 失败 | 与 `RUN-061` 同一现象：100 屏画布平移缩放录到 1 个 > 50ms 的长任务，fps 达标。本轮改动只碰顶栏、下拉项与浮框圆角，不在该用例的渲染路径上 | 不改代码；`RUN-066` 单独复测通过（58 fps，长任务 0） |
| RUN-061 | TC-CORE-008 | 失败 | 画布 100 屏平移缩放的性能门槛：fps 达标、但录到 1 个 > 50ms 的长任务。同一轮里 TC-CORE-005 刚跑完 5 屏生成，worker 的 Edge 截图进程与页面共用一台机器；本轮对画布渲染路径的改动只有双击处理器与候选分支（该用例无候选），无因果路径 | 不改代码；`RUN-062` 单独复测通过（58 fps，长任务 0） |
| RUN-059 | TC-CORE-029 | 失败 | 第 4 步「未选定的候选屏进了应用地图」：`GET …/app-map` 的节点取的是项目下全部屏，没有 current 的屏（生成中、候选未选定）也在内，与设计文档「未选定前不进应用地图」不符；另在人工核验时发现 3 版并行落库撞 `screen_revisions_screen_seq_uq` 唯一键（同屏两笔事务算出同一 `seq`），导致只落 1 版、作业失败 | 应用地图节点改为只列有 current 的屏；`createRevision` 先对屏行 `select … for update` 再算 `seq`。`RUN-060` 复测通过 |
| RUN-054 | TC-CORE-028 / TC-EDIT-006 / TC-EDIT-007 | 失败 | 三条同一根因：仓内五处原生 `<select>` 改为 Radix Select 后，脚本里的 `page.selectOption` / `inputValue()` 驱动不了按钮式触发器，报「Element is not a select」。产品行为正确，是脚本欠账 | `tests/e2e/lib.ts` 增 `pickOption`（按可见文案点选）与 `selectedValue`（读触发器 `data-value`）两个助手，四处调用点改用；另有一条「类型下拉不是原生 select」的断言写在了画布页步骤里（那里没有该元素），挪回弹层打开的步骤。`RUN-055` 复测通过 |
| RUN-053 | TC-PROTO-004 / TC-PROTO-005 | 失败 | 004 的失败截图显示「生成失败（provider）：gemini fetch failed」，API 日志对应 `Client network socket disconnected before secure TLS connection was established`（`ECONNRESET`），是连 Gemini 的网络中断；005 为导出用例，同一时段受牵连超时。与本轮改动无因果路径 | 不改代码；`RUN-054`、`RUN-056` 两轮原样通过 |
| RUN-052 | 伴侣通道实证 | — | 四次派活里有一次伴侣 ack 被回 `task.gone`，而服务端任务仍 queued、无人认领；进程内立即 `claimById` 与其后两次 socket 路径均正常。判定为 `tryClaim` 的 `FOR UPDATE SKIP LOCKED` 与每分钟一次的租约/过期扫描撞锁——可领的行被当作已锁跳过。伴侣重连后该任务被补发并完成（设计内的兜底生效） | 产品加固：ack 处理在空手且任务仍 queued 时 200 ms 后重领一次；伴侣不再因瞬时锁竞争放弃 |
| RUN-051 | 全部 | — | 首次执行整轮 `fetch failed`：API 进程在上一轮结束时已崩——`pnpm seed` 清库删掉作业后，worker 仍在给它写 `job_events`，外键冲突经 `emitJobEvent` 的 `.finally()` 派生链变成未捕获拒绝，直接终止进程。属既有缺陷，本次改动只是把它触发了出来 | 产品修复：清理链表项改用 `then(cb, cb)`（派生 promise 总是 resolve），重试回调显式吞掉错误；重启后整轮 46/46 通过 |
| RUN-048 | TC-EDIT-008 | 失败 | 批注合成的 `edit_screens` 作业以 `errorClass=provider`、`gemini fetch failed` 收尾，属供应商网络错误；与本轮改动（摘掉建项目表单里的种子色字段）无因果路径 | 原样复测通过（`RUN-049`），不改代码 |
| RUN-047 | TC-CORE-023 | 失败 | 本轮新加的断言写死成「右侧面板滑出也不许移动输入框」，实测挪了 32 px。核对后是断言错、实现对：宽视口下面板左缘会压到输入框右缘，`clamp` 的上界正确地让了位，且只让到留出外壳本来的 1rem 间距为止；设计文档 v0.20 写的就是「只在真会被压住时让位」 | 断言改为检验「不重叠 + 不过度退让」（与面板间距 ≤ 24 px），复测通过；实现未改 |
| RUN-045 | TC-PROTO-001 | 失败 | 聚焦 `/s1` 后点「Go to /s2」无反应，等 `/s2` 角标 10 s 超时——**产品缺陷**：聚焦的纵向落点一直按「顶栏以下的全部高度」居中，屏底本就压在底部输入框下；v0.18 输入框由约 104 px 变到 152 px 后，屏底的主按钮整个进了输入框底下。跨域 iframe 内的点击按视口坐标派发，落点被输入框接走，所以点击不报错、只是什么也没发生；证据 `docs/test-runs/run-045-tc-proto-001-fail.png` | 产品修复：聚焦纵向改为在安全区（已让开输入框）内居中，屏高于安全区时顶到上沿，把不可避免的遮挡全留给屏底可滚动区；`RUN-046` 复测通过 |
| RUN-041 | TC-CORE-005 | 失败 | 6 屏已生成并保留，但其中 1 屏 repair 后仍未过设计契约 lint，作业以 `生成失败（lint）` 收尾，「已生成」文案未出现；属换模型后的产出质量波动（§3 已注明「规则与 lint 仍按 claude-sonnet-5 调校，换模型后通过率以 TC-CORE-005 为准」），非代码缺陷 | 原样复测通过（6 屏 72 s），不改代码 |
| RUN-040 | TC-EDIT-001 | 失败 | 直改后 iframe 未显示新文案：为修 TC-EDIT-008 而把聚焦期的 iframe `src` 钉住后，元素直改不再靠「签名 URL 变化」这个副作用触发重载；且首版修复在 `await refresh()` 后同步读 `propsRef`，拿到的是上一轮渲染的旧 `previewUrl`，重载出旧修订 | 产品修复：`onEdited` 显式重载聚焦屏；`resetToOwn` 改为清空钉住值、由 effect 用当轮 props 重新钉住。脚本改为等新文案出现而非固定 sleep |
| RUN-039 | TC-EDIT-008 | 失败 | 保存过一条批注后再点别的元素，选中始终停在第一个 qid（遍历 60 个带 qid 元素都不变）——**产品缺陷**：`previewUrl` 是签名 URL，每次 `refresh()` 都换新签名，`src` 一变 iframe 就静默重载并掉回 `interact` 模式，选择元素/批注态当场失效（元素直改路径本就有此问题，既有用例只改一次故未暴露） | 产品修复：聚焦期钉住 `src`，且每次收到 `quilt:ready` 都重发当前模式；用例增「两条批注 qid 必须不同」断言把它钉死 |
| RUN-037 | TC-EDIT-008 | 失败 | 点选元素后批注输入框仍禁用：`quilt:mode inspect` 是在 iframe ready 之后才发给预览运行时的，脚本抢在它送达前就点了，那一下被当成普通交互而非选中——脚本时序问题，非实现缺陷（单跑同一用例通过） | 脚本加 `pickElement` 重试：点完等批注输入框可用，不行就隔 500 ms 再点，最多 5 次；RUN-038 复测通过 |
| RUN-036 | TC-CORE-008 | 失败 | 100 屏平移缩放报长任务 4（fps 断言先过，即帧率达标 ≥55）；本机当时刚连跑完 EDIT/PROTO 两套且 dev server 长驻，属机器负载噪声 | 静置 30 s 后单独复测 `59 fps / 长任务 0` 通过，不改代码；同一用例 RUN-027/032/034 均为长任务 0 |
| RUN-036 | TC-EDIT-001 / TC-EDIT-007 | — | 首次执行因脚本绑在旧模式语义上失败（角标文案仍断言「交互中」、退出选择元素后仍假定停在交互态），非实现缺陷 | 脚本按新语义更正：保存时断言「选择元素中」、退出选择元素后断言卡片回到静态并重新双击进交互；TEST.md 中 `TC-EDIT-007` 步骤同步拆分 |
| RUN-034 | TC-CORE-012 | 失败 | 第 2 步 120 s 未出现「已更新 1 屏」：作业以助手消息报 `gemini 429 RESOURCE_EXHAUSTED`（Vertex 配额），产品的失败呈现路径正确（§13 关键页态「错误 = 作业失败以助手消息呈现」）；本轮同一会话内反复跑生成用例打满了配额，非代码缺陷；证据 `docs/test-runs/run-034-tc-core-012-fail.png` | 冷却约 3 分钟后原样复测通过，不改代码 |
| RUN-032 | 全部 | — | 首次执行时整轮被 magic link 发送限流连坐（同一邮箱每小时 5 条，`loginAs` 也占额度），`pnpm seed` 并不清 `magic_links`（它按邮箱存、不随用户级联删除），导致整套用例一小时内跑不了第二遍 | 脚手架修复：`pnpm seed` 一并清掉两个测试账号的 `magic_links`（§3 已注明）；清后整轮复跑全绿 |
| RUN-027 | TC-CORE-018 | 失败 | 第 2 步点 `/s1` 卡片 30 s 超时：画布改为铺满视口后「适配视图」仍按整块画布算，最左侧屏被推到左侧对话记录浮层底下，点击被浮层截走；证据 `docs/test-runs/run-027-tc-core-018-fail.png` | 产品修复：新增可用区探针（四边跟随浮层占位的 CSS 变量），`fitView` 与聚焦都以可用区为准，RUN-028 复测通过 |
| RUN-027 | TC-CORE-019 | 失败 | 同上，点风格指南卡片超时；根因除可用区外还有一条：空项目从不触发适配视图（旧逻辑只在首批屏到达时适配一次），卡片停在世界坐标负半轴、被挤出视口左缘；证据 `docs/test-runs/run-027-tc-core-019-fail.png` | 产品修复：挂载即适配一次，RUN-029 复测通过 |
| RUN-027 | TC-CORE-020 | 待人工 | 同 RUN-001 | 待人工收口轮 |
| RUN-028 | TC-CORE-010 | 失败 | 聚焦后画布停在 0.78 而非 1:1，iframe 内点击坐标偏移超时：上一轮把可用区的上下内边距也算进了聚焦缩放，390×844 的手机屏被底部输入框的占位压缩；证据 执行输出 | 产品修复：聚焦缩放横向让开左右浮层、纵向只让开顶栏（底部输入框是浮层，允许压住屏底），RUN-029 复测通过 |
| RUN-028 | TC-CORE-019 | 失败 | 断言「M1 无任何编辑控件」不成立：该断言写于 M1 面板只读期，M3 的 `REQ-EDIT-003` 已按设计给面板加上保存 / 回刷；本用例自 RUN-003 后未再执行，漂移至今未暴露（非本轮改动引入） | 用例更正：改为断言回刷入口存在，编辑与回刷行为仍由 `TC-EDIT-005` 覆盖，RUN-029 复测通过 |
| RUN-028 | 全部 | 失败 | 首次执行时 `TC-CORE-001` 因 magic link 发送频率限制（「发送太频繁，请一小时后再试」）拿不到会话，其余用例连坐超时——测试脚手架缺口，非产品缺陷 | 脚本修复：`ONLY` 模式下若滤掉 `TC-CORE-001`，改用种子链接直接建立会话（绕开发送频率限制） |
| RUN-025 | TC-CORE-005 | 失败 | 作业失败（247 s）：6 次「operation was aborted」（请求超 75 s）+ 1 次 429；禁用截图、去掉代理环境变量均不改善；同进程实验复现「预热请求后立刻并发 → 串行，闲置 45 s 后并发 → 并行」，定位为 Node 26 内置 fetch 默认 HTTP/2 复用同一连接被逐个处理，`allowH2:false` 后两轮 4 路并发均 26 s 内完成；证据 `docs/test-runs/run-025-tc-core-005-fail.png`、作业事件 | 产品修复：API / worker 启动即 `setGlobalDispatcher(new Agent({ allowH2: false }))`，请求超时恢复 120 s、SDK 重试恢复默认，RUN-026 复测（6 屏 74 s，首次 5/6 过契约） |

## 7. 遗留问题


- **对话记录折叠横条的进度未修**（v0.38 查出，实现与设计文档 §13 不符）：`Canvas.tsx` 给 ChatDock 的 `status` 在「恰好一个作业在跑且它还没有进度文案」时是 `null`，横条于是退回「对话 · N 条」。在跑作业行已按 v0.38 兜底写「排队中…」，横条那一路的兜底要在 Canvas 侧收敛（把「空进度说什么」收成一个出处），暂无用例覆盖。
- **整组造屏的入口屏仍可能撞修订冲突**（设计文档 §16 真值表缺口行）：规划器返回的 `entryFrom` 在作业跑起来之后才知道，前端的覆盖屏集与后端的 `target_screen_id` 都看不见它；现无自动用例，触发后表现为改屏作业 `failed（revision conflict）` 或入口屏的跳转静默没接上。
- 本机 agent 的投递通道（Claude Code 会话登记处 + inbox socket）未文档化：`TC-AGENT-009` 用假会话验的是 Quilt 这一侧的读法与写法，真实会话只有 `TC-AGENT-010`（人工）能证明；Claude Code 升级后若该用例失败，先查登记文件格式与 `peerProtocol`（设计文档 §28 风险）。Codex 未接入（v0.34 推迟，`codex queue --thread` 是文档化的投递命令）。
