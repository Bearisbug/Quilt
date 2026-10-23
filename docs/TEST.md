# Quilt 测试文档

> AI 与人工共用的功能验收执行脚本与台账。用例由 `docs/DESIGN.md` 的 `REQ-*` 与 §19 Gherkin 场景派生；域段与设计文档一致（`CORE`=M1、`PROTO`=M2、`EDIT`=M3、`AGENT`=M4/M5）。

## 1. 元信息 / 变更记录

| 字段 | 值 |
| --- | --- |
| 状态 | 生效（设计文档 v1.39：v1.35 的源自缺陷用例 `TC-AGENT-025` 修复前 RUN-303 失败、RUN-304 通过；v1.37 的 `TC-CORE-160` 修复前 RUN-305 失败、RUN-306 通过；v1.34 带出的回归（无指针位置的点击选成页面根）在 RUN-306、307 由 `TC-CORE-119`、`TC-EDIT-001`、`032` 查出，v1.39 修复后 RUN-308 通过；RUN-308 满载下的五条失败在复测轮 RUN-309 全过；§7 登记的 `TC-CORE-010`、`040`、`023` 仍在；需真实模型的 5 条与 `006`（单独执行）跳过；`TC-CORE-020` / `TC-AGENT-010` 待人工） |
| Owner | @bug |
| 关联设计文档 | `docs/DESIGN.md` |
| 被测系统 | `~/Documents/Projects/Quilt`（Web 画布 + API/MCP 服务 + Worker + 预览域服务） |
| 最后更新 | 2026-10-22（设计文档 v1.39，登记 RUN-303～309） |

变更记录（登用例增改，不登执行轮次）：

更早的记录在 `docs/CHANGELOG.md`；本表只留最近 5 条。

| 日期 | 改动 | 作者 |
| --- | --- | --- |
| 2026-10-22 | 设计文档 v1.38（草稿本选元素开着、一块没选时 Esc 关掉选元素）：`TC-CORE-122` 第 3 步加第二下 `Esc` | @bug |
| 2026-10-22 | 设计文档 v1.37（选元素时滚动，悬停框跟到指针下的元素）：新增源自缺陷用例 `TC-CORE-160`（在 `tests/e2e/sketch.ts`，草稿桩加「长列表」一句） | @bug |
| 2026-10-22 | 设计文档 v1.35（MCP 的 GET 与 DELETE 回 405）：新增源自缺陷用例 `TC-AGENT-025`（在 `tests/e2e/mcp.ts`） | @bug |
| 2026-10-22 | 设计文档 v1.36（作业完成的 chip 收窄到正好包住文字）：`TC-CORE-157` 第 2 步加宽度与左缘，第 3 步加悬停时向右展开 | @bug |
| 2026-10-22 | 设计文档 v1.34（选元素不被全透明的遮罩挡住）：新增源自缺陷用例 `TC-CORE-158`（在 `tests/e2e/sketch.ts`，草稿桩加「抽屉」一句） | @bug |

## 2. 测试范围 / 不测什么

- 覆盖：Quilt 全部功能域的黑盒功能验收——Web 画布（浏览器）、REST API（curl）、MCP 工具（脚本客户端）、预览域；对应设计文档 `REQ-CORE-002`~`REQ-CORE-017`、`REQ-PROTO-001`~`REQ-PROTO-004`、`REQ-EDIT-001`~`REQ-EDIT-004`、`REQ-AGENT-002`~`REQ-AGENT-003`、草稿本 `REQ-CORE-040`~`REQ-CORE-041`（v1.13）、界面语言 `REQ-CORE-046`（v1.20）（`REQ-CORE-001`、`REQ-AGENT-001/004/005` 已推迟到 SaaS 阶段）及其全部 Gherkin 场景（每条场景至少一条 TC 可操作化，无场景交由自动化独占覆盖）。
- 不测：

| 不测项 | 归属 |
| --- | --- |
| 单元 / 集成 / 契约自动化（lint 规则、状态机守卫穷举、权限矩阵、openapi↔MCP schema） | 代码仓测试套件（策略见设计文档 §19） |
| 延迟 P95、并发 20 作业、队列等待等容量指标 | 专项压测（指标见设计文档 §15）；本文档仅含 100 屏画布帧率一条功能性检查 |
| 安全渗透（CSP 绕过的系统性搜索；SaaS 阶段的鉴权攻击面） | 上线前专项审计；本地版两条已知攻击路径——网页借浏览器打本机 API、屏里的脚本写主站——由 `TC-CORE-060` / `061` 回归（v0.75） |
| 生成内容的美学质量（超出「对标 Stitch」人工门之外） | 无归属——由 §3 指标持续观察 |
| 部署管线、灰度、回滚演练 | deploy-pipeline（设计文档 §23） |

## 3. 环境与前置

**跑 e2e 必须对测试库**（v0.53 起有机械闸，不再只靠这段话）：`tests/e2e/lib.ts` 的 `assertTestApi()` 挂在 `launch()` / `apiJson()` / `connectMcp()` 三个入口，动手前问 `GET /v1/health` 的 `database` 字段，库名不含 `_test` 就当场抛错并给出另起一套 API 的命令；连不上也抛（失败即关）。
`pnpm mcp:call` 是手工开发脚本，显式 `ALLOW_E2E_DEV=1` 放行。
3100 被开发实例占着时另起一套：`DATABASE_URL=…/quilt_test API_PORT=3200 PREVIEW_PORT=3201 pnpm --filter @quilt/api dev`，跑用例时 `QUILT_E2E_API=http://localhost:3200`。
起因：2026-09-21 并行会话把 e2e 打到 3100 的开发实例上，浏览器与 MCP 的逐屏写删绕过了下面这道 seed 守卫，开发库里四个项目的屏被清空。
`pnpm seed` 是按 owner 全量重置（项目、通道、用量全删），而各套件在模块顶层就调它——import 一下就清库。
因此 e2e 一律 `DATABASE_URL=postgres://quilt:quilt@127.0.0.1:5439/quilt_test`（API 进程与 runner 都要设）；`tests/e2e/lib.ts` 的 `seed()` 会在 DATABASE_URL 不指向测试库时直接抛错，确实要重置开发库时显式给 `ALLOW_SEED_DEV=1`。

**隔离测试栈与全量轮**（v1.06，脚本进仓库）：`scripts/e2e-stack.sh <lane> start|stop|restart|status|env`。
`lane=main` 用测试库 `quilt_test`、API / 预览域端口 3410 / 3411；`l1`…`l9` 用 `quilt_l<N>_test`（不存在就建）、端口 3410+10N / 3411+10N，几个会话同时跑时各占一条 lane，互不清数据。
栈以 `LLM_DRIVER=stub` 起，托管 `apps/web/dist`（先 `pnpm --filter @quilt/web build`）；假会话与假 Codex 的目录、API 日志都在 `<仓库>/.e2e/<lane>/`（已 gitignore）。
`QUILT_RATE_LIMIT_PER_MIN` 缺省 1000：只在 stub 驱动时认，把每分钟 10 个作业的限流放宽，用例之间不必等窗口；验真实上限的 `TC-AGENT-018` 按 10 重启。
`eval "$(scripts/e2e-stack.sh main env)"` 导出跑套件要的环境变量（`QUILT_E2E_API` / `QUILT_E2E_WEB`、`LIVE_LLM=0`、`GEMINI_API_KEY=` 置空、`QUILT_CLAUDE_SESSIONS_DIR`、`QUILT_CODEX_HOME`、`QUILT_E2E_RESTART`）。
要在隔离库上边改前端边看（不重新构建 `apps/web/dist`，别的栈可能正托管着它）时另起一对 API 与 Vite：API 以 `WEB_ORIGIN=http://localhost:<Vite 端口>` 启动（来源校验只认它），Vite 用 `QUILT_API_PROXY=http://localhost:<API 端口> npx vite --port <Vite 端口>` 把 `/v1` 代理过去；不设 `QUILT_API_PROXY` 时代理到开发实例 3100，不能用来跑会写库的操作。
全量轮 `RUN=<轮次> scripts/e2e-all.sh [lane]`：重启栈 → `core` `load` `canvas` `proto` `edit` `components` `agent` `mcp` `chat` `sketch` `i18n` `settings` `record` 依次跑 → 停栈 → `install`（它自己起打包形态），屏幕上只留结果行与汇总，完整日志写 `.e2e/<lane>/run-<轮次>.log`。

**e2e 脚手架**（v1.06，`tests/e2e/harness.ts`）：结果五种——通过、失败、跳过（缺前提：`LIVE_LLM=0`、没有可用的云端通道、没设某个环境变量）、待人工（`TC-AGENT-010`）、预期失败（§7 登记过、还没修好的用例，列在 `EXPECTED_FAIL`，失败时单独计数并带遗留项；它通过了照记通过、提示可以撤标）。
单步时限 10 分钟：页面或无头浏览器卡死时到点记失败、换一个新页面，后面的用例照常跑。
套件结尾按结果计数并列出最慢的 10 条。
`tests/e2e/lib.ts` 的 `localFetch` 把 `*.localhost` 直连 127.0.0.1、保留 Host 头——本机代理的 fake-ip DNS 会把 `preview.localhost` 解析到别处。
`pnpm --filter @quilt/tests typecheck` 对 `tests/` 做类型检查（§5 单测轮的一部分）。

> 状态：v0.32 本地单用户版（2026-09-18）。没有账号、登录、邮件与派活队列；MCP 免鉴权；数据层可用内置 PGlite 或外部 Postgres。

- 两种运行形态，用例针对**仓库内开发形态**执行，`TC-CORE-031` 单独验**打包形态**：
  - 仓库内开发：`docker compose up -d`（Postgres 容器 `quilt-pg`，端口 5439）→ `pnpm install && pnpm db:migrate && pnpm dev`（API `:3100` + 预览域 `:3101` + Worker + agentRunner 同一进程，Web `:6688` 经 Vite 代理 `/v1`）。**跑用例前把 API 与种子脚本都指到测试库**：`DATABASE_URL=postgres://quilt:quilt@127.0.0.1:5439/quilt_test`（先 `docker exec quilt-pg psql -U quilt -d postgres -c "create database quilt_test"` 与 `DATABASE_URL=… pnpm db:migrate`），因为 `pnpm seed` 会清掉默认用户名下**全部**项目——本地版只有这一个用户，开发库里的真实项目不能拿来跑测试。
  - 打包形态：`npx quilt-canvas`（包 `apps/cli`，bin `quilt`）——`$QUILT_HOME`（默认 `~/.quilt`）下 PGlite + 对象目录 + `config.env`，API 同端口托管静态前端，预览域 `http://127.0.0.1:3101`。
    测试用 `--home <临时目录> --port 3410 --preview-port 3411 --no-open` 隔离，结束即删。
- 就绪判定：`curl http://127.0.0.1:3100/v1/health` 返回 200 且含 `"status":"ok"`；`curl http://127.0.0.1:3100/v1/config` 返回 `{"previewOrigin":…,"local":true,…}`；`http://localhost:6688/` 返回画布或 PAGE-FIRST（HTTP 200）；`curl --resolve preview.localhost:3101:127.0.0.1 http://preview.localhost:3101/healthz` 返回 200。
  服务只绑 `127.0.0.1`。
  本地 `.env` 由 `.env.example` 复制而来，`SCREENSHOT_BROWSER_CHANNEL=msedge`（截图用本机 Edge）。
  对象存储用本地 fs 驱动：开发实例在 `.data/objects`；隔离测试栈各用 `.e2e/<lane>/data/objects`（v1.24，`QUILT_DATA_DIR`，`scripts/e2e-stack.sh … env` 一并导出，种子脚本因此写进同一处），测试写的对象与使用记录不混进开发实例；用例里说的「对象目录」都指被测栈 `GET /v1/config` 的 `home` 下的 `objects/`。
- 入口：Web `http://localhost:6688`；API `http://127.0.0.1:3100/v1`；MCP `http://127.0.0.1:3100/mcp`（免鉴权）；预览域 `http://preview.localhost:3101`。
- 用户：只有默认用户 `local@quilt.local`（迁移 `0008` 创建，`pnpm seed` 不删它）。所有 curl / 浏览器请求都不带凭据。
- 种子数据与重置：
  - `pnpm seed [--empty]`：重置基线——删掉默认用户名下全部项目（级联屏 / 修订 / 作业 / 台账 / 通道）与对象子目录，再建空项目 `Demo Mobile`（mobile）与 `Demo Desktop`（desktop），设计系统 seedColor `#3B5BDB`；`--empty` 不建示例项目（PAGE-FIRST 用例）。
  - LLM 驱动：`.env` 的 `LLM_DRIVER` 取 `agent-sdk`（本机 Claude 订阅）/ `anthropic` / `gemini`（模型 `QUILT_MODEL` 用 `gemini-3.8-flash`；计费路径二选一：AI Studio 需 `GEMINI_API_KEY`，Vertex AI 需 `GEMINI_VERTEX=1` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION=global` + `GOOGLE_APPLICATION_CREDENTIALS` 指向服务账号 JSON）；`GET /v1/health` 的 `llm` / `model` 字段确认生效。
    真实 LLM 用例（`TC-CORE-005` 等）的耗时与通过率随驱动变化，登记时在明细注明驱动。
    `.env` 里有 `GEMINI_API_KEY` 时 `pnpm seed` 会建一条已验证的 Gemini 通道并成为缺省通道，此后不带 `runner` 的作业（MCP 造屏 / 改屏、REST 建作业）都打到真实模型；`LLM_DRIVER=stub` 的轮次跑套件时在环境里把它置空（`GEMINI_API_KEY=`，dotenv 不覆盖已有的空值），种子就不建这条通道，缺省回落到 stub。
    stub 轮次里要从输入框发一轮、或要量带屏数 / 版数档位的输入框的用例（`TC-CORE-023` / `024` / `025` / `028` / `055`），自己建一条 OpenAI 兼容桩通道（`tests/e2e/openai-stub.ts`，端口 3982～3986）并验证，要用输入框的再在输入框里选中（画布在打开时取通道清单：页面打开后才建的通道要重载页面才出现在下拉里），用例结束时删通道（v0.82）——不依赖种子的 Gemini 通道。
  - `pnpm seed:project --name <名> --device mobile|desktop --screens <N> [--revisions <M>] [--dangling] [--no-shot]`：用内置 fixture HTML 直接落库（不调 LLM），每屏含 `data-qid`、路由 `/s1`…`/sN` 与互链；`--revisions M` 给每屏 M 个修订；`--dangling` 让第一屏多一条 `href=/settings` 断链。
    输出 projectId 与各 screenId。
    fixture 每屏 depth-1 有一个 `<header>`（标题 `Screen N vM`）与一个 `<nav>`（tab 数 = min(N, 4)，指向 `/s1`…，各条链接类名完全相同、无 `aria-current`），它们是共享组件用例（`TC-EDIT-012`）的提取靶子——提取这个 `<nav>` 得到的是非导航型组件（`nav=false`）。
  - `pnpm seed:job --project <id> --screen <id> --status running`：构造进行中作业占用某屏；`--status running --tokens 3000 [--screens 400]`：构造已消耗 3000 token（与 400 屏）的运行中作业，台账预写在 `stub` 驱动名下（供取消记账与用量展示用例）；`--input '<json>'` 覆盖作业输入（在途预估用例：`{"prompt":"x","count":4,"versions":2}`）；`--runner agent` 造一个停在 queued、没投递出去的本机 agent 作业（会话写在 `--input` 的 `runner` 里，`TC-CORE-068`，v0.79）。
  - `pnpm seed:preview-token --screen <id> --expired`：打印一个已过期的预览签名 URL。
  - `pnpm seed:design-system --project <id> --bump`：把设计系统 version 抬升 1（制造版本冲突）。
  - 时间敏感状态（过期签名）一律种子构造，不真等。
- 本机 agent（`REQ-AGENT-003` v0.34，投递到本机 Claude Code 会话）：`TC-AGENT-009` 用**假会话**验整条链——`tests/e2e/agent-stub.ts` 在 `QUILT_CLAUDE_SESSIONS_DIR` 指向的目录里写一份 Claude Code 风格的登记文件（`<pid>.json`，`kind=interactive`、`peerProtocol=1`；v1.06 起字段与 2.1.287 一致、`peerFeatures` 三项，另写一份 0600 的 `<pid>.<hex>.key`，版本可指定）并监听同目录下的 unix socket；API 与测试脚本都要以同一个 `QUILT_CLAUDE_SESSIONS_DIR` 启动 / 运行（测试栈给的是 `.e2e/<lane>/sessions`；未设时该用例登记「跳过」）。
  假会话按投递来的指令里的 `HANG` / `FAIL` / `STALE` 决定行为，其余走真实 MCP 回写并 `quilt.finish_job` 收口。
  `TC-AGENT-010`（真实会话）为人工用例：投递进真实会话要在那个终端里确认接收，AI 不代按。
- 本机 Codex（`REQ-AGENT-003` / `REQ-CORE-013` v0.68，`ADR-020`）：`TC-AGENT-012` 用**假 Codex**验整条链——API 以 `QUILT_CODEX_HOME=/tmp/quilt-e2e-codex`、`QUILT_CODEX_BIN` 与 `QUILT_CODEX_OPENER` 都指向 `tests/e2e/codex-stub.mjs` 启动（另设 `OPENAI_API_KEY=sk-must-not-reach-codex`，验驱动会把它去掉），测试脚本也以同一个 `QUILT_CODEX_HOME` 运行（未设时登记「跳过」）。
  脚本自建假线程库（`state_5.sqlite`）；桩只记下 `queue` / 深链接 / `exec` 调用并回放 `exec` 的 JSONL（验证用的最小请求故意拖 18 s，与真 codex 冷启动相当，超过前端普通请求的 15 s 上限）；「Codex 窗口」一侧由脚本扮演——占住写锁文件表示线程打开着，读桩记下的队列消息、经 MCP 回写并收口。
  作业创建限流 10 次 / 分钟（§15），脚本在 `TC-AGENT-009` 之后先等过限流窗口再跑 012。
  `TC-AGENT-013`（真实 Codex）要本机 `codex` 已用 ChatGPT 登录、开着 Codex 桌面版，并临时把 Codex 的 `quilt` MCP 指到测试 API（`codex mcp add quilt --url http://127.0.0.1:3200/mcp` 加 `default_tools_approval_mode = "approve"`，测完改回 3100）；终端会话在伪终端里起 TUI（脚本替它回答终端能力探测与目录信任确认，只写进该伪终端，不动真实键盘鼠标）。
- 聊天模式（`REQ-CORE-023` v0.45）：`TC-CORE-039` 要本机 `claude` 已登录——脚本经 API 建一条 `agent-sdk` 通道并探测通过后才发真实回合（模型 `CHAT_MODEL`，缺省 `claude-sonnet-5`；一轮 1～5 分钟，按订阅额度计费）；`LIVE_LLM=0` 只跑通道校验与串行守卫。
  SDK 会话文件落在 `~/.claude/projects/` 下按 `$dataDir/chat` 编码的目录，测试库与开发库共用该目录、会话 id 各自记在项目上，互不干扰。
- MCP 与画布同面（`REQ-AGENT-002` v0.51）：`TC-AGENT-011` 由 `pnpm --filter @quilt/tests e2e:mcp` 执行，纯 MCP / REST、不开浏览器，要求 API 以 `LLM_DRIVER=stub` 启动（脚本先查 `/v1/health`，不是 stub 就退出）。
  为了不占用 3100 上的开发实例，可另起一套：`API_PORT=3200 PREVIEW_PORT=3201 API_ORIGIN=http://localhost:3200 PREVIEW_ORIGIN=http://preview.localhost:3201 DATABASE_URL=postgres://quilt:quilt@127.0.0.1:5439/quilt_test LLM_DRIVER=stub LLM_STUB= pnpm --filter @quilt/api dev`，脚本侧 `QUILT_E2E_API=http://localhost:3200 DATABASE_URL=…quilt_test`（种子脚本走同一个 `DATABASE_URL`）。
  `PREVIEW_ORIGIN` 必须一起改：`.env` 里写死的 3101 会让素材 URL 与截图渲染都打到开发实例的预览域。**浏览器用例也能在这套上跑**（v0.60 起）：先 `pnpm --filter @quilt/web build`，起 API 时再加 `WEB_DIST=$PWD/apps/web/dist WEB_ORIGIN=http://localhost:3200`（打包形态：API 同端口托管前端；`WEB_ORIGIN` 不改的话预览域的 `frame-ancestors` 还写着 6688，聚焦的 iframe 会整张拒载），脚本侧再加 `QUILT_E2E_WEB=http://localhost:3200`。
- 单测（v0.60）：`pnpm test` 在 `tests/unit` 用 `node:test` 跑 `packages/core` 与前端纯函数的单测（不起库、不起浏览器，约 0.5 s）。
  TEST.md 不为单测逐条建 TC——测试文件名即覆盖范围（`core/inject`、`core/components`、`core/outline`、`core/lint`、`core/tokens`、`core/contract`、`core/failure`、`core/history`、`core/edits`、`core/vendor`、`core/runtime`、`core/sketch`、`web/arrange`、`web/jobs`、`web/jobTracker`、`web/geometry`、`web/frameMessages`、`web/brand`、`web/messages`、`web/designDraft`、`web/twClass`、`web/assetTone`、`web/edges`、`api/codex`、`api/agentSdk`、`api/origin`、`api/llm`、`api/bundle`），失败按「单测轮」登记。
  `core/runtime`（v1.06）在 happy-dom 里执行预览运行时，断言它发给父页的每条消息都过 `previewMessageSchema`、`runtime.ts` 与 `preview-runtime.js` 一致，v1.08 起另断言屏内的选中框、标签、修改标记用 `quilt:mode` 带来的颜色、换一套当场换色，源码里除叠层遮罩外没有写死的颜色；`web/brand`（v1.08）断言外壳样式只经 `brand/` 的三份文件（`apps/web/src/brand/` 的副本，v1.09）进来、没有自写映射，副本与本机 `brand/` 一致（`scripts/sync-brand.mjs --check`，本机没有 `brand/` 时跳过），组件里没有 hover 色、ring 焦点环、禁用透明度、背景模糊类与 hex，样式表不用渐变、背景模糊、文字阴影，首帧脚本与 `lib/theme.ts` 用同一个存储键；`api/bundle` 另断言前端只从 `@quilt/core/browser` 引、这个出口的 import 图里没有 linkedom 与 prelude（v1.06）。
  `api/bundle` 按 `apps/cli/build.mjs` 同样的参数打一遍打包入口，断言静态 import 图无环（v0.82：环会让打包形态冷启动时顶层 await 永不落定、退出码 13）。
  `core/sketch`（v1.13）断言草稿名的截取、根元素画框的解析、草稿与普通屏的截图尺寸、造 / 改屏 / 放进项目三处请求里的画框与 `restyle`、`quilt:draft-size` 消息，以及草稿系统提示词（以生成器标记开头、`auto` 时要模型声明画框、不带设计系统与 token 类）。
- LLM 故障注入：`LLM_STUB=503 pnpm dev` 让所有调用返回 503；`LLM_STUB=fixture` 回放固定 HTML（需要确定性时使用，用例中显式注明）。
  stub 驱动认指令里的 `[stub-hold:<毫秒>]`（写进系统提示或用户提示都算）：这次调用先拖这么久再回，且不理会中止信号——用来造「作业在跑的那一阵」与「模型已经在回来的路上时被取消」（`TC-EDIT-019`、`TC-CORE-065`，v0.79）。
  作业指令里的 `[stub-finalize-hold:<毫秒>]`（v1.03，只在 stub 驱动时认）让 worker 复核取消之后、落库之前停这么久，造「取消与落库同时到达」（`TC-CORE-088`）。
  草稿本（v1.13）：stub 驱动出草稿时另认 `[stub-frame:<component、mobile 或 desktop>]`（写进根元素的 `data-frame`）与 `[stub-script]`（草稿带 `<script>` 与 `<style>`），`[stub-hold]`、`[stub-patch-miss]` 照旧；标记写在这句话的第二行，草稿名只取第一行。
  草稿本的浏览器用例从输入框发，用 `tests/e2e/sketch.ts` 自起的 OpenAI 兼容桩通道「草稿桩」（3961）：含「迷你控制条」「圆形」「记账」「官网」的一句分别回播放器控制条（组件，根宽 360 px）、它的第二版、记账首页（手机页）、官网首页（桌面页），带 `[size:<宽>x<高>]` 回一个根上没写 `data-frame` 的色块，改稿的其余指令在原稿末尾加一行；句中带「慢」拖 6 s，带 `[fail]` 回 400。种子会删通道，脚本开跑与走查复位后各建一次。
  `QUILT_JOB_TIMEOUT_TOTAL_MS`（v1.03，同样只在 stub 驱动时认，要重启 API）把作业时限定死，造「修订已落库、截图还没拍完时到点」（`TC-EDIT-033`）。
- 作业与 worker 健壮性（v0.79）：`TC-CORE-065` 要本机 docker 里的 `quilt-pg`，脚本用 `docker exec quilt-pg psql` 对被测库执行 `pg_terminate_backend`、只掐 `query ilike 'listen %'` 的连接（按 `current_database()` 过滤，别的库不受影响）。
  `TC-CORE-066` / `068` 在本机起**探针图**服务（3989 / 3988）：屏里一张指向它的图，探针回 404 时 `onerror` 挂一个不停清空 Tailwind 样式的定时器，截图的就绪判定等不到样式、这次拍摄失败；回 PNG 就一切正常——用它确定性地造「第一次拍摄失败」。
  `TC-CORE-068` 要重启被测 API：`QUILT_E2E_RESTART` 给一条命令，须以 SIGKILL 结束旧进程（模拟崩溃，`finally` 不执行）、再按本节的命令起新进程并轮询 `/v1/health` 到就绪（例如 `kill -9` 监听 API 端口的进程及其 `pnpm` / `tsx` 父进程后重起），未设时该用例失败并注明环境。
  `tests/e2e/openai-stub.ts` 的 `holdMs` 可以按请求给、`fail` 按请求回错误状态码；`codex-stub.mjs` 对 id 以 `eeee` 结尾的线程打开深链接失败（记 `open-failed`，模拟本机没装 Codex 桌面版）。
  真实调用会消耗额度，每条用例后置不做特殊清理。
- 截图链与上传位（v0.82）：`TC-CORE-071` 要 `QUILT_E2E_RESTART` 与本机的 `ps` / `lsof`（按 `ppid` 与命令行里的 `--user-data-dir` 认截图浏览器）。
  `TC-EDIT-022` 的两张卡住的屏由屏自己的脚本造（把 `document.fonts.ready` 换成永不落定的 promise；页面加载完之后再调 `lucide.createIcons` 就死循环）。
  `TC-EDIT-023` 以 `QUILT_JOB_TIMEOUT_BASE_MS=1000 SCREEN_CONCURRENCY=1` 执行 `QUILT_E2E_RESTART`，要求重启命令把调用方的环境变量传给新进程（`scripts/e2e-stack.sh` 的 `env … pnpm` 即如此）；`QUILT_JOB_TIMEOUT_BASE_MS` 只在 `LLM_DRIVER=stub` 时生效，跑完不带它再重启一次；3987 端口起一个只收不回的服务当慢图。
  `TC-EDIT-028`（v0.93）在 3988 端口起同样的服务；它的第 1 步要截图浏览器能访问外网 CDN，第 2 步的 3 s 门槛靠同一进程里的外网缓存，API 重启后第一张照常走网络。
  `TC-AGENT-022` 要被测 API 用 fs 存储、数据目录在本机（`/v1/config` 的 `home`），脚本直接拨上传位文件的修改时间。
- 工具：浏览器（自动化遵循运行环境既有约定：Playwright 驱动本机 Edge；帧率用页面内 rAF 计数 + `longtask` PerformanceObserver 采样；**在预览 iframe（跨域）内点击元素前必须先让画布处于该屏 1:1 聚焦态**——Playwright 不感知外层 CSS transform 缩放，非 1:1 下点击坐标会偏；键盘快捷键在焦点位于 iframe 内时由预览运行时转发，测试可直接对页面按键）；curl（不带凭据）；`pnpm mcp:call <tool> '<json>'` / `--resource <uri>` / `--list`（MCP 调用脚本，打印工具返回）。
- 执行脚本：`tests/e2e/core.ts`（CORE；v1.06 起只是入口，用例按组在 `core/generate.ts`、`focus.ts`、`rounds.ts`、`overlays.ts`、`screenshots.ts`、`backend.ts`，公用的浏览器与工具在 `core/shared.ts`）、`load.ts`（v0.76 画布加载与数据新鲜度 `TC-CORE-050`~`056`，v0.83 加 `075`~`078`，v0.94 加 `085`）、`canvas.ts`（v0.80 画布交互与键盘 `TC-CORE-057`~`059`，v0.83 加 `079`，v1.08 加外观 `097`）、`proto.ts`、`edit.ts`、`components.ts`、`agent.ts`、`mcp.ts`、`chat.ts`、`sketch.ts`（v1.13 草稿本 `TC-CORE-098`~`111`）、`i18n.ts`（v1.20 界面语言 `TC-CORE-130`~`136`，浏览器上下文按用例给 `locale`）、`settings.ts`（v1.24 设置三节与用量看板 `TC-CORE-140`~`143`）、`record.ts`（v1.22 本机使用记录 `TC-CORE-144`~`149`，`records/` 按被测栈的对象目录、API 日志按 `.e2e/<lane>/api.log`）、`collab.ts`（v1.32 协作显示 `TC-CORE-153`~`156`、`159`，v1.33 作业完成 chip `157`）、`install.ts`（`TC-CORE-031`）、`smoke.ts`（开发冒烟）；环境变量 `RUN=轮次`、`ONLY=用例子集`、`LIVE_LLM=0` 跳过真实生成。
  各套件串行执行，不并行——每套开头的 `pnpm seed` 会清掉另一套正在用的数据。
  浏览器上下文由 `lib.ts` 的 `zhCN` 统一预置协作者身份（v1.32，`quilt:me` 记「测试」）：没有名字时画布与草稿本先弹填名字的对话框、挡住其余操作；所有上下文是同一个人，并开的页面不会互相出现光标与头像。只有 `collab.ts` 用 `bareContext` 开不带身份的上下文。
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
| 3 | 确认弹窗（`role=alertdialog`）写明「删除「DelB」？」与级联范围，点「删除」 | toast「已删除「DelB」」；`GET /v1/projects/<DelB>` 404；对象目录（§3）下的 `projects/<DelB>` 已清 |
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
| 8a | `generate_screens variantOf=s1 variantName=空态` → `link_screens` 变体 → `link_screens s1 /s1-moved` → 查变体路由 → 改回 → `seed:job --screen <变体> running` → `delete_screen s1` → 取消该作业、删变体 | 作业 succeeded、出现 `variantOf=s1` 的屏；`422 /errors/validation`；变体路由也变成 `/s1-moved`；`409 /errors/screen-busy` |
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
| 6 | 看画布左上的风格指南卡片 | 底部有品牌素材行（`guide-assets`），瓦片按素材亮度选底（`asset-on-light` / `asset-on-dark` / `asset-thumb`），图能加载；判出深色标志（`asset-on-light`）时瓦片的计算底色等于项目 `designSystem.tokens.colors.background`（v0.98：底色取项目色板，新建项目的中性色板 background 亮度 ≥ 0.85） |
| 7 | 打开设计系统面板的素材区（`assets-panel`） | 列出 1 项（`asset-item`），缩略图 `naturalWidth > 0`（展示用 `<img>` 不带 `crossOrigin`：`/a/` 的 ACAO 是常量 `webOrigin`，加了就在别的 origin 下整张图不显示） |
| 7b | 往 `assets-panel` 上拖一个 PNG（dragover → drop）；再拖一个 `text/plain` 文件（v0.38） | 拖入态：`assets-panel[data-dropping]`、虚线外框、标题槽位就地换成「松手上传到这个项目」；放下后列表多出该文件、toast「已上传「…」」、拖入态复位；非图片被就地挡住并说明「有 1 个文件不是 SVG / PNG / JPEG / WebP，已跳过」；「上传」按钮始终可用（键盘等价入口没被拖拽取代） |
| 7c | 读 `/agent` 记下最大 qid 那个元素的起始标签 → `patch_screen` 在文案后插一个 `<span>` → 用刚才记下的起始标签作 `find` 再 `patch_screen`；新上传位 `append_upload offset=0` 两次（同一段）→ 按回来的 `chars` 续写 → `create_screen uploadId` → 再用同一 `uploadId` 建屏；`create_screen` 300 KB html；`create_screen` 里放一个改了内容的 `<footer data-component="Footer">`；`get_project` | 插入后旧起始标签原样还在、新 span 是最大号 +1，第二次 patch 成功；第二次 append `409 /errors/upload-offset` 且 `chars` 等于第一次返回值；建屏成功、再用 `400 /errors/validation`（上传位已清）；`422 /errors/validation`；返回 `componentsOverwritten` 含 `Footer`；返回文本不含 `previewUrl` / `screenshotUrl` / `"links"`、没有换行 |
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

#### `TC-CORE-091` 项目切换器里按 F2 改名 — 对应 `REQ-CORE-002`（v1.04）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name F2Rename --device mobile --screens 1 --no-shot`；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点项目切换器 | 当前项目那一行高亮；列表顶部写「F2 改名 · Delete 删除」 |
| 2 | 按 `F2`，把名字改成「键盘改的名」按 `Enter` | 那一行变成改名框、带原名且拿到焦点；回车后库里项目名是「键盘改的名」 |

后置：删项目。

### CORE · 生成与画布

#### `TC-CORE-005` 一句话生成初始多屏并落到画布 — 对应 `REQ-CORE-003` · 级别: 冒烟 · 执行者: 皆可

前置：打开空项目 `Demo Mobile`（真实 LLM）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 底部输入框输入「做一个宠物社交 APP」，发送 | 输入框上方出现这个作业的 chip（`job-chip`）；画布出现 ≥ 3 张占位卡片并带进度指示；API `POST /v1/projects/<id>/messages` 返回 202 含 `job.status=queued` |
| 2 | 等待至多 90 s | 画布出现 ≥ 5 张截图卡片（手机比例 390×844），作业 chip 转成「任务完成 · 造 …」（`data-state=succeeded`）；助手消息（`GET …/messages`）回填文本并列出受影响屏；作业事件流收到 `succeeded` |
| 3 | curl 依次 `GET /v1/screens/<每屏>/revisions/<current>` 并下载 HTML | 每屏 HTML 含 `data-qid` 属性；无匹配 `#[0-9a-fA-F]{6}` 的裸色值出现在 `<body>` 内；`lintReport.passed` 为 true |
| 4 | curl `GET /v1/me/usage` | `screens` 增加了本次屏数，`tokensIn`、`tokensOut` 均大于 0 |

后置：无。

#### `TC-CORE-006` 供应商持续故障导致作业失败且已产出屏保留 — 对应 `REQ-CORE-003` · 级别: 回归 · 执行者: 皆可

前置：以 `LLM_STUB=503 pnpm dev:worker` 重启 worker；打开空项目 `Demo Desktop`。
脚本 `tests/e2e/core-stub.ts` 把这一轮的 `runner` 改成 stub 再发（种子按 `.env` 建的 Gemini 通道是缺省，不改就打到真实模型、碰不到 503 桩）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 发送「做一个记账网站」 | 作业创建成功（202） |
| 2 | 等待至多 60 s | 助手消息显示失败原因并提供「重试」按钮——正文以「造屏失败：模型服务暂时不可用（HTTP 503）」开头、给出下一步（「重试」或换通道）、不含原始报文 `stub 503`（v0.74 §14）；作业事件流收到 `failed`；curl `GET /v1/jobs/<id>` 返回 `status=failed`、`output.errorClass=provider` |
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

前置：`pnpm seed:project --name Big --device mobile --screens 100 --no-shot`（100 张骨架卡带循环动画，也是生成中的大项目的样子）；单开一个 1440×900、**设备像素比 2** 的浏览器上下文（Mac 的像素比；1 倍屏的光栅量只有四分之一，量不出真机的 GPU 压力）打开该项目，点「适配视图」；CDP 开性能追踪（含 `toplevel,cc,gpu` 类别）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 滚轮平移 60 次、`Ctrl`+滚轮缩放 60 次，每次间隔 16 ms | rAF 帧率 ≥ 55 fps；无超过 100 ms 的长任务 |
| 2 | 汇总追踪：`CrGpuMain` 线程 `RunTask` 总时长、`Layout` 总时长，各除以帧数 | GPU 主线程每帧 ≤ 4 ms、布局每帧 ≤ 0.5 ms（无头下 rAF 恒为 58～60，帧率看不出 GPU 超预算，靠这两条拦） |
| 3 | 停下 400 ms 后查 DOM | 世界层里没有 SVG `<text>`；小地图是 `<canvas>`；世界层不带 `moving` 类（`will-change` 已摘） |

后置：无。

#### `TC-CORE-083` 屏里的 `dark:` 变体按屏自己的配色判 — 对应 `REQ-EDIT-005`（`ADR-005` v0.89 修订）· 级别: 边缘 · 执行者: AI

前置：`pnpm seed:project --name DarkVariant --device mobile --screens 0 --no-shot`；MCP `quilt.create_screen` 推一屏，body 里两个 96×96 方块：`data-v=light`（`bg-primary dark:hidden`）与 `data-v=dark`（`hidden bg-error dark:block`）。
「显示哪版」= 用屏的预览地址在指定系统偏好（`colorScheme`）的浏览器上下文里打开、等 Tailwind 生效后哪个方块 `display` 不是 `none`；「截图是哪版」= 截图里方块中心的颜色更接近 `primary` 还是 `error`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 亮色配色（种子派生），等截图就绪；分别在暗色、亮色系统偏好下打开预览 | 两种偏好下都只显示 `light`；截图也是 `light`（修复前暗色偏好下显示的是 `dark`——用户看到的「交互态 logo 变白」） |
| 2 | `PUT design-system` 挂暗色色板（`background #111820`、`onBackground #E1E2E8`）并切 `colorMode=dark`，回刷全部屏，等新修订的截图就绪；两种偏好下再打开 | 两种偏好下都只显示 `dark`；截图也是 `dark`（修复前亮色偏好下显示 `light`、截图也是 `light`） |

后置：无。

#### `TC-CORE-084` 出屏提示词与新建项目设计系统改动的真实模型 A/B 盲评 — 对应 `REQ-CORE-002`、`REQ-CORE-003`、`REQ-CORE-006`（`ADR-027`、`ADR-028`）· 级别: 回归 · 执行者: AI（真实模型）

前置：只在改动出屏系统提示词的文字或新建项目的设计系统（`newProjectDesign`：色板、圆角档、配方、默认 DESIGN.md）时跑（§5「提示词轮」）。
`.env` 有可用的 Gemini 凭据（AI Studio Key 或 Vertex），本机 Claude 订阅已登录；不起 API、不写任何库。
脚本在 `tests/bench/craft/`：`briefs.json`（6 条需求：`TC-CORE-020` 的 5 条加一个企业 AI 网关后台，3 条手机、3 条桌面）与 `plans.json`（冻结的规划，每条需求取前 3 屏）入库，产物在 `docs/test-runs/craft-bench/`（已 gitignore）。
「基线」= 当前代码（`gen base`）或已有的带标签产物（如上一轮的候选，产物目录名作变体名）；「候选」写成 JSON（格式见 `harness.mts` 头注释，候选块插在 DESIGN SYSTEM 一节之前），或是另一个 worktree 里的代码——在那边 `AES_LABEL=<标签> … gen base`，两边 `CRAFT_BENCH_OUT` 指同一目录。
两个通道：Gemini 3.7 Flash 与本机订阅的 Sonnet 5.5。
下文命令都在 `tests/` 下执行。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 两个变体 × 两个通道出屏：`npx tsx bench/craft/harness.mts gen base gemini`（`AES_CONC=2`，Vertex 下 4 并发会撞 120 s 请求超时）、`… gen base sonnet`，候选同样各跑一遍；首次失败的再跑一次（命令会跳过已成功的屏） | 4 组各 18 屏全部成功；各组 `manifest.json` 没有 `not styled` / `tailwind is not defined`（有则 `reshoot` 从存下的 HTML 重拍，仍有则该对不进评审并在明细写明） |
| 2 | 两个变体各 `npx tsx bench/craft/harness.mts audit <变体> <通道>`，再 `node bench/craft/metrics.cjs <基线名> <候选名>` | 机械指标逐屏记进 `manifest.json`（粗线 = 对背后底色 ≥ 1.5:1 的边框线段，输入控件除外；胶囊；≥ 12px 圆角；阴影；渐变；折行短文本 = 不超过 24 字却折成多行的文字，表格竖排、元信息碎行在这里显形）。改动以「去 AI 味」为目标时事先登记门槛（v0.92：粗线 −50%、胶囊 −70%、≥ 12px 圆角 −70%，两通道每屏均值）；平均输出长度与输出 token 不比基线多 20% 以上（耗时只记录：本机订阅与 Vertex 的排队随时段变，不同时段测的两轮不可比）；两个变体每通道的界面语言分布相差 ≤ 2 屏（按正文中英字符多少判，脚本去掉 `<script>` / `<style>`；语言一变，盲评比的就不只是设计）；lint 偏离的变化写进明细 |
| 3 | 两个通道各 `npx tsx bench/craft/harness.mts pairs base <候选.json> <通道> <标签>`，再 `node bench/craft/judge-args.cjs base <候选名> <候选.json>` 生成 args，用 Claude Code 的 Workflow 运行 `bench/craft/judge.workflow.js` | 36 对、每对 3 票（结构 / 视觉 / 整体三个视角，左右顺序轮换，评审只读得到该对的 4 张图；每票给 9 个维度打分，含「AI 味」`aiLook`）；通过标准事先登记、不看结果后改：总胜率（去掉平局）≥ 70%，每个通道 ≥ 60% 且 overall 均差 > 0。两版候选直接对比（修订稿对上一稿，基线是上一稿的产物）时另行事先登记，v0.92 用的是：总胜率 ≥ 60%、每通道 ≥ 50% 且 overall 均差 > 0，机械指标对原基线仍过第 2 步的门槛，不满足就上线上一稿。这类门槛经 args 的 `minWin` / `minChannelWin` 传给 `judge.workflow.js`，`context` 写明两版各是什么、提示词在哪（给分析代理读） |

后置：删掉 `~/.claude/projects/` 下以 `tests` 目录命名的会话记录（本机订阅每次调用留一份）；`docs/test-runs/craft-bench/` 作证据留在本机，下一轮前清空。

#### `TC-CORE-080` 缩放不建拆合成层、内容不拆碎、视口外骨架不占层 — 对应 `REQ-CORE-004` · 级别: 边缘 · 执行者: AI

前置：`pnpm seed:project --name Layers --device desktop --screens 25`（带截图），经 API 把 25 屏摊成 5×5、行列间隔 2800（Omnivia 那种分组摆法：内容越分散，独立合成的世界层越容易被拆碎）；单开一个 1440×900、设备像素比 2 的浏览器上下文打开该项目，等任一卡片的截图解码完成；CDP `LayerTree` 读合成层数。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 镜头记成 100% 缩放、只看得见一两张卡，刷新 | 合成层 ≤ 40（视口外懒加载没取的卡显示骨架，骨架不各占合成层） |
| 2 | 按 `F` 适配视图，静止时读一次；给世界层挂上 `moving` 类（平移缩放进行中的状态）再读一次 | 两次相差 ≤ 2：世界层是常驻的一层，手势开始不新建、内容不拆碎（新建的那一帧图块未栅格化，整块画布闪白） |

后置：无。

#### `TC-CORE-081` 高速缩小不缺图块 — 对应 `REQ-CORE-004` · 级别: 边缘 · 执行者: AI

前置：`pnpm seed:project --name FastZoom --device desktop --screens 25`（带截图），经 API 把 25 屏摆成 5×5、列距 1700、行距 1400；单开一个 1440×900、设备像素比 2 的浏览器上下文打开该项目，按 `F` 适配视图，等 25 张截图都解码完成。
缩放用 CDP `Input.dispatchMouseEvent` 发带 Ctrl 的滚轮（触控板捏合的形态），每 8 ms 一个、`deltaY` ±12；性能追踪只开 `benchmark` 类别，数 `LayerTreeHostImpl::CalculateRenderPasses` 的 `missing tiles`（这一帧该画却没栅格化出来的图块数）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 开追踪；三轮：围绕视口里不同的点快速放大 30 下、停 400 ms、快速缩小 30 下、停 400 ms；关追踪 | 缺图块的帧 ≤ 2 且单帧缺块 ≤ 16（修复前每轮缩小 3～4 帧缺块、单帧最多 408 块，有整帧所有卡片都没画出来；放大方向本来就不缺） |

后置：无。

#### `TC-CORE-086` 大项目缩放与拖卡不掉帧 — 对应 `REQ-CORE-004`、`REQ-PROTO-002`（`ADR-029`）· 级别: 边缘 · 执行者: AI

前置：`pnpm seed:project --name Dense --device desktop --screens 68 --grid 9 --nav 10`（带截图：每屏一张 2 倍屏原图 2560×1600 与一张 640×400 缩略图；9 列排开；每屏侧栏链到其后 10 屏，连同种子的底栏 4 个入口与「下一屏」，合并后约 900 条连线；期望值由脚本按项目的连线算）；单开一个 1440×900、设备像素比 2 的浏览器上下文打开该项目（首次打开即适配视图）。
缩放用 `Ctrl`+滚轮（触控板捏合在浏览器里就是它），每步间隔 8 ms。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 等有截图的卡都显示（冷启动时截图浏览器取 Tailwind CDN 慢，种子偶尔丢头一两张截图，至少 60 张才算前置成立） | 全部是缩略图（`.thumb.webp`）；没有连线 canvas（v1.29 起平时不画连线） |
| 2 | 开追踪，在视口中央 `Ctrl`+滚轮放大 40 步再缩小 40 步，停 1.5 s 后关追踪 | 追踪里图片解码（`ImageDecodeTask` / `Decode Image`）合计 ≤ 500 ms；`longtask` 观察器没有超过 100 ms 的长任务（改前同类项目 3.3 s，超过 50 ms 的长任务 7 次、最长 209 ms） |
| 3 | 拖住视口中央那张卡移动 60 步再松手，期间记 rAF 帧间隔 | 超过 33 ms 的帧 ≤ 5（改前 48 / 82） |
| 4 | 依次单击视口里的 12 张卡（间隔 120 ms），期间记 rAF 帧间隔 | 超过 33 ms 的帧 ≤ 3（改前 21 / 63）；选中屏也不画连线 |
| 5 | `Esc` 清掉选中，在视口中央按 `Ctrl`+滚轮放大，缩放到 0.9 以上停住（约 100%，记下步数），等到原图解码 | 视口里的卡都换成原图、视口外的仍是缩略图 |
| 6 | 按同样的步数缩小回到全景 | 5 s 内全部卡片回到缩略图 |
| 7 | 双击视口中央那张卡进入交互，等连线长完；再按 `Esc` | 连线 canvas 出现，`data-total` 等于项目连线合并后的条数、`data-drawn` 等于这一屏进出的屏对数、`data-state=done`；`Esc` 后 canvas 撤掉 |

后置：无。改前数字来自 RUN-243：Shopilot（68 屏、706 条连线）拷进测试库后用同一套场景量的。

#### `TC-CORE-087` 修订面板与候选格用缩略图；面板取数失败就地重试 — 对应 `REQ-CORE-007`、`REQ-CORE-015`（`API-CORE-013` / `API-CORE-026`、`PAGE-CANVAS`「面板取数失败」，v1.03）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name PanelThumbs --device mobile --screens 1`（带截图与缩略图）；视口 1440×1000。取数失败用 Playwright 拦下请求造（`route.abort`），重试前放行。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `GET /v1/screens/<id>/revisions` | 最新一条带 `thumbUrl`（`.thumb.webp`） |
| 2 | 拦下修订列表请求，选中 `/s1` 按 `⌥R`；放行后点「重试」 | 面板里就地写「修订列表没取到」与「重试」，不停在加载中；重试后列出修订，行内缩略图取的是 `.thumb.webp` |
| 3 | 拦下 `GET /v1/design-presets`，打开设计系统面板（`?panel=design`）；放行后点「重试」 | 预设一节就地写「预设列表没取到」与「重试」，不写「还没有预设」；重试后列出预设或空态 |
| 4 | `POST …/jobs` 钉死路由 `/settings` 造 1 屏 × 2 版（显式带桩通道，不走规划）；拦下候选请求，点卡片角标展开；放行后点格子上的重试（`candidate-retry`） | 格子标签写「候选没取到」并给重试；重试后两格，垫底图取的是缩略图 |

后置：删项目。

#### `TC-CORE-088` 取消与落库同时到达，事件流只有一个终态 — 对应 `REQ-CORE-005`（设计文档 §16 竞态表，v1.03）· 级别: 边缘 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name CancelRace --device mobile --screens 1 --no-shot`；作业事件经 MCP `quilt.get_job_events` 读。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST …/jobs` 建 `edit_screens`（显式带桩通道），指令带 `[stub-finalize-hold:30000]`；等到 `screen_screenshot_ready`（截图拍失败时等到修订落库后 25 s），再等 1 s 后 `POST /v1/jobs/<id>/cancel` | 取消 `200`（落在 worker 复核取消之后、落库之前的停顿里） |
| 2 | 再等 32 s（停顿结束），读作业事件、作业与助手消息 | 终态事件只有一个 `cancelled`（没有 `succeeded`）；作业 `cancelled`；回执「已取消」 |

后置：删项目。

#### `TC-CORE-089` 排队卡住的作业被重新入队；输入不合法的领取时失败 — 对应 `REQ-CORE-005`（设计文档 §17 `job.timeout`，v1.03；`API-CORE-006` 入口校验，v1.06）· 级别: 边缘 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Requeue --device mobile --screens 2 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `pnpm seed:job --project <id> --screen <s1> --status queued --kind edit_screens`（只落库、不进进程内队列，等价于建作业后入队那一步之前出过错），等它 | 约 2 分钟内被 `job.timeout` 重新入队、领取并 `succeeded` |
| 2 | 同时 `pnpm seed:job --project <id> --screen <s2> --status queued --kind edit_screens --input '{"screenIds":["<s2>"],"versions":1}'`（缺 `prompt`；种子直接落库，绕过建作业时的校验），等它 | 领取时按种类校验：`failed`、`errorClass=validation`、`message` 以「作业输入不合法：prompt」开头，不进流水线 |

后置：删项目。

#### `TC-CORE-090` `storage.gc` 清过期导出与孤儿附件 — 对应 `REQ-PROTO-004`、`REQ-CORE-012`（`API-PROTO-002`、设计文档 §17 `storage.gc`，v1.03）· 级别: 边缘 · 执行者: AI（`LLM_DRIVER=stub`，要 `QUILT_E2E_RESTART`）

前置：`pnpm seed:project --name StorageGc --device mobile --screens 1 --no-shot`；fs 存储（对象目录，§3）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 导出一次；传两张参考图，其中一张随一条消息发出（被引用），另一张不用；把导出文件与两张附件的修改时间拨回 25 小时前，重启 API | 就绪 |
| 2 | 等至多 2 分钟（启动 1 分钟后先扫一轮） | 导出文件被删；`GET /v1/jobs/<id>/export` `404`，`detail` 写「导出文件已清理（超过 24 小时），重新导出一次」；没被引用的附件被删，被消息引用的那张还在 |

后置：删项目。

#### `TC-CORE-095` 屏文档的外网脚本用仓库副本 — 对应 `REQ-CORE-005`（`API-CORE-016`、设计文档 §17 Tailwind / lucide 一行，v1.06）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Vendor --device mobile --screens 1 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 取 s1 的 `previewUrl` 文档 | 只有两个 `<script src="/vendor/…">`，不含 `cdn.tailwindcss.com` 与 `unpkg.com/lucide` |
| 2 | 逐个取这两个 `/vendor/…`；再取 `/vendor/evil.js` | 前两个 200、`content-type` 是 JavaScript、`cache-control` 含 `immutable`、体积 > 100 KB；不认识的文件名 404 |
| 3 | 取 s1 当前修订的 `htmlUrl`（落库原文） | 存的是钉死版本的外网地址 `https://cdn.tailwindcss.com/3.4.17` 与 `https://unpkg.com/lucide@1.55.0/dist/umd/lucide.min.js`（换成副本只发生在下发时） |

后置：删项目。

#### `TC-CORE-096` 建作业的入口校验：不存在的通道当场 404 — 对应 `REQ-CORE-011`（`API-CORE-006` 入口校验，v1.06）· 级别: 边缘 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Entry --device mobile --screens 1 --no-shot`；记下 `GET /v1/projects/<id>/jobs` 的条数。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/<id>/jobs`：`kind=edit_screens`、`input.runner={kind:"channel",channelId:<不存在的 UUID>}` | 404，作业条数不变（此前要到 worker 里才失败） |
| 2 | `POST /v1/projects/<id>/messages` 带同一个不存在的通道 | 同样 404，作业条数不变 |

后置：删项目。

#### `TC-CORE-082` 事件流假死时作业照样收尾 — 对应 `REQ-CORE-005` · 级别: 边缘 · 执行者: AI

前置：`pnpm seed:project --name Frozen --device mobile --screens 1 --no-shot`；3981 端口起 OpenAI 兼容桩（改屏拖 1.5 s 回一张固定屏），建一条指向它的通道并在输入框选上。
单开一个浏览器上下文，初始化脚本把 `EventSource` 包一层：记开流次数，`__freezeSse()` 让当前这条流此后的事件一律丢掉、连接不断（模拟经 Vite 代理时 API 重启：代理不关浏览器一侧，流停在 `open`、什么都收不到）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 等事件流 `open` 后冻住它；选中 Screen 1，输入框发「标题改成「假死测试」」 | 输入框上方出一枚作业 chip「改「Screen 1」 · 排队中…」；作业在服务端几秒内 `succeeded` |
| 2 | 等最多 60 s | 作业 chip 撤掉（流 35 s 没收到任何事件就重建，重连后对账：本页在请求前已跟踪、详情不再列出 = 已结束）；开流次数比冻住前多（修复前 66 s 后 chip 还挂着「排队中…」，开流次数不变） |

后置：无。

#### `TC-CORE-023` 画布浮层外壳与快捷键 — 对应 `REQ-CORE-004` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name ShellCheck --device mobile --screens 4`；打开该项目，视口 1440×900；建一条 OpenAI 兼容桩通道并在输入框里选中（第 7 步量的是带屏数 / 版数档位的输入框，stub 轮次没有云端通道，v0.82）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 观察画布页 | 顶栏、右侧竖排工具栏、底部输入框三处浮层两两不重叠，画布铺满其下 |
| 2 | 读顶栏、项目切换器与小地图的几何和计算样式；在切换器右侧 120 px、同一高度取 `elementFromPoint` | 顶栏不铺底（v1.10，设计文档 §13.1）：底色透明、无底边线、无 `backdrop-filter`，盒子只包住左上角的项目切换器（宽 < 400 px）；切换器是毛玻璃 chip（v1.15）：底色等于 `--semantic-material-chrome-tint`、`backdrop-filter` 含模糊；切换器与小地图（开着时）左缘对齐（差 ≤ 0.5 px）；切换器右侧那一点命中的不是顶栏 |
| 3 | 量工具栏每个按钮的命中盒与 Tab 序 | 命中盒均 ≥ 44×44；`tabindex=0` 的恰好 1 个；聚焦后按 ↓ 焦点移到下一个工具 |
| 3b | 视口改成 1440×600，聚焦工具栏按 `Home`，再按 `End`；之后视口改回 1440×900 | 工具栏整体在视口内，放不下的工具在工具栏内滚动（`scrollHeight > clientHeight`），看不到滚动条（`offsetWidth − clientWidth = 0`）；`Home` 时 `data-fade=bottom`、只有底边露出向下的小箭头（`rail-more` `data-side=bottom`，v1.11）；`End` 后焦点在最后一个工具、它在滚动区可见范围内且四周留出 ≥ 4 px（焦点环不被裁），`data-fade=top`、箭头换到顶边（v0.70） |
| 4 | 悬停「接上跳转」与「连线」工具 | 提示出现在工具栏左侧、完整可见不被裁切，含该工具的作用说明；有快捷键的工具在提示里标出按键 |
| 5 | 依次按 `F` / `L` | 分别触发适配视图、切换连线显示（`toggle-links` 的 `aria-pressed` 翻转）|
| 6 | 单独按 `D` / `T`，再按 `⌥D` / `⌥T`；另按 `⌘E` | 单键不开任何面板（URL 无 `panel=`）；带 `⌥` 才分别打开设计系统、本机 agent 面板，面板标识进 URL `?panel=`；`⌘E` 开启选择元素模式（不必先选中屏），再按一次退出 |
| 7 | 点进底部输入框，键入 `dlt` | 输入框内出现「dlt」；不触发任何工具，URL 无 `panel=` |
| 8 | 在输入框填入 12 行文本 | 输入框随内容增高到上限后内部滚动（`scrollHeight > 盒高` 且盒高 ≤ `max-height`），不顶开外框 |
| 8b | 在输入框键入「草稿」，焦点仍在输入框内按 `⌘/`；再按 `⌘/` | 第一次：输入框（`form.composer`）不可见，底边正中留一枚贴边胶囊（`composer-pill`，`data-dock=bottom`，写「继续写」——输入框里有字，v1.16），安全区探针（`safe-area`）底边下移 > 60 px；第二次：输入框回来、内容仍是「草稿」、光标落回输入区、安全区底边复原 |
| 8c | 点工具栏「收起输入框」（`toggle-composer`），再点同一工具（此时标「显示输入框」）；再点输入框右上角的「收起」（`composer-collapse`），点胶囊 | 工具栏、输入框自己的「收起」与 `⌘/` 是同一开关：收起后草稿仍在，工具的 `aria-pressed` 跟着显隐翻转；点胶囊展开（v1.16） |
| 8d | 双击一屏进入交互；按 `⌘/`；再按 `⌘/`；按 `Esc` 退出 | 进入交互后输入框自动收起成胶囊；聚焦期间 `⌘/` 可临时叫出、再按收回；退出后输入框回到进入前的显示状态 |
| 9b | 按 `Esc` 清掉 8d 留下的选中（回到造态：带屏数 / 版数档位、最宽的输入框），再按 `⌥D` 滑出右侧面板，再按 `⌥D` 收回 | 输入框可以让位但不被压住：右缘不越过面板左缘，且与面板之间只剩外壳本来的 1rem 间距（不过度退让）；收回后回到原位。输入框左右留白相等，即压在视口正中 |
| 10 | 发起一次生成，作业进行中时按 `Esc`（非聚焦态、无弹窗，也没开面板、模式与选中——v0.80 起它们各自先吃掉一下 `Esc`，见 `TC-CORE-057`） | 作业进行中输入框照旧可输入（v0.36 起不禁用），输入框上方出现这个作业的 chip（`job-chip`）并带取消键；`Esc` 取消最新那一个作业（转 cancelled），这枚 chip 随之消失（多个在跑时的逐个取消见 `TC-CORE-036`）|
| 11 | 视口切到 390×844 | `documentElement.scrollWidth ≤ clientWidth`（无横向滚动）；工具栏底部仍在视口内；输入框在窄视口下工具条折行、变高，安全区底部占位跟着实际高度走 |
| 12 | 在「造」态（不选中任何屏）逐个视口量工具条：对 `.composer-bar` 里每对 `[data-testid]` 控件做矩形相交；再点选一屏（屏数档位收起），用 `requestAnimationFrame` 逐帧采样 `.composer` 的宽 / 高（v0.50 工具条几何） | ① 任意两个控件相交面积为 0（此前通道名一长，`add-image` 就压在 `count-group` 上 21×32 px、屏数的「1」点不到）；② 宽度等于工具条一行排满所需（造态实测 709 px，工具条右缘余量 0），不是固定值；③ 工具条内容变了时宽度**单调变化、有中间帧**（不是硬切），而**高度全程只有一个值**（此前宽度动画中途工具条折成两行又弹回，高度来回跳）；④ 可用宽度差一点时先截短通道名（触发器最窄 6rem），`.composer` 不带 `data-bar`、工具条仍是一行；截到最窄仍装不下时带 `data-bar="wrap"`：左组守住一行，右组（屏数 · 版数 · 发送）整组落到第二行；连左组都放不下一行时（390 px）带 `data-bar="wrap-all"`，两组内部各自折行；三种情况控件都全部可见可点（v0.78） |

后置：无。

#### `TC-CORE-024` 多选屏幕作为对话上下文 — 对应 `REQ-CORE-006` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name MultiSel --device mobile --screens 4`；打开该项目，建一条拖住不回的 OpenAI 兼容桩通道并在输入框里选中（第 5 步从输入框发一轮，随后取消，v0.82），按「适配视图」。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 单击第 1 屏，再按住 Shift 单击第 3 屏 | 两屏都带选中态；底部输入框列出两个可移除的目标标签，并显示「目标：2 屏」 |
| 2 | 点其中一个标签上的移除按钮 | 该屏取消选中，只剩 1 屏；输入框恢复单屏文案「目标：<名> <路由>」 |
| 3 | 在画布空白处按住拖出覆盖全部 4 屏的选框 | 拖拽过程中出现选框，且**尚未松手时命中的 4 屏就已高亮**（不是松手后才亮）；松手后 4 屏全部选中（`.selected`） |
| 4 | 按 `⌘A` | 4 屏全部选中（与步骤 3 一致）；输入框动词行（`verb-line`）为「改全部 4 屏」 |
| 5 | 发送一条修改指令 | `POST /v1/projects/<id>/messages` 的 `targetScreenIds` 等于选中的 4 屏；助手消息的 `affectedScreenIds` 与之一致 |
| 5b | 作业进行中点画布空白处，再点目标区「清空」（`clear-targets`） | 点空白只清画布高亮：4 枚目标标签（`target-chip`）仍在、动词行仍为「改全部 4 屏」（`REQ-CORE-006` 目标标签只被点屏 / × / 清空改变）；点「清空」后标签为 0、动词行变为「造 …」 |
| 6 | 选中 2 屏，查看工具栏 | 出现「删除 2 屏」，不出现「修订」（修订链是单屏概念）；点删除后确认框标题为「删除选中的 2 屏？」 |

后置：无。

#### `TC-CORE-025` 生成通道可选 — 对应 `REQ-CORE-011` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Runner --device mobile --screens 2`；建一条已验证的 OpenAI 兼容桩通道当云端通道（拖住不回，v0.82：stub 轮次种子不建 Gemini 通道）；打开；记录 `GET /v1/me/usage`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `GET /v1/runners` | 返回用户自己配的云端通道（`source=channel`：前置建的桩通道；`.env` 有 `GEMINI_API_KEY` 时还有种子建的 Gemini 通道）与「交给本机 agent」两类，没有「系统预置」（v0.34）；响应中无任何凭据形态的串（`sk-…`/`AIza…`/PEM）；未验证 / 验证失败的通道照样列出但 `available=false` 且带 `unavailableReason` |
| 2 | 打开画布，看输入框工具条左端的通道选择器 | 触发器的 `data-value` 等于 `GET /v1/runners` 返回的 `default`，且显示该项名称 |
| 3 | 点开选择器 | 只列 `available=true` 的通道，项数等于清单中可用项数；不可用项不出现（原因在设置页看，`REQ-CORE-013`）；仍按「云端模型 / 本机 agent」分组；末尾有「管理模型…」入口；每项只有厂商图标 + 显示名——取一个显示名不含模型 id 的可用通道，其模型 id（如 `gemini-3.8-flash`）不出现在任何下拉项里（模型 id 在设置弹层看，见 `TC-CORE-028` 第 7 步） |
| 4 | 列表开着时按 `Esc`；再选中一屏、点开列表、按 `Esc` | 列表关闭、焦点回到触发器；画布上那一屏仍处于选中态（`Esc` 没有漏给画布） |
| 5 | 点开列表，选另一个可用通道，然后刷新页面 | 触发器 `data-value` 变为所选项；刷新后仍是所选项（偏好跨会话记忆） |
| 6 | 选一个可用的云端模型并发送 | `POST /messages` 返回 202，作业 `input.runner` 带上该 `driver` 与 `model` |
| 7 | `GET /v1/agent/sessions`；再直接 `POST …/messages` 两次，`runner` 分别为 `{kind:"agent",tool:"claude-code"}`（缺 sessionId）与带一个不存在的 sessionId | 会话列表接口返回 `items` 数组（`API-AGENT-010`）。本机有 `claude` 时：两次都在建作业前返回 400 `/errors/validation`，后者的错误信息为「会话已关闭或不存在，重新选一个」；`GET /v1/projects/<id>/jobs?runner=agent` 条数不变（被拒的发送不留作业）。投递、回执、屏锁、不记用量、不占输入框见 `TC-AGENT-009`。本机没有 `claude` 时：清单里该项 `available=false` 并带 `setupHint`，发送返回 400 `/errors/validation` 且错误信息给出安装步骤 |

后置：步骤 6、7 产生的作业随即取消。

#### `TC-CORE-026` 品牌接入一致性 — 对应 `REQ-CORE-004`（§13.1）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Brand --device mobile --screens 2`；视口 1440×900；系统偏好浅色。基准值取自产品带的 brand 副本 `apps/web/src/brand/tokens.css` 里 `[data-theme="light"]` 与 `[data-theme="dark"]` 两块（v1.09；`brand/` 本身不进仓库）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `pnpm seed --empty` 后打开 `/`（PAGE-FIRST，首次运行的第一屏），量显示出来的品牌符号；再给 `<html>` 写 `data-theme="dark"` 量一次 | 浅色下显示的是石墨灰版 `symbol-graphite.svg`、深色下是反白版 `symbol-reverse.svg`（v1.08）；`naturalWidth > 0`（资产真的取到）；渲染边长 ≥ 64 px（品牌下限）；外层安全区 = 边长的 1/8 |
| 2 | 在同一页读字标的计算样式，再 `pnpm seed` 打开画布看顶栏 | `document.fonts.check` 确认 Space Grotesk 已加载；字标 `font-family` 为 Space Grotesk、`font-weight` 500、字距 = −0.03 em；`body` 的 `font-family` 是系统字体列表（含 `-apple-system` 与 `PingFang SC`，不含 Space Grotesk，v1.15）。画布顶栏里没有 `.wordmark`，左上第一个元素是项目切换器（品牌不上画布顶栏，§13.1） |
| 3 | 依次给 `<html>` 写 `data-theme="light"`、`"dark"`，各读一遍外壳语义变量（画布、面板、正文、次级、弱文字、动作色、动作色上的字、标记色）的计算色 | 两套都等于 `apps/web/src/brand/tokens.css` 对应 `[data-theme]` 块里的值；正文 / 次级 / 弱文字对面板与画布、动作色上的字对动作色七组都 ≥ 4.5:1，标记色对画布 ≥ 3:1 |
| 4 | 读 `link[rel=icon]` 并请求它 | href 指向 `/brand/`，返回 200 |
| 5 | 读画布上的风格指南卡片 | 不出现 Space Grotesk——工具品牌字体不得渗进用户项目的设计系统（§13.1 边界） |

后置：无。

#### `TC-CORE-027` 参考图输入 — 对应 `REQ-CORE-012` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name ImgRef --device mobile --screens 2 --no-shot`；建一条指向本地 OpenAI 兼容桩的通道「Stub 视觉 27」并验证通过（stub 轮次没有云端通道，账号自建通道都支持视觉）；打开该项目。
用例只验通道，不真跑生成（带图的真实出屏见 `RUN-051` 执行记录）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/projects/<id>/attachments`，分别传 `image/svg+xml` 与 50 MB | 两者都返回 422 `/errors/validation`——类型与大小在签发签名 PUT 时就挡住，不等正文传完 |
| 2 | curl `GET /v1/runners` | 每一项都带 `vision` 布尔标记；至少有一个 `vision=true` 且可用的云端通道 |
| 3 | 若通道清单中存在 `vision=false` 的项（v0.24 起当前没有，脚本自动跳过），切过去再选图 | 「加参考图」按钮为 `aria-disabled`；即使绕过按钮直接选文件也贴不上（缩略图数为 0），提示换通道 |
| 4 | 切到支持视觉的通道，选 1 张图；再选 4 张；移除 1 张 | 出现缩略图；上限 4 张、超出被截断；可逐张移除 |
| 5 | 填一句指令并回车 | 请求体带 3 个 `attachmentIds`；作业 `input.imageKeys` 同样是 3 个 |
| 6 | 若存在 `vision=false` 的通道（当前没有，脚本自动跳过），直接 curl 发消息带 `attachmentIds` 并指定它 | 返回 400 `/errors/validation`——前端护栏被绕过时服务端仍拒，不静默丢图 |

后置：步骤 5 产生的作业随即取消。

#### `TC-CORE-028` 生成通道可配置 — 对应 `REQ-CORE-013` · 级别: 回归 · 执行者: AI

前置：服务端 `.env` 已配置 `QUILT_SECRETS_KEY`；`pnpm seed:project --name Chan --device mobile --screens 1 --no-shot`；本地起一个 OpenAI 兼容桩（`tests/e2e/openai-stub.ts`，只认 Key `good-key-0001`，回放该屏当前 body 并加标记）。
第 7 步之前另建一条已验证的桩通道 `Stub 管理 28`（第 6 步已删掉 Stub 通道，stub 轮次又没有种子的云端通道，管理器的「自建通道」一组要有一行，v0.82）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/channels` 建 OpenAI 兼容通道但不给端点 | 400 `/errors/validation` |
| 2 | 建通道（端点指向桩、模型 `stub-1`、Key `good-key-0001`） | 201，`status=unverified`，响应只含 `apiKeyHint=0001`、不含明文；`GET /v1/runners` 里该项 `source=channel`、`available=false` |
| 3 | `POST /v1/runners/channel:<id>/probe` | `ok=true`；目录里该项 `available=true`、`status=verified` |
| 4 | 用该通道发一条改屏消息 | 202；作业成功，`input.runner={kind:"channel",channelId}`；桩收到 `model=stub-1` 的请求；`GET /v1/me/usage` 的 `tokensIn` 增加 ≥ 42（按通道记账）；屏的新修订含桩标记 |
| 5 | `PATCH` 把 Key 改成错的，再探测 | 改后 `status=unverified`；探测 `ok=false` 且 `error` 含供应商的 401；目录里 `available=false`、原因含「验证失败」；`GET /v1/channels` 与更新响应均不含任何 Key 明文 |
| 6 | `DELETE` 该通道，再用它发消息 | 204；发消息返回 404 |
| 7 | 打开 `/p/<id>?settings=models`，看设置弹层（`settings-modal`） | 弹层分栏：左栏 3 个 `role=tab`（用量 / 模型 / 系统，v1.24），「模型」为选中态；把焦点放到该 tab 按 `↑` 切到「用量」且 URL 变为 `settings=usage`，按 `↓` 切回。右栏的管理器（`channel-manager`）分「本机 agent / 我的模型」两组（v0.34 起没有系统预置，云端通道都是自己配的）；取一个显示名不含模型 id 的通道，其行内写出了模型 id（画布下拉不显示，这里是它的家）；每行有厂商图标、状态药丸（`runner-status`）与「验证」（`probe-runner`）；本机 agent 行可用时次行写「找到 claude 命令」（Codex 那行是 codex），不可用时给「如何配置」（`setup-hint`，展开是配置步骤，v1.24） |
| 7b | 建一条「本机 Claude 订阅」类型的通道，不填 Key；再改它的模型名 | 201 且 `apiKeyHint=null`（这类通道用本机的 `claude` 登录态，没有 Key）；改模型名后 `status` 回 `unverified`；其它类型缺 Key 仍返回 400 |
| 8 | 点「添加模型」（`add-channel`），面板（`channel-dialog`）内连按 Tab 若干次，再按 Esc | 焦点始终在面板内循环；Esc 只关内层面板：设置弹层仍开着、背景 `#root` 仍是 `inert`（弹层叠弹层按引用计数隔离），焦点回到「添加模型」按钮。选 OpenAI 兼容 → 厂商预设，端点自动填入；填模型与 Key 点「保存并验证」→ 行内出现「已验证」 |
| 9 | 回到画布看输入框下拉 | 只列 `available=true` 的通道，每项带厂商图标，末尾有「管理模型…」（`manage-channels`）入口打开设置弹层；未验证 / 验证失败的通道不出现 |

后置：删除用例创建的通道；桩服务关闭。

#### `TC-CORE-029` 锚点造屏：一屏三版候选、造一组反向连线 — 对应 `REQ-CORE-014`、`REQ-CORE-003`、`REQ-CORE-015`、`REQ-CORE-016` · 级别: 回归 · 执行者: AI

前置：服务端 `.env` 已配置 `QUILT_SECRETS_KEY`；`pnpm seed:project --name Blank --device mobile --screens 1 --no-shot`；本地起 OpenAI 兼容桩（`tests/e2e/openai-stub.ts`，Key `good-key-0002`）：单屏规划提示（含 `Requested screen:`）固定回 `{"name":"Order Detail","route":"/order-detail","purpose":"show one order",…,"links":[],"entryFrom":null}`；整组规划提示（含 `Request:`）回 `{"entryFrom":"/s1","screens":[Cart /cart, Checkout /checkout]}`；出屏 / 改屏提示回放种子屏 body 并编号；以 API 建好指向桩的通道并探测通过；打开项目后先在输入框里选中这条桩通道（同一浏览器上下文里更早的用例可能让它记住了本机 agent 通道，v0.82）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开画布，无目标时看输入框；在空白处双击；点锚点药丸上的 × | 动词行（`verb-line`）为「造 1 屏 · 自动摆放」；双击后画布出现虚线锚点（`anchor`）、焦点落在输入框（`#chat-input`）、目标区出现「新屏 · 此处」药丸（`anchor-chip`）、动词行为「造 1 屏 · 此处」；× 撤掉锚点 |
| 2 | 点空白让焦点离开输入框，按 `⌥G`；再点工具栏「新建屏幕」（`new-screen`） | 两个入口都在可见区中心放锚点；「清空」（`clear-targets`）撤掉 |
| 3 | 再次双击同一空白点，通道下拉选桩通道，版数选 3（`versions-3` 的 `aria-checked=true`），填描述，回车 | 动词行为「造 1 屏 × 3 版 · 此处 = 5 次调用」（3 版各 1 次 + 规划 1 + 入口屏补链至多 1）；请求体无 `targetScreenIds`、`count=1`、`versions=3`、`anchor` 等于双击点的画布坐标 |
| 4 | 等 `kind=generate` 作业结束后 `GET /v1/projects/<id>` 与该屏的修订列表 | **只新增 1 屏**（候选不是独立屏、无 `-2` 后缀）：`/order-detail`、`purpose=show one order`、以锚点为中心（误差 ≤ 2）；3 条修订同 `jobId`、`candidateIndex` 0/1/2、`candidateSettledAt` 为空；`currentRevisionId` = 第 0 版；`ScreenDto.pendingCandidates.count=3`；项目 `exemplarScreenId` = 新屏（首轮默认样板）；桩收到 1 次规划 + 3 次出屏且出屏提示含「does not need to navigate」；画布上造完自动把新屏设为目标：动词行变为「改 1 屏」、目标标签为 Order Detail |
| 5 | 点卡片角标「3 版 · 展开」（`candidate-badge`），在就地展开层（`candidate-stack`）点第 2 格右上角的 ✓「就用这一版」（`adopt-one-1`）；选中该屏按 `⌥R` | 收起态卡片后面叠着错位底板（`cand-ghost`）；展开层 3 格（`candidate-cell`）横向一行：第 1 版留在卡片原位并标「当前」、带 ×「收起」，其余按卡片同尺寸排到右边；每格是该版的活 iframe（`candidate-cell iframe` 3，src 带各自 `rev=`），在格内能滚动；动作是每格上方右缘对齐的浮层图标胶囊；采用后 current 指向 index 1、同批结清、展开层自动收起、角标与底板消失、修订不增；修订面板把 3 版折成一组（`candidate-group` 1）且没有可采用项 |
| 6 | 先点选 `/order-detail` 卡片、在输入框键入一句草稿（目标与草稿都摆好），再 `POST /v1/projects/<id>/messages`（无目标，`count=2`、`versions=1`、`anchor={x:2600,y:400}`、桩通道）——等价于 MCP 或另一个标签页在后台造屏 | 作业成功：新增 `/cart`、`/checkout` 两屏，按流程顺序在同一行向右排开、第一张以锚点为中心；入口屏 `/s1` 多一条修订（反向连线：对入口屏跑了一次补链）；助手消息（`GET …/messages`）含「已生成 2 屏」与「已把「Screen 1」接到新屏」 |
| 6b | 看输入框上方的作业 chip 与输入框（v0.38） | 页面认领了这个后台作业（它的 `job-chip` 出现过、进度兜底写「排队中…」而不是空着）；**作业收口后目标标签仍是 Order Detail 一枚、草稿一字不变**——「造完自动选中新屏」只在目标为空时接管，否则用户手写的指令会被改投到刚造出来的屏上 |

后置：删除用例创建的通道；桩服务关闭。

#### `TC-CORE-030` 改 3 屏出 2 版并整组采用 — 对应 `REQ-CORE-006`、`REQ-CORE-015` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Versions --device mobile --screens 3 --no-shot`；本地起 OpenAI 兼容桩（Key `good-key-0003`，改屏提示回放种子屏 body 并编号）；以 API 建好指向桩的通道并探测通过。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开画布选桩通道，单击一屏后 `⌘A`，版数选 2（`versions-2`） | 动词行为「改全部 3 屏 × 2 版 = 6 次调用」；改的时候不出现屏数控件（无 `count-group`） |
| 2 | 填指令回车，等这个作业成功 | 请求体 `targetScreenIds` 3 屏、`versions=2`；`GET /v1/projects/<id>` 每屏 `pendingCandidates.count=2` 且三屏 `jobId` 相同；画布上 3 枚候选角标 |
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

#### `TC-CORE-040` 找屏与总览 — 对应 `REQ-CORE-024`（v0.61）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Finder --device mobile --screens 4 --dangling --no-shot`；打开项目，等第一张卡出现。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `⌘K` | 跳屏面板（`screen-finder`）打开，焦点在搜索框（`finder-input`） |
| 2 | 输入 `s3`，`Enter` | 列表只剩 /s3 一行（`finder-row` 的 `data-id`）；面板关闭，/s3 被单选（`.card.selected[data-route="/s3"]`），卡片中心与可用区（`safe-area`）中心相差 ≤ 8 px，画布缩放 ≤ 1（世界层 `transform` 的 `scale`） |
| 3 | `⌥S` | 屏列表面板（`screens-list`）滑出，4 行（`screens-row`） |
| 4 | 点筛选片「断链」（`screens-filter-dangling`） | 只剩 /s1 一行，片 `aria-pressed=true` 且计数 1 |
| 5 | 点那一行 | /s1 被单选并进入视野；再按 `⌥S` 收起面板 |
| 6 | 看小地图（`minimap`，canvas 绘制） | `data-screens=4`，`data-view` 给出视口框在小地图里的位置 |
| 7 | 点小地图里视口框外的空白（框左边有空点左边，否则点右边） | 镜头朝那边平移：点左边世界层 transform 的 x 变大，点右边变小 |
| 7b | 按住视口框（`data-view` 算出的位置）中心，向左拖 20 px，再原地左右抖 20 次 1 px，松开 | 按下时视口框 `x` 不变（不跳到指针下）；拖动后世界层 x 变大；抖动前后世界层 x 相差 ≤ 2 px（镜头不自己跑） |
| 7c | 双击 /s1 聚焦 | 小地图不渲染；退出聚焦后回来 |
| 7d | 聚焦中把焦点放进 iframe 里的输入框，按 `⌘K`，再 `Esc` 两次 | 跳屏面板打开（运行时转发 `⌘K`）、关闭；第二次 `Esc` 退出聚焦 |
| 7e | 点工具栏「找屏」（`find-screen`），`Esc` | 面板关闭后焦点回到「找屏」键 |
| 7f | 视口高度改 260 px，`⌘K`，`↓` 三次 | 选中行（`aria-selected=true`）在列表可视区内 |
| 8 | 工具栏「小地图」（`toggle-minimap`）点一次；再把焦点放在这个键上按空格 | 第一次小地图消失；空格激活该键（不被画布平移吃掉），小地图回来 |

后置：无。

#### `TC-CORE-041` 状态变体 — 对应 `REQ-CORE-025`（v0.62）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Variants --device mobile --screens 3`；API 以 stub 驱动；打开项目，等截图出现。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点 /s1 卡片 → 工具栏「出变体」（`new-variant`）→ 状态名填「空态」→「出变体」（`variant-create`） | toast「正在出「Screen 1」的「空态」变体」；60 s 内 `GET /v1/projects/{id}` 多出一屏：`variantOf=/s1 的 id`、`variantName=空态`、`name=Screen 1 · 空态`、`route=/s1`，位置 y 同默认屏、x = 这一行（与默认屏纵向相交的屏）最右一屏的右缘 + 80，三屏种子即 1410（v0.82） |
| 1b | 看 `GET /v1/projects/{id}` 的 `project.exemplarScreenId` | 不是变体的 id（样板屏只自动钉整屏默认屏） |
| 2 | 看 `links` 与 `GET /v1/projects/{id}/app-map` | 指向 /s1 的链接 `toScreenId` 都是默认屏；地图 `nodes` 只有 3 个默认屏、不含变体 |
| 3 | 看画布 | 变体卡（`.card[data-variant="true"]`）标签带「变体」片；/s1 默认屏卡标签含「1 个变体」 |
| 4 | 双击 /s1 默认屏聚焦 | 卡内顶部中央出现两颗状态胶囊（`variant-chip`）「默认 / 空态」，「默认」`aria-pressed=true`；胶囊条上沿不高于交互角标下沿（不重叠） |
| 5 | 点「空态」胶囊 | 该胶囊变为按下；iframe 的 body 内容换成变体的、iframe 未重建；世界层 transform 不变（镜头不动）；角标仍写 /s1 |
| 5b | `⌘E` → 点 iframe 里的 h1 → 检查器文案框填「Variant edited」→ 按 `Esc` → 点「保存（零 token）」 | Esc 后仍在聚焦、文案框草稿还在；保存后变体最新修订 `sourceKind=manual`，默认屏 `currentRevisionId` 不变 |
| 6 | `PATCH /v1/screens/{变体}` `{ route }`；`PATCH /v1/screens/{默认屏}` `{ variantName }` | 都是 `422 /errors/validation` |
| 6b | `PATCH /v1/screens/{变体}` `{ presentation: overlay }`；再 `PATCH /v1/screens/{默认屏}` `{ presentation: overlay }`；之后改回 push | 前者 `422`；后者 `200` 且变体的 `presentation` 同为 overlay；30 s 内两屏的 `screenshotUrl` 都换成 `<修订 id>.overlay.webp`（按透明底重拍、换了地址，v1.03；v1.27 起截图是 WebP）；改回 push 后 30 s 内换回 `<修订 id>.webp` |
| 7 | `POST jobs kind=export_prototype` → 下载 | 单文件里只有 3 个 `<template data-route=`（不含变体） |
| 8 | 选中 /s1 默认屏，`Delete` | 确认框写明「它的 1 个变体一起删除」；确认后项目剩 2 屏 |

后置：无。

#### `TC-CORE-072` 出变体落位不压住已有的屏 — 对应 `REQ-CORE-025`（v0.82）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name VariantRow --device mobile --screens 3 --no-shot`（/s1 (0,0)、/s2 (470,0)、/s3 (940,0)）；建作业一律显式带 `runner:{kind:"model",driver:"stub",model:"stub"}`。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-072`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `PATCH /v1/screens/<s3>` `{ x: 3000, y: 1200 }` | `200`（/s3 挪到下一行） |
| 2 | `POST …/jobs` 建 `generate { variantOf: s1, variantName: "Empty" }`，等它结束 | `succeeded`；变体落在 (940, 0)：/s1 那一行（/s1、/s2）最右一屏的右缘 + 80，与默认屏同 y；另一行的 /s3 不影响（修复前落在 (470, 0)，压住 /s2） |
| 3 | 再出一个 `variantName: "Error"` | 落在 (1410, 0)，即第一个变体右侧 |
| 4 | 读项目全部屏 | 任意两屏的 390×844 矩形不相交 |

后置：无。

#### `TC-CORE-042` 重试一轮：原样再发、只换通道，边界状态码 — 对应 `REQ-CORE-026`（`API-CORE-034`，v0.72；界面上的预览与消息操作 v1.17 起随对话记录去掉）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Msgs --device mobile --screens 2 --no-shot`；经接口对 /s2 发一轮「照这两张图改」，带 2 张参考图、显式走 stub，跑完；起一个收到请求 6 s 后才回的 OpenAI 兼容桩（端口 3993，回放 /s2 的 body），建一条指向它的「Slow 通道」并验证通过。
界面上的「重试」只在失败的作业 chip 上，见 `TC-CORE-045`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 对那一轮的用户消息 `POST …/messages/{id}/retry`，`runner` 指到 Slow 通道 | `202`；消息列表末尾多出一轮（两条）：用户消息正文与参考图 id 与原来一致；新作业 `kind=edit_screens`、`screenIds=[/s2]`、2 个 `imageKeys`，`runner` 是 Slow 通道（原作业不是） |
| 2 | 新作业还在跑时，对新的用户消息 `POST …/retry {}`；等新作业跑完 | `409 /errors/job-not-finished`；新作业 `succeeded`，桩收到带图的请求 |
| 3 | 对一条助手消息 `POST …/retry`；`POST jobs kind=export_prototype` 跑完后对它那条用户消息 `POST …/retry` | 前者 `404`；后者 `400 /errors/validation`、`path=messageId` |

后置：关桩。

#### `TC-CORE-043` 「修改」还原完整参数（已废弃：v1.17 去掉对话记录与「修改」入口）— 对应 `REQ-CORE-026`（v0.74）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

已废弃，不再执行：第 1 步的接口校验并入 `TC-CORE-062` 第 7 步。以下是废弃前的步骤，留作对照。

前置：`pnpm seed:project --name Rounds --device mobile --screens 2`；经接口建组件「AuditTab」；API 以 stub 驱动。
打开画布后先建一条 OpenAI 兼容桩通道（端口 3973）并在输入框里选中：stub 轮次没有云端通道（§3），输入框缺省落在「交给本机 Claude Code」上，没选会话发不出去（v1.06）。
输入框发出的 `POST …/messages` 与 `…/retry` 一律拦下、把 `runner` 换成 `{kind:"model",driver:"stub",model:"stub"}` 再放行并记下原始请求体。
经接口发的轮次显式走 stub。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 接口：`POST …/messages` 分别发 `{content:""、targetScreenIds:[s1]}`、`{content:""、preset:"link_repair"}`、`{content:"x"、variantOf:s1、variantName:"Empty"、targetScreenIds:[s2]}` | 三个都 `400 /errors/validation`，`path` 依次是 `content`、`targetScreenIds`、`targetScreenIds` |
| 2 | 接口发一轮 `{content:"做一个设置页，用这条 tab", targetComponentIds:[AuditTab], anchor:{x:3000,y:200}, count:2}` 并等它跑完；打开画布，对这一轮点「修改」 | 输入框正文是原话；锚点胶囊 1 枚、组件胶囊 1 枚；表单 `data-verb=create`、动词行含「此处」 |
| 3 | 直接按 `Enter` | 请求体带 `anchor` 与 `targetComponentIds`、不带 `targetScreenIds`；新作业 `kind=generate`、`input.anchor` 与 `input.componentIds` 都在（不是改组件） |
| 4 | 接口建出变体作业（`POST jobs kind=generate`，`variantOf=s1`、`variantName=Loading`、`prompt="spinner while loading"`），跑完后点「修改」 | `preset-chip` 文字含「Screen 1」与「Loading」；正文是「spinner while loading」；动词行含「出变体」，屏数档位不在，没有目标屏胶囊 |
| 5 | 正文改成「spinner and skeleton rows」按 `Enter` | 请求体带 `variantOf=s1`、`variantName=Loading`；新作业仍是 s1 的 Loading 变体、提示词是新正文；用户消息正文「出「Loading」状态变体：spinner and skeleton rows」；作业成功，胶囊收起 |
| 6 | 接口建懒生成作业（`route=/audit-help`、`fromScreenId=s1`、`prompt="Screen for route /audit-help"`），跑完后删掉它造的屏，再点「修改」 | 胶囊含「/audit-help」；正文为空、发送键不置灰 |
| 7 | 写「顶部带搜索框」按 `Enter` | 请求体带 `route`、`fromScreenId`；新作业钉死 `/audit-help`，提示词 = `Screen for route /audit-help` + `\n\nADDITIONAL REQUIREMENTS FROM THE USER: 顶部带搜索框`；用户消息「生成缺失的页面 /audit-help：顶部带搜索框」；作业成功 |
| 8 | 接口建接上跳转作业（`edit_screens`，`prompt=LINK_REPAIR_PROMPT`、`screenIds=[s1,s2]`），跑完后点「修改」 | 胶囊「接上跳转」、目标屏胶囊 2 枚、正文为空、动词行「接上跳转 2 屏」 |
| 9 | 正文留空按 `Enter` | 请求体 `preset=link_repair`、`content=""`；新作业的提示词与原作业逐字相同（= 重试）、目标两屏；用户消息「接上跳转：把 2 屏的按钮 / 表单连上路由」 |
| 10 | 接口建按新约定重生成作业（`prompt=CONVENTIONS_REGENERATE_PROMPT`、`screenIds=[s2]`），「修改」后写「标题用衬线字体」发送；跑完后再点「修改」 | 新作业提示词 = 固定指令 + 附加要求；用户消息「按新约定重生成 1 屏。附加要求：标题用衬线字体」；再修改时正文反解回「标题用衬线字体」、胶囊还在 |
| 11 | 点胶囊的 ×；再「修改」一次，适配视图后点选第 7 步造出的「Audit Help」卡片 | × 后胶囊消失、动词行以「改 1 屏」开头；点选屏后胶囊让位、目标换成 Audit Help |

#### `TC-CORE-044` 对话记录：贴底才跟随、重试在途锁、预览按图定位（已废弃：v1.17 去掉对话记录）— 对应 `REQ-CORE-026`、`PAGE-CANVAS`（v0.74）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

已废弃，不再执行：重试防连点改由 `TC-CORE-045` 第 2 步双击「重试」覆盖。以下是废弃前的步骤，留作对照。

前置：`pnpm seed:project --name Scroll --device mobile --screens 2 --messages 30`（30 条没有作业的文字消息，撑出滚动）；经接口发两轮带图改屏（各 1 张），都跑完；起一个收到请求 4 s 后才回的 OpenAI 兼容桩并建一条指向它的通道；输入框发出的写请求同 `TC-CORE-043` 拦下改走 stub。
打开项目，对话记录展开；验证这条慢桩通道并在输入框里选中（第 2 步从输入框发一轮，v0.82）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 看对话记录；用滚轮把它翻到顶；接口经慢通道对 s1 发一轮，等它跑完、回执进对话 | 打开时在底部；在跑作业行带着进度（「正在…」）出现过；整个过程里列表 `scrollTop` 的最大值 < 4（进度与新消息都没把它拽走） |
| 2 | 点选 s2，输入框写一句按 `Enter` | 列表滚到底 |
| 3 | 把重试请求拖 1.5 s；同一帧里对最后一轮的「重试」连点三次；300 ms 后看按钮 | 按钮 `aria-disabled=true`、`aria-busy=true`、图标换成转圈；只发出 1 个重试请求 |
| 4 | 把 `GET …/messages?limit=100` 的响应改成不含带第 1 张图的那轮（模拟窗口滑过）；点第 2 张缩略图打开预览，接口发一轮触发对话重取 | 预览还开着，标题序号从「2 / N」变成「1 / N−1」，大图路径不变；页面没崩（没有「Unexpected Application Error」） |
| 5 | 再把带第 2 张图的那轮也去掉，先开始等「预览已关闭」的 toast，再经接口发一轮（页面在这一轮作业刚建出来时就补取消息，toast 只停 3.2 s，等作业跑完再找会落空） | 预览关闭，toast 含「预览已关闭」；对话记录照常 |

#### `TC-CORE-045` 作业失败的呈现 — 对应 `REQ-CORE-020`、§14 作业失败文案、`PAGE-CANVAS`「作业 chip」（v0.74、v1.17）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Fails --device mobile --screens 2`；经接口建组件「AuditBar」；起一个 OpenAI 兼容桩（端口 3995；每个回应拖 2.5 s，让画布先认领作业再收到失败；Key 不对回 401，Key 对时改组件回两个根元素），建两条通道：「坏 Key 通道」（Key 错）、「两根通道」（Key 对）。
打开项目；输入框里先选一条桩通道（端口 3972）才发得出去（stub 轮次没有云端通道，输入框缺省落在「交给本机 Claude Code」上，没选会话发不出去，v1.06）；发出的写请求拦下、`runner` 换成用例指定的通道。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 通道指到坏 Key 通道；点选 s1，写「改成深色」按 `Enter` | 不弹错误提示条；输入框上方出一枚失败 chip（`job-chip`，`data-state=failed`），写「Screen 1」「改屏失败」「HTTP 401」，不含 `{` `}`、`openai-compatible`、`provider`、`invalid api key`，也不写「点「重试」」；带「重试」（`retry-job`）与 ×（`dismiss-job`）；整叠（`job-chips`）下沿在输入框上沿之上 |
| 2 | 双击这枚 chip 的「重试」；等新作业失败后点它的 × | 只发出 1 个 `/retry` 请求（1 s 后仍是 1 个）；旧的那枚撤掉，换成新作业的失败 chip（同样撞 401）；点 × 后它消失 |
| 3 | 经接口对 s1 的最后一个元素建 `regenerate_subtree`，`runner` 指到坏 Key 通道 | 输入框上方出这个作业的 chip 并转 `failed`；chip 上只有 ×、没有「重试」；文案含「HTTP 401」「检查这个模型的 Key」与「在检查器里再点一次「重生成这块」」，不写「点「重试」」 |
| 4 | 通道指到两根通道；清空目标，按 `F`，点组件卡「AuditBar」，写「改成三个 tab」按 `Enter` | 出一枚失败 chip，写「改组件失败」，含「AuditBar」与「根元素」，带「重试」 |

后置：关桩。

#### `TC-CORE-046` 输入框：Esc 撤销、贴图、被挡的理由、在途输入 — 对应 `REQ-CORE-006`、`REQ-CORE-012`、`REQ-CORE-020`（v0.74）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Composer --device mobile --screens 2`；建一条指向本地 OpenAI 兼容桩的「Stub 通道 46」并验证通过；打开项目，输入框里选中它；输入框发出的写请求拦下、`runner` 换成 stub 驱动再放行；`POST …/attachments` 按步骤拖延。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 在输入框键入一段话，按 `Esc`，再按 `⌘Z`（`Ctrl+Z`） | `Esc` 后为空；`⌘Z` 后原话回来 |
| 2 | 上传拖 2.5 s；一次贴入 3 张 PNG，300 ms 后看；再贴 3 张 | 第一次贴完立刻 3 张缩略图、3 个「上传中…」；第二次当场提示「一条消息最多 4 张参考图」，缩略图共 4 张 |
| 3 | 写「照这几张图改」按 `Enter`（图还在传）；等上传完 | 发送键上方 `send-blocked-reason` 写「参考图还在上传」，没有发出请求；传完这一行消失 |
| 4 | 只留 1 张图，点选 s1；发送请求拖 1.5 s，按 `Enter` 后在途期间补打「 再补一句」并再贴 1 张图 | 发出的请求正文是「照这几张图改」、1 张图；成功后输入框剩「再补一句」、缩略图剩新贴的 1 张 |
| 5 | 本机有 `claude` 时：去掉图、清空目标，通道选「交给本机 Claude Code」（会话下拉保持「选择会话」），写一句按 `Enter` | `send-blocked-reason` 写「先选要投递的会话」，没有发出请求（本机没有 `claude` 时本步跳过并在备注写明） |

#### `TC-CORE-047` 侧面板与弹层：修订参数、找屏列全、提示层级、焦点归还、遮罩、改名焦点 — 对应 `REQ-CORE-002`、`REQ-CORE-024`、`PAGE-CANVAS`（v0.78）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Panels --device mobile --screens 14 --dangling --no-shot`（14 屏多于此前 `⌘K` 的 12 行上限；`/s1` 带一条 `/settings` 断链）；另建一个项目 `Switch Target`（1 屏）供切换器第 6 步移指针；视口 1440×900。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 直接打开 `/p/<id>?panel=revisions`；适配视图后单击 `/s1`；再按 `⌥R`、`Shift` 单击 `/s2`、单击 `/s2` | 加载后 URL 里的 `panel=revisions` 被去掉；单击 `/s1` 不出现修订面板；`⌥R` 打开修订面板，加选成两屏后参数去掉，再单选一屏也不出现面板 |
| 2 | 按 `⌘K`（`Ctrl+K`）不输入；再输入 `/s`；连按 20 次 `↓` | 两次都列出 14 行（`finder-row`）；选中行停在最后一行 |
| 3 | `⌥D` 打开设计系统面板，悬停工具栏「适配视图」 | 提示（`tool-tip`）中心点最上层是提示本身，不是面板（量前临时打开提示的命中） |
| 4 | 关掉面板。键盘聚焦「屏列表」（`toggle-screens`）按 `Enter`，聚焦面板的「关闭」按 `Enter`；再让焦点离开工具栏，按 `⌥S`，聚焦「关闭」按 `Enter` | 两次关闭后 `document.activeElement` 都是 `toggle-screens`（第二次是快捷键打开的，回到工具栏上同名的工具），不是 `body` |
| 5 | 单击 `/s3` 按 `Delete`；取消后点 `/s1` 卡上的断链标记（`.warn`） | 删屏确认与断链补屏各自只有一层铺满视口、有底色的 fixed 遮罩（遮罩是半透明墨色，v1.15 起加 6 px 背景模糊） |
| 6 | 打开项目切换器，点当前项目的重命名键，改名框填 `Panels` 后打 `AB`；指针移到 `Switch Target` 那一行中央；再打 `CD`，按 `Enter` | 指针移过后焦点仍在 `rename-input`；`Enter` 后 URL 不变（没有切项目），项目名为 `PanelsABCD` |

#### `TC-CORE-048` 表单错误态：通道弹层与新建项目 — 对应 `REQ-CORE-002`、`REQ-CORE-013`、`API-CORE-028`（v0.78）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Forms --device mobile --screens 1 --no-shot`；浏览器里拦下 `POST /v1/channels`，记下请求体并回 `400`（本用例只看表单行为，不建通道、不去验证）；打开 `?settings=models`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 「添加模型」，不填直接点「保存并验证」；在「显示名」里输入 `x` | 出现 3 条错误（显示名 / 模型名 / API Key），焦点落到 `#ch-label`；输入 `x` 后显示名的错误消失、`aria-invalid` 撤掉，模型名的错误还在 |
| 2 | 填好模型名与 API Key，点弹层外的遮罩；再按 `Esc` | 点遮罩后弹层还在、Key 还在；`Esc` 关掉弹层 |
| 3 | 再开「添加模型」：类型选「OpenAI 兼容」，端点填 `api.deepseek.com/v1`；类型改成「本机 Claude 订阅」，填显示名与模型名，点「保存并验证」 | 发出一次 `POST /v1/channels`，`kind=agent-sdk`，请求体里没有 `endpoint` |
| 4 | `GET /v1/config`；浏览器里把它的 `secretsConfigured` 改成 `false` 后重开管理器，点「添加模型」，再把类型改成「本机 Claude 订阅」 | 接口带布尔 `secretsConfigured`；管理器顶部 `secrets-missing` 写明 `QUILT_SECRETS_KEY`；Anthropic 类型时「保存并验证」不可用，本机订阅时可用 |
| 5 | 项目切换器 →「新建项目」，项目名空着按 `Enter`；再输入 `P` | 出现「请输入项目名」（`#np-name-error`），输入框 `aria-invalid=true`、`aria-describedby=np-name-error`；输入后错误消失 |

#### `TC-CORE-049` 窄视口与输入框几何 — 对应 `PAGE-CANVAS`、`REQ-CORE-011`、`REQ-CORE-018`（v0.78）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Narrow --device mobile --screens 3 --no-shot`；这台浏览器先打开过一次画布（通道清单已在本机留底，v0.81）；小地图开着；第 1 步在页面里按帧（`requestAnimationFrame`）记输入框的左缘与宽度。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 1440×900 打开项目，从输入框出现起逐帧记 90 帧 | 每一帧的左缘与宽度都等于最后一帧（±2 px），没有从 480 px 长到终值的过程，也没有通道位空着的窄帧（从第一帧起通道触发器就在） |
| 2 | `⌥D` 打开设计系统面板 | 工具条不折行（`data-bar` 不是 `wrap`），输入框高度不变，通道触发器变窄；输入框右缘不越过面板左缘 |
| 3 | 1024×700、800×600 各打开 `?panel=screens` | 输入框宽 ≥ 280 px、上沿不高于 56 px（不压顶栏）、整块在视口内，与面板不重叠 |
| 4 | 1024×700、`?panel=screens`、小地图开着，单击 `/s1` 再 `Shift` 单击 `/s2` | 排列条的屏数与「左对齐」中心点最上层都是排列条自己 |

#### `TC-CORE-094` 一个作业内 6 个调用以内一波发完 — 对应 `REQ-CORE-003`（设计文档 `ADR-012` v1.05 修订）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name OneWave --device mobile --screens 1 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST …/jobs` 造一组屏（`count=auto`，提示词带 `[stub-hold:4000]`，stub 通道；内置桩规划出 5 屏），等作业结束；读作业事件 | 作业 `succeeded`；5 条 `screen_html_ready` 的时间最早与最晚相差 < 2.5 s（并行上限 4 时第 5 屏要等第一波，晚 4 s 以上） |

后置：删项目。

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

前置：同 `TC-CORE-010` 的项目；`pnpm seed:preview-token --screen <第 1 屏> --expired` 得到过期预览 URL；把第 1 屏截图 URL 的 `exp=` 改成过去的时间，得到过期截图 URL。
第 2、3 步用 Playwright 路由改写**页面拿到的第一次**详情回包（之后的回包照常），相当于页面手里的签名在停留期间过期。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 直接 curl 过期预览 URL | HTTP 403，`type` 为 `/errors/preview-token-invalid` |
| 2 | 打开画布，第一次详情回包里 /s1 的 `screenshotUrl` 换成过期截图 URL（v0.76；v1.02 起 `thumbUrl` 一并换掉——卡片按缩放用其中一张） | 截图 403 后页面静默重取详情（10 s 内至多一次），8 s 内 /s1 卡片换上新签名的截图（`naturalWidth > 0`）；不出现破图、不弹错误提示 |
| 3 | 重新打开，第一次详情回包里 /s1 的 `previewUrl` 换成过期预览 URL；双击 /s1 | iframe 里是 403 JSON、等不到就绪——`load` 后 2 s 页面重取详情，用新签名重载；卡片期间一直显示截图（iframe 透明），不露出 403 JSON；最终 `#toggle` 可见、角标「交互中」、iframe `src` 不再是过期那条 |
| 4 | 交互中让父页取 /s2 预览文档的请求一律失败（路由 abort），点屏里去 /s2 的链接；再改成只失败第一次、又点一次（v0.76 屏内取页） | 第一次：toast「「Screen 2」这一屏没取到，稍后再试一次」，角标仍是 /s1，页面没有未捕获异常；第二次：先重取签名再取一次，跳到 /s2（角标 /s2） |
| 5 | 另开一个装了假时钟的上下文打开同一项目，快进 4 分 30 秒（v0.76 签名续取） | 5 s 内页面静默重取一次详情（页面可见、距上次取到详情满 4 分钟） |

后置：无。

#### `TC-CORE-032` 聚焦态热更新：屏出新修订不退出交互即更新 — 对应 `REQ-CORE-005` · 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Hot --device mobile --screens 2 --form`（`--form` 让 /s1 高过一屏、可滚动）；本地起 OpenAI 兼容桩（Key `good-key-0032`，改屏提示回放种子屏 body 并把 `Follow` 改成 `热更新`），以 API 建好指向桩的通道并探测通过；视口 1440×1000、打开项目（屏内点击要在 1:1 聚焦下做，见 §3；整套顺序下前面的用例把视口留在 1440×900，聚焦缩放 0.896，脚本在这条用例开头自己设、结尾还原，v0.83）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击 /s1 进交互，把屏内滚到 150 px；记录 iframe `src` | 角标「交互中」，画布缩放 1:1（世界层 `transform` 的 `scale` = 1）；输入框已自动收起 |
| 2 | `⌘/` 叫出输入框，通道选桩，发送「改文案」 | 目标即 /s1（聚焦即选中）；作业完成后**不退出交互**，8 s 内 iframe 内 `#toggle` 文案变为「热更新」；iframe `src` 与步骤 1 相同（未重挂）；`scrollY` 仍为 150（±2）；角标仍「交互中」 |
| 3 | 等页面上在跑的作业 chip 转成完成态，点 /s1 里的 `href=/s2` 链接（导航栈 s1 → s2），再按 `⌥D` 把种子色改为 `#C2410C` 保存并「回刷所有屏」 | 回刷完成后 iframe 内正显示的 /s2 原地更新：`#toggle` 背景色等于新 primary（`<head>` 变了走整份重写）；`src` 不变；角标仍显示 /s2 |
| 4 | 按 Alt+← 回到 /s1 | /s1 也已是新色（回刷产生的新修订）且文案仍是「热更新」 |
| 5 | 按 Esc | 退出交互，卡片回截图态 |

后置：删除桩通道、关闭桩。

#### `TC-CORE-061` 屏里的脚本写不了主站 — 对应 `REQ-CORE-005`、`REQ-CORE-022`、`REQ-PROTO-004`（v0.75）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`POST /v1/projects` 建项目 `Isolation`（mobile），上传一张纯绿 SVG 素材（得到预览域 `/a/` 地址）；经 MCP `quilt.create_screen` 推一屏 `/iso`：有 Tailwind 类、`<i data-lucide="house">`、该素材图、一张 https 外链图（picsum）、左上角 60×60 的灰色探针；脚本在 `load` 之后（被 CSP 挡下的 `form.submit()` 会中止文档自己的加载，解析中途调用会让后面的图片都不再加载）① 用 `fetch` no-cors 往 `POST /v1/projects/<id>/messages`（正文带 stub 通道与 `location.origin`）和 `POST /v1/projects` 各发一次，② 用 `enctype=text/plain` 的表单 `form.submit()` 往 `…/messages` 发一次；监听 `securitypolicyviolation`，同时看到 `connect-src` 与 `form-action` 两类违规、两张图也都加载出来时把探针涂成 `#00c800`，否则 `#c80000`。
同一段脚本会在截图渲染、导出抽 CSS、对象地址、预览域 iframe 四处各执行一遍。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-061`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 等该屏截图就绪（≤ 40 s），读截图 PNG 在 (30, 30) 处的像素；查本项目消息与名为 `csrf-061` 的项目 | 截图就绪（Tailwind、图标已生效）；像素为绿（R < 40、G > 160、B < 40）；没有 `csrf-061` 开头的消息，也没有 `csrf-061` 项目 |
| 2 | 建 `export_prototype` 作业等它结束；`GET /v1/jobs/<id>/export`；MCP `quilt.get_export` | 作业 `succeeded`；下载 `200`、`Content-Disposition: attachment`、正文含 `Isolation` 与 Tailwind 产物（`--tw-`）；库里仍无写入 |
| 3 | 取该屏修订的 `htmlUrl` 与 `get_export` 给的 `url`，各 `fetch` 一次看响应头与正文，再各在浏览器里打开一次 | 响应头 `Content-Disposition: attachment; filename="<id>.html"`、`Content-Security-Policy` 含 `sandbox`、`X-Content-Type-Options: nosniff`；正文照常可取；浏览器触发下载、不渲染，下载文件名是 `<修订 id>.html` / `<作业 id>.html`；库里仍无写入 |
| 4 | `fetch` 该屏的 `previewUrl` 看 CSP；打开画布双击 `/iso` 进交互态，读 iframe 里探针的背景色 | CSP 含 `form-action 'none'`；探针 10 s 内为 `rgb(0, 200, 0)`；库里仍无写入 |

后置：`Esc` 退出交互。

#### `TC-CORE-064` 别处的写入推到已打开的画布 — 对应 `REQ-CORE-004`、`REQ-CORE-005`、`REQ-AGENT-002`（v0.77，`API-CORE-030`）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Live --device mobile --screens 3`；无头 Edge 打开 `/p/<id>`、等 3 张卡出现，页面上记录每次 `GET /v1/projects/<id>` 的状态码。
「另一个标签页」的写入用 REST 直接发。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-064`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | MCP `quilt.move_screens` 把 `/s1` 挪到 (3000, 2000) | 4 s 内卡片 `/s1` 的 `transform` 为 `translate(3000px, 2000px)`，不刷新页面 |
| 2 | MCP `quilt.delete_screen` 删 `/s3` | 4 s 内画布只剩 2 张卡 |
| 3 | MCP `quilt.update_project` 改名 `Live 2`；截图 | 4 s 内标签页标题以 `Live 2` 开头；截图里顶栏项目名是 `Live 2`、屏数是「2 屏」（`run-<RUN>-tc-core-064.png`） |
| 4 | REST `PUT …/design-system` 改种子色；MCP `quilt.create_component` 建 `Badge`；REST `PATCH /projects/{id}` 改简介 | 改设计系统与改简介后 4 s 内画布各重取一次详情；4 s 内出现 `Badge` 组件卡 |
| 5 | Node 另开一条 `GET …/events`；MCP `quilt.delete_project` | 5 s 内那条流收到含 `project_deleted` 的事件并结束；画布重取详情得到 `404` |

后置：关掉这一页（项目已删）。

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

前置：`pnpm seed:project --name Parallel --device mobile --screens 3 --no-shot`；本地起 OpenAI 兼容桩（`tests/e2e/openai-stub.ts`，端口 3994，Key `good-key-0036`，改屏提示回放种子屏 body 并编号），以 API 建好指向桩的通道并探测通过。
两个「一直在跑」的长作业用种子构造（`pnpm seed:job` 的作业不入队，worker 不碰，能稳定停在 `running`）：`seed:job --project <id>`（`kind=generate`，占项目级造屏名额）与 `seed:job --project <id> --screen <Screen 1>`（`kind=edit_screens`，占住 Screen 1）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开画布，看输入框上方 | 作业 chip 叠（`job-chips`）出现，恰好 2 枚 `job-chip`：`data-job-id` 就是那两个作业，由远及近排、最新的贴着输入框（改屏那枚建得晚，在 DOM 里排最后），文案分别写「造 1 屏」与「改「Screen 1」」并带进度——种子作业没有任何事件，这里验的正是兜底：进度位写「排队中…」而不是空着（v0.38；认领来的作业在下一个实时事件到达前都是这种状态，只剩「造 1 屏」时与卡死不可分辨），每枚各有一个取消键（`cancel-job`）；这一叠落在输入框上方 |
| 2 | 往 textarea 里键入一句，点开通道选择器选桩通道 | 输入框没有被整体锁死：`#chat-input` 不带原生 `disabled`、字打得进去；通道选择器与版数档位（`versions-1`）都不禁用（后端本就允许并行，前端不该因「有作业在跑」上锁）|
| 3 | 不给目标（= 造屏）看发送键，再按 `Enter` | 发送键 `aria-disabled=true`，其上方就地写出理由（`send-blocked-reason`）含「上一批屏还在造」；按 `Enter` 不发出 `POST …/messages`（前端就拦住，不浪费一次 409），草稿原样留着 |
| 4 | 点「Screen 1」卡片（正被改屏作业占着），再按 `Enter` | 同样拦下且点名是哪一屏：`send-blocked-reason` 含「Screen 1」；仍然不发请求、草稿留着 |
| 5 | 点「Screen 2」卡片换成空闲屏 | 放行：`send-blocked-reason` 不存在、发送键没有 `aria-disabled`（造屏 + 改另一屏、改 A + 改 B 都不冲突）|
| 6 | 填指令回车发出（目标 Screen 2），紧接着 `POST /v1/projects/<id>/messages` 对 Screen 3 发第二条 | 两条都 202；发的时候前置那两个作业仍是 `running`——四个作业同时在跑，后端一个都没拦 |
| 7 | 等这两个作业收口 | 两个都 `succeeded`，Screen 2、Screen 3 各多一条含桩标记的修订（各自落地，谁也没顶掉谁）；两个作业的运行窗口真重叠（`max(startedAt) < min(finishedAt)`，不是排队跑） |
| 8 | 点画布空白让焦点离开输入框，按一次 `Esc` | 只取消**最新**那一个（改「Screen 1」那条，它建得晚）：它转 `cancelled`、chip 消失；另一条（造 1 屏）仍 `running`、chip 还在——按一次取消一个 |
| 9 | 点剩下那枚的 `cancel-job`；再「清空」目标、键入一句 | 那个作业转 `cancelled`，`job-chips` 整叠消失；造屏名额一松，无目标发送立刻恢复：`send-blocked-reason` 不存在、发送键没有 `aria-disabled` |
| 10 | 在第 6~7 步那两个作业还在跑时，读页面里活跃的 `EventSource` 条数（用例脚本在 `addInitScript` 里包一层计数） | 恒为 **1**（只有项目事件流；作业进度走它的 `job_changed` 投影）。浏览器对同源 HTTP/1.1 只给 6 条并发连接且跨标签页共用，按作业各开一条的话三个标签页各跑一个作业就占满、普通请求全部排队 5 s 不返回 |

后置：删除用例创建的通道；桩服务关闭；前置种的两个作业已在步骤 8、9 取消（脚本收尾再兜一次）。

#### `TC-CORE-014` 回溯到任意历史版本并保留完整链 — 对应 `REQ-CORE-007` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Hist --device mobile --screens 1 --revisions 6`（seq 1..6，各版 HTML 标题含版本号）；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 选中该屏，打开修订面板 | 列出 6 个修订，倒序，当前为 seq 6；每条标出「派生自第 n 版」（修订树，`REQ-CORE-007`） |
| 2 | 点 seq 2 的「回溯到此版」并确认 | 面板新增 seq 7 并标为当前、标「派生自第 2 版」；卡片截图在 10 s 内更新为版本 2 的画面；API 返回 201，`revision.sourceKind` 为 `restore`、`parentRevisionId` 为 seq 2（v0.87：回溯修订的父修订是被回溯到的那一版） |
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

#### `TC-CORE-039` 聊天作业（只走接口）— 对应 `REQ-CORE-023`（v0.45；界面入口 v1.17 起去掉）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Chat --device mobile --screens 2 --no-shot`；本机 `claude` 已登录；账号里暂无 `agent-sdk` 通道（`pnpm seed` 已清）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/<id>/messages` 带 `mode:"chat"`、`runner:{kind:"model",driver:"gemini",…}`；再发一条不带 `runner` | 都 `400 /errors/validation`，`path=runner`，后者消息点名「本机 Claude 订阅」；随后经 `POST /v1/channels` 建 `kind=agent-sdk` 通道并 `probe` 通过 |
| 2 | `pnpm seed:job --project <id> --kind chat` 种一个在跑的 chat 作业，再发一句 `mode:"chat"` | `409 /errors/screen-busy`（一个项目一条会话，回合串行）；取消种子作业 |
| 3 | 发「这个项目现在有哪些屏？每张各是做什么的？只回答，不要改任何东西。」 | `202`，作业 `kind=chat`；≤ 7 min 内 `succeeded`；助手回执点到两屏（名字或路由），`affectedScreenIds` 为空；两屏 `currentRevisionId` 不变 |
| 4 | 发「把刚才说的第一张屏（/s1）的标题改成「Hello Chat」，其他都别动。」 | `succeeded`；/s1 出新修订 `sourceKind=agent_ingest`、`jobId` = 本作业，HTML 含 `Hello Chat`；/s2 `currentRevisionId` 不变；回执 `affectedScreenIds` 只含 /s1 |

后置：无（SDK 会话文件留在 `~/.claude/projects/` 下，不影响别的用例）。

#### `TC-CORE-062` 接口契约：目标复核、路径参数与状态码 — 对应 `REQ-CORE-006`、`REQ-CORE-012`、`REQ-CORE-025`、`REQ-CORE-026`、`REQ-EDIT-006`（v0.77）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Contract --device mobile --screens 3 --no-shot`；需要作业的请求一律显式带 `runner:{kind:"model",driver:"stub",model:"stub"}`；`FAKE` = 一个随机 UUID。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-062`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST …/messages` 带 `targetScreenIds:[FAKE]`；`POST …/jobs` 建 `edit_screens`，`screenIds:[s1, FAKE]`；前后各数一次本项目作业 | 都 `404 /errors/not-found`；作业数不变 |
| 2 | 对 `/s3` 发一轮改屏、等它结束；`DELETE /v1/screens/<s3>`；对这一轮的用户消息 `POST …/messages/<id>/retry {}` | 重试 `404 /errors/not-found`（`API-CORE-034`：目标屏已删） |
| 3 | 建组件 `Chip`，对它发一轮改组件、等它结束；另发一条 `targetComponentIds:[FAKE]` 记下 400 的 `errors[0].path`；`DELETE /v1/components/<Chip>`；重试改组件那一轮 | 重试 `400 /errors/validation`，`errors[0].path` 与发消息那条相同（`targetComponentIds`） |
| 4 | `POST …/jobs` 建 `generate`，`variantOf:FAKE`、`variantName:"空状态"` | `422 /errors/validation`；作业数不变 |
| 5 | 路径 id 用 `x` 调 14 个端点（`GET /projects/x`、`GET /projects/x/messages`、`PATCH /screens/x`、`DELETE /screens/x`、`GET /jobs/x`、`POST /jobs/x/cancel`、`POST /jobs/x/candidates/adopt`、`DELETE /components/x`、`DELETE /assets/x`、`DELETE /design-presets/x`、`DELETE /channels/x`、`POST …/messages/x/retry`、`GET /screens/<s1>/revisions/x`、`POST /screens/<s1>/revisions/x/restore`）；`GET …/messages?cursor=abc`、`GET /projects?cursor=notadate`；再用当前时间的 ISO 串当 `cursor` | 15 个全部 `404 /errors/not-found`；两处非法游标 `400 /errors/validation`；合法游标 `200` |
| 6 | `POST …/attachments` 带 `mediaType:"image/gif"`；签一张 `image/png` 后 `PUT` 空正文；建组件 `Tag`，对它的根元素 `POST /v1/components/<id>/elements/<根 qid>` 发 `remove` | 三处都 `422 /errors/validation` |
| 7 | `POST …/messages` 分别发 `{content:"", targetScreenIds:[s1]}`、`{content:"", preset:"link_repair"}`、`{content:"x", variantOf:s1, variantName:"Empty", targetScreenIds:[s2]}`（正文只在带隐藏参数时可空，参数要与动词配套，`API-CORE-010`） | 三个都 `400 /errors/validation`，`path` 依次是 `content`、`targetScreenIds`、`targetScreenIds` |

后置：无（项目随下一次 `pnpm seed` 清掉）。

#### `TC-CORE-063` 并发写入的一致性 — 对应 `REQ-CORE-015`、`REQ-EDIT-003`、`REQ-CORE-006`、`REQ-CORE-004`（v0.77，设计文档 §16 竞态表）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Race --device mobile --screens 3 --no-shot`；开跑先等 61 s，让作业限流窗口（10 次 / 分钟）清空——本条要建 8 个作业。
第 4 步要本机访问 `10.255.255.1` 挂住若干秒（截图因此拖十几秒），用同一份 HTML 的对照屏判断渲染何时结束。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-063`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 4 轮，每轮：对 `/s1` 发 `versions:2` 的改屏、等它成功、取两版候选 `c0` / `c1`（current = `c0`）；同时发 `POST …/revisions/<c0>/restore {expectedRevisionId:c0}` 与 `POST …/revisions/<c1>/adopt`（采用依次晚 0 / 10 / 20 / 30 ms） | 每轮回溯 `201` 与采用 `200` 不同时出现；回溯成功的那几轮 current 就是回溯出的修订（没被候选顶掉） |
| 2 | 3 轮，每轮读设计系统 `version = v`，用 6 种种子色并发 `PUT …/design-system {seedColor, expectedVersion:v}` | 每轮恰好 1 个 `200`、5 个 `409 /errors/version-conflict`，之后版本 `v+1` |
| 3 | 2 轮，每轮：同一个 `Idempotency-Key` 并发 3 个 `POST …/jobs {kind:"export_prototype"}`；另一个键并发 2 个 `POST …/messages`（目标 `/s2`），等它结束 | 状态只有 `202` / `200`、没有 `409`；同一组拿到的是同一个作业 id |
| 4 | MCP 在本项目建 `/stall`、在新项目 `Orphan` 建 `/stall`（都带 `<img src="http://10.255.255.1/x.png">`），本项目再建对照屏 `/control`；2 s 后确认 `/stall` 截图还没就绪，`DELETE` 这张屏与 `Orphan` 项目；等对照屏截图就绪（≤ 90 s）再等 3 s，看对象目录（§3） | 其下的 `projects/<项目>/screens/</stall 的 id>/` 与 `projects/<Orphan>/` 都不存在 |

后置：无。

#### `TC-CORE-073` 路径参数不是 UUID：预览域与 `/v1` 都回 404 — 对应 `REQ-CORE-005`、`REQ-CORE-006`（设计文档 §14 `/errors/not-found`，v0.82）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name BadIds --device mobile --screens 1 --no-shot`；取 /s1 的预览地址（签名 `t`、修订 `rev`，主机换成 `127.0.0.1`）。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-073`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 取 /s1 的预览地址 | `200`（对照） |
| 2 | 预览域：`/a/not-a-uuid/not-a-uuid`、`/a/<pid>/not-a-uuid`、`/p/<pid>/not-a-uuid?rev=…&t=…`、`/p/<pid>/<s1>?rev=not-a-uuid&t=…`、`/c/<pid>/not-a-uuid?t=…` | 全部 `404`，体含 `/errors/not-found`（修复前 `500`） |
| 3 | `/v1` 下 37 个带路径参数的端点（项目 / 作业 / 屏 / 组件 / 素材 / 预设 / 通道及其子路径，GET / POST / PUT / PATCH / DELETE），路径参数一律 `not-a-uuid` | 全部 `404` |

后置：无。

#### `TC-CORE-074` 改屏目标还没有内容时的失败原因 — 对应 `REQ-CORE-006`（`API-CORE-006` 目标屏，v0.82）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name NotYet --device mobile --screens 1 --no-shot`；建作业一律显式带 stub runner。脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-074`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST …/jobs` 建懒生成 `generate { route: "/later", prompt: "[stub-hold:15000] a later screen" }` | `202`；10 s 内 /later 已建好、`currentRevisionId` 为空 |
| 2 | 对 /later 发一轮改屏（`POST …/messages`） | `202`；作业 `failed`、`errorClass=validation`、`message=目标屏还没有生成出内容`；助手回执以「改屏失败：目标屏还没有生成出内容」开头（修复前是「目标屏都已被删除」） |
| 3 | 等第 1 步的作业结束 | 结束 |

后置：无。

#### `TC-CORE-092` 同一功能一个名字：候选与重生成这块 — 对应 `REQ-CORE-015`、`REQ-EDIT-002`（设计文档 `PAGE-CANVAS`「同一功能一个名字」，v1.04）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Names --device mobile --screens 1 --no-shot`；经 `POST …/jobs` 钉死路由 `/settings` 造 1 屏 × 2 版（stub 通道）并跑完；打开。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点选 `/settings`，`⌥R` 打开修订面板 | 候选组头「候选 · 2 版 · 待采用」；组里两行叫「候选 1」「候选 2」，不出现 seq 与作业 id |
| 2 | `⌘E` 点 `/s1` 的 `h1`；经 `POST …/jobs` 对它建 `regenerate_subtree`（提示词「[stub-hold:10000] 换成一句标语」，stub 通道），重开页面 | 检查器按钮叫「重生成这块」；作业 chip「重生成「Screen 1」的一块」 |
| 3 | 等作业结束；读消息列表（`GET …/messages`）；点选 `/s1` 打开修订面板 | 用户消息「重生成一块：[stub-hold:10000] 换成一句标语」；回执以「已重生成「Screen 1」的一块」开头；最新一条修订的来源写「重生成一块」 |

后置：删项目。

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

#### `TC-CORE-022` 设置弹层「本月用量」按驱动分列并给出 MCP 接入命令（已废弃：v1.24 用量改成看板）— 对应 `REQ-CORE-008`、`REQ-AGENT-002` · 级别: 回归 · 执行者: 皆可

已废弃，不再执行：「本月用量」换成用量看板（设计文档 v1.24），看板见 `TC-CORE-141`，MCP 命令与工具栏「设置」见 `TC-CORE-142` 第 4、5 步。以下是废弃前的步骤，留作对照。

前置：同 `TC-CORE-016`（台账里至少有一笔带驱动的记录）；打开 `Demo Mobile`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `/p/<id>?settings=usage` | 设置弹层（`settings-modal`）落在「本月用量」节：三格汇总（`usage-totals`：生成屏数 / 输入 token / 输出 token）与 `GET /v1/me/usage` 一致；按驱动分列的表（`usage-by-driver`）行数等于 `byDriver.length`；弹层里没有 `role=meter` 进度条、没有「/300」这类上限文案 |
| 2 | 切到「生成通道」一节，看底部「让本机 agent 接入 Quilt（MCP）」 | 一行可复制命令 `claude mcp add --transport http quilt http://<本机 API>/mcp`（`mcp-add`），点「复制」提示已复制 |
| 3 | 按 `Esc` 关闭弹层；看顶栏与工具栏；焦点在工具栏「设置」上按 `Enter`，再按 `Esc`（v0.97） | 关闭后焦点落在工具栏的「设置」（`data-tool=settings`，经地址打开的也一样）；顶栏没有「N 屏 · N%」；工具栏最后一个工具是「设置」；按它打开设置弹层、落在本月用量（URL `settings=usage`），`Esc` 关闭后焦点回到它 |

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
| 1 | 刷新页面 | 8 张截图卡片按之前位置显示（第 2 屏在新位置）；消息列表（`GET …/messages`）仍是 12 条（界面上没有对话记录，v1.17） |
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

#### `TC-CORE-065` 服务端通知通道断线自愈 — 对应 `REQ-CORE-005`、`REQ-AGENT-003`（`API-CORE-030` / `API-CORE-008`、设计文档 §16 一致性承诺，v0.79）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：被测 API 连外部 Postgres（§3 的 docker `quilt-pg`）；`pnpm seed:project --name Listen --device mobile --screens 1 --no-shot`；需要作业的请求显式带 `runner:{kind:"model",driver:"stub",model:"stub"}`。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-065`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 开本项目的事件流；对 `/s1` 发一轮改屏，完整读完它的作业事件流（两个频道都进了 API 的 LISTEN 表）；`docker exec quilt-pg psql` 对被测库执行 `pg_terminate_backend`，只掐 `query ilike 'listen %'` 的连接 | 掐到 ≥ 1 条；10 s 内项目流收到 `screen_changed`、`data.reason = "reconnected"`；之后被测库上又有 LISTEN 连接 |
| 2 | MCP `quilt.create_screen` 在本项目建 `/after` | 5 s 内项目流里出现它的 `screen_changed`（带新屏 id） |
| 3 | 发一轮指令里带 `[stub-hold:3000]` 的改屏，立刻开它的作业事件流 | 8 s 内收到 `screen_html_ready`（断了没重连时只能等 15 s 一次的心跳补读） |
| 4 | 对被测库执行 `pg_terminate_backend`，掐掉除自己之外的全部连接（连接池里的空闲连接也在内，v1.03） | API 进程不退：10 s 内 `GET /v1/health` 200；改项目名 `200` |

后置：无（项目随下一次 `pnpm seed` 清掉）。

#### `TC-CORE-066` 截图：未知图标名不挡截图、作业里拍失败的立即重试 — 对应 `REQ-CORE-004`、`REQ-CORE-006`（设计文档 §17 Chromium 一行与 `screenshot.render`，v0.79）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Shots --device mobile --screens 1 --no-shot`；本机 3989 端口起探针图服务、3992 端口起 OpenAI 兼容桩（§3），建一条指向桩的通道。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-066`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | MCP 建两屏，HTML 只差第二个图标：`/icon-good` 用 `data-lucide="bell"`，`/icon-odd` 用 lucide 不认识的 `home-heart-sparkle` | 40 s 内两屏的当前修订都有 `screenshotUrl`（此前带不认识图标名的屏永远拍不成，卡片一直是「截图中」骨架） |
| 2 | 开本项目事件流；用桩通道对 `/s1` 发一轮改屏，桩回一张带探针图的屏，探针第一次回 404（这次截图失败）、之后回 PNG | 作业 `succeeded`；作业结束后 30 s 内新修订有 `screenshotUrl`；探针被请求 ≥ 2 次（失败一次、重试一次）；项目流里有带该修订 id 与 `"screenshot":true` 的 `screen_changed` |

后置：删通道，关桩与探针。

#### `TC-CORE-067` 候选批有一版失败时已落的候选接管 — 对应 `REQ-CORE-015`、`REQ-CORE-006`（设计文档 §11 running→failed，v0.79）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Partial --device mobile --screens 1 --no-shot`；3991 端口起 OpenAI 兼容桩，第 2 次调用回 `400`（不可重试），其余回 `/s1` 的 body；建一条指向桩的通道。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-067`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 用桩通道对 `/s1` 发 `versions:3` 的改屏，等作业结束 | 作业 `failed`、`errorClass=provider`、`output.revisionIds` 2 条 |
| 2 | 读项目详情与 `GET /v1/jobs/<id>/candidates` | `/s1` 的 current 是已落候选里序号最小的那版（不是原版）；`pendingCandidates = { jobId: 本作业, count: 2 }`（卡片带「2 版」角标） |
| 3 | 读消息列表 | 助手消息含「已保留 1 屏」（按屏计，不是按版计） |

后置：删通道，关桩。

#### `TC-CORE-068` 进程重启的收口：中途被杀的造屏、没投出去的 agent 作业、补扫补上的截图 — 对应 `REQ-CORE-003`、`REQ-CORE-015`、`REQ-AGENT-003`、`REQ-CORE-004`（设计文档 §16 进程启动、§17 `job.claim` / `screenshot.retry`，v0.79）· 级别: 回归 · 执行者: AI

前置：设 `QUILT_E2E_RESTART`（§3，以 SIGKILL 结束被测 API 再起新进程）；`pnpm seed:project --name Restart --device mobile --screens 2 --no-shot`；3988 端口起探针图服务（先一直回 404）、3990 端口起 OpenAI 兼容桩（规划回 Cart / Checkout 两屏，Cart 的出屏立即回、Checkout 的拖 120 s），建一条指向桩的通道。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-068`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | MCP 建 `/probe`（带探针图，截图一直拍不成）；用桩通道发 `count:2`、`versions:2` 的造屏，等 Cart 两版落库 | Cart 有 2 条候选修订、current 仍空（作业还在跑）；Checkout 已规划、没有修订 |
| 2 | `pnpm seed:job --project <id> --screen <s2> --status queued --runner agent --input '{…runner:{kind:"agent",tool:"claude-code",sessionId:<不存在>}}'`；对 `/s2` 发一轮改屏 | 改屏 `409 /errors/screen-busy`（queued 的 agent 作业占着屏锁） |
| 3 | 等 `/probe` 的修订满 31 s、确认它仍无截图后探针改回 PNG；执行 `QUILT_E2E_RESTART`，旧进程一停就连本项目事件流 | 重启成功，事件流连上 |
| 4 | 读造屏作业与项目详情、`GET …/app-map` | 作业 `failed`、`errorClass=system`；Cart 的 current = 第 1 版候选、`pendingCandidates.count = 2`；Checkout 不在了；地图有 Cart → `/s1` 的边 |
| 5 | 等 agent 作业（≤ 10 s）；再对 `/s2` 发一轮改屏 | agent 作业 `failed`（会话不存在，投递时收口）；改屏 `202` |
| 6 | 等 `/probe` 的截图（≤ 30 s） | 首轮补扫补上截图；事件流里有带该修订 id 与 `"screenshot":true` 的 `screen_changed` |

后置：删通道，关桩与探针。被 SIGKILL 的旧 API 进程拉起的截图浏览器由新进程启动时结束（v0.82，`TC-CORE-071`）。

#### `TC-CORE-071` 截图浏览器：启动单飞与重启后清理 — 对应 `REQ-CORE-004`、`REQ-CORE-017`（设计文档 §16 进程启动、§17 Chromium 一行，v0.82）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：设 `QUILT_E2E_RESTART`（§3）；本机有 `ps` 与 `lsof`；`pnpm seed:project --name Browsers --device mobile --screens 4 --no-shot`。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-071`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 执行 `QUILT_E2E_RESTART`（新进程里还没有截图浏览器），就绪后立即 `POST …/jobs` 建 `apply_design_system { screenIds: "all" }`，等它结束 | `succeeded`；API 进程名下（`ppid` = 监听 API 端口的进程、命令行带 `--remote-debugging-pipe`）恰好 1 个截图浏览器（修复前 4 张截图各起一个）；记下它的 PID 与 `--user-data-dir` |
| 2 | `pnpm seed:project --name ShotSeed --device mobile --screens 1`（种子脚本自己拍截图，在同一数据目录里也记一份）；测试进程自己起一个无头 Edge（代表用户自己的浏览器） | 都起得来 |
| 3 | 再执行 `QUILT_E2E_RESTART`（SIGKILL 旧进程） | 15 s 内不再有命令行带第 1 步那个 `--user-data-dir` 的进程、该目录已删（修复前主进程与子进程都留着，`ppid` 变 1）；第 2 步的 Edge 仍连着、能执行脚本 |

后置：关掉第 2 步的 Edge。

### CORE · 画布加载与数据新鲜度

v0.76 起，执行脚本 `tests/e2e/load.ts`（`pnpm --filter @quilt/tests e2e:load`，`ONLY` / `RUN` 同其他套件；v0.83 的 `TC-CORE-075`～`078`、v0.94 的 `TC-CORE-085` 也在这一套里）。
全部走 stub：输入框发出的一轮经路由把通道改成 `{kind:"model",driver:"stub"}`（种子按 `.env` 建的缺省通道是真实 Gemini）；`TC-CORE-056` 第 2 步用 `openai-stub`（端口 3993，拖 8 s 才回）造一个跑着的作业；`TC-CORE-076` 用端口 3994 的桩（Key 不对回 401、拖 1.5 s）造一轮失败的造屏。

#### `TC-CORE-050` 组件卡首帧尺寸与首次适配 — 对应 `REQ-EDIT-006`、`REQ-CORE-004`（v0.76）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Comps --device mobile --screens 0 --no-shot`，再经 `POST /v1/projects/{id}/components` 建七个组件，各自 `PATCH` 摆开：Header Tab（`h-[60px]`）、Bottom Bar（`h-[100px]`）、Side Rail（`h-dvh w-64`）、Half Sheet（`h-[50vh]`）、Half Pane（`w-1/2 h-20`）、Long List（`max-h-[60vh] overflow-auto`，40 行）、Dock（根元素 `fixed bottom-0 inset-x-0 h-14`）——后五个按视口 / 父宽定尺寸或贴视口底，终值按设备 390×844 算：256×844、390×422、195×80、390×507、390×56；全新浏览器上下文（本机没存过这个项目的镜头与组件尺寸）；路由把组件预览文档 `/c/…` 推迟 1.5 s 回，拉长「上报之前」那一段；页面内 rAF 逐帧采样七张组件卡的宽高、iframe 是否可见、世界层 `transform`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开项目，等七张卡量到终值（宽高各差 ≤ 2 px），再等 1.2 s | 全程没有整屏高的卡：每张卡的高度从不超过 max(终值, 64)（没记过尺寸时是 64 高的紧凑占位，不是 844 高的白板）；iframe 还透明的每一帧，卡片里都是屏卡片那一套骨架（`.skeleton` 可见、`::before` 上挂着呼吸动画 `sk-breathe`；v1.08 起骨架没有扫光层）；iframe 可见的每一帧卡片都已是终值；量到终值后最后一帧仍是终值（iframe 视口恒为设备整屏，上报不会反过来缩小根元素：`h-[50vh]` 不会 422 → 211 → … → 32）；每张卡里组件根元素的左上角与卡片左上角重合（差 ≤ 2 px，按画布缩放换算），Dock 这种贴视口底的组件同样露在卡片里 |
| 2 | 读 `localStorage` 的 `quilt:view:<id>`；看采样到的世界层 `transform` | 自动适配没有写 `quilt:view`；首帧不是默认镜头 `translate(80px, 80px) scale(0.5)`，全程至多两个取值（首帧适配 + 尺寸量完后补的一次，都不带动画） |
| 3 | 按 `F` | 缩放与第 2 步最后那个自动适配的缩放差 < 0.01（自动适配按真实尺寸算） |
| 4 | 读 `quilt:comp-size:<id>`；刷新页面，重新逐帧采样 | 七个组件的框都记在本机；刷新后每张卡从第一帧起就是终值、一帧都不变，量完 1.2 s 后仍是终值；镜头一帧都不动（第 3 步按过 `F`，存下的镜头原样恢复） |

后置：无。

#### `TC-CORE-051` 适配视图装得下大项目 — 对应 `REQ-CORE-004`（v0.76）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Wide --device desktop --screens 25 --no-shot`（25 张 1280×800 桌面屏横排，约 34000 px 宽）；视口 1440×1000。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开项目，按 `F`，量每张屏卡与可用区探针（`data-testid=safe-area`）的矩形 | 25/25 张完整落在可用区里（缩放低于 0.1，下限 0.02）；没有「最小缩放也装不下」的 toast |
| 2 | 刷新 | 镜头与第 1 步一致（低于 0.1 的缩放照样被当作合法镜头恢复） |
| 3 | `pnpm seed:project --name Huge --device desktop --screens 60 --no-shot`（约 81000 px 宽，0.02 下仍比 1440 视口的可用区宽），打开后按 `F` | 缩放停在下限 0.02，toast「内容太大，最小缩放也装不下全部，用小地图或找屏（⌘K）定位」 |

后置：无。

#### `TC-CORE-052` 聚焦过渡、热更新基线与截图换图 — 对应 `REQ-CORE-005`、`REQ-CORE-004`（v0.76）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Focus52 --device mobile --screens 2`；路由拦住 /s1 的预览文档（只拦 `document` 类型，也就是聚焦时那次 iframe 导航）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 预览文档推迟 1.2 s 回；逐帧采样 /s1 卡片后双击它，等角标「交互中」 | 角标「加载中」的每一帧，卡片上都有一张解码完成、可见的截图，iframe 透明（不出现白板）；就绪后 iframe 接班、截图藏起 |
| 2 | `Esc`；把预览文档扣住再双击 /s1；趁它在加载，用 `POST /v1/screens/{s1}/elements/{toggle 的 qid}` 把文案改成「新版本」，等页面取回带新修订的详情后再放行文档 | iframe 先加载聚焦时钉住的旧版，就绪后立即热更新：`#toggle` 在 30 s 内变成「新版本」（此前停在旧版） |
| 3 | `Esc`；路由把之后详情回包里 /s2 的截图 URL 追加一个服务端不认的参数 `&roll=1`、这类对象请求推迟 800 ms；直改 /s1 触发一次项目事件与整体重取；逐帧看 /s2 卡片 | /s2 换上新地址的截图；换图期间每一帧卡片上都有一张解码完成的可见图（新图透明叠在旧图上、解码完才接班），没有空档 |

后置：无。

#### `TC-CORE-085` 退出聚焦的交接：iframe 留到这一版的截图解码完 — 对应 `REQ-CORE-005`、`REQ-CORE-004`（设计文档 `ADR-002` v0.94 修订、`PAGE-CANVAS`「退出聚焦的交接」）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Linger85 --device mobile --screens 2`（带截图）；浏览器路由把新修订的截图（地址里的 `<修订 id>.webp`）推迟 1.5 s 返回（第 3、4 步改为扣住到放行），并数 `/s1` 预览文档的请求次数。
脚本 `tests/e2e/load.ts`（`ONLY=TC-CORE-085`），失败项一条即停。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击 `/s1` 进交互态；直改 `#toggle` 的文案（`API-EDIT-001`），等 iframe 里换成新文案；逐帧记录卡片后立即按 `Esc` | 退出后 iframe 留在卡片上（≥ 30 帧、不透明、带 `inert`），这一版的截图在卡片上解码显示后才撤；退出后没有一帧既没有 iframe 也没有截图（不露「截图中」骨架）；退出前后 `/s1` 预览文档的请求数不变（没有重载）；焦点不在 iframe 上 |
| 2 | 再进 `/s1`，等 1.5 s（这一版的截图早已显示过），按 `Esc` | iframe 不留：退出后可见的 iframe ≤ 2 帧，每一帧都有截图或 iframe |
| 3 | 扣住截图；进 `/s1` 直改后按 `Esc`，再双击 `/s2` | 退出后 `/s1` 卡片上留着 iframe；`/s2` 进入交互态时 `/s1` 的 iframe 撤掉，屏卡片里只有 1 个 iframe；退出 `/s2`、放行截图后 `/s1` 换上这一版的截图 |
| 4 | 扣住截图；进 `/s1` 直改后按 `Esc`（iframe 留着），再双击 `/s1` | 照常进入「交互中」（不卡在「加载中」），iframe 里是最新文案 |

后置：放行扣住的截图。

#### `TC-CORE-053` 项目事件流断线重连 — 对应 `REQ-CORE-005`（`API-CORE-030`，v0.76）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Live --device mobile --screens 1 --no-shot`；路由接管 `/v1/projects/{id}/events`：第 1 条回 200 的空事件流（`retry: 300`，连上就断，EventSource 自己重连）；第 2~4 条回 `502 text/plain`（Vite 代理在 API 重启期间的回包，EventSource 会永久关闭）；第 5 条起放行。
记下每条事件流请求与详情、消息 GET 的时刻。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开项目 | 断开超过 3 s 时顶栏出现 `live-status`「实时更新已断开 · 重连中」 |
| 2 | 等 20 s | 第 2 条 502 之后页面按 1 / 2 / 5 s 退避自己重建连接，第 5 条连上（此前停在第 2 条、永久断开） |
| 3 | 看第 5 条之后的请求与顶栏 | 第 5 条连上后重取了一次项目详情与消息列表；断线提示撤掉 |
| 4 | 新开一页打开同一项目：路由让事件流每次回一条 `screen_changed` 就断（`retry: 300`，约 0.3 s 重连一次）、详情 GET 推迟 900 ms 回并把项目名改成「Tick <序号>」；每 100 ms 读一次标签页标题，持续 6 s | 6 s 里标签页标题至少换过 3 个「Tick …」（详情 GET 慢于 250 ms 防抖、每个回包到达时都已有更晚的请求发出，只丢早于最近已应用的回包，详情照样前进；只认最后发起的那一次时 39 次 GET 应用 0 次） |

后置：无。

#### `TC-CORE-054` 加载失败与外壳常驻 — 对应 `REQ-CORE-009`、`REQ-CORE-011`（v0.76）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Shell --device mobile --screens 2 --messages 2 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `/p/11111111-2222-4333-8444-555555555555`（不存在的项目） | 画布区（`canvas-pending`）写「这个项目不存在或已被删除」并给「回到最近的项目」；顶栏项目切换器照常在；点按钮落到另一个项目的画布 |
| 2 | 路由让该项目详情 GET 回 `502`，打开 | 画布区写「项目没加载出来」+ 原因 +「重试」；撤掉路由点「重试」→ 卡片出来 |
| 3 | 路由让 `/v1/config` 失败，刷新 | 同一个失败态；撤掉路由点「重试」→ 重取配置、卡片出来（失败的那次不被缓存） |
| 4 | 路由让 `GET /v1/projects` 失败，打开 `/` | 中文错误页「没连上 Quilt 服务」+「重试」，不是路由库的英文默认错误页；撤掉路由点「重试」→ 落到 `/p/…` |
| 5 | 详情 GET 推迟 1.5 s，打开 | 加载期间画布区是 `canvas-pending`，顶栏项目切换器、输入框、工具栏都在；随后卡片出来 |
| 6 | 路由让 `GET /v1/runners` 失败，刷新 | 输入框通道位是 `runners-failed`「通道清单没加载出来 · 重试」；撤掉路由点它 → 通道选择器（`runner-select`）出来 |
| 7 | 系统偏好浅色。新开一页打开项目，rAF 逐帧读画布底色（根元素背景，透明时取 body 的，1.5 s）；再新开一页、打开前在本机记下外观「深色」（`localStorage` 的 `quilt:theme` = `dark`），同样逐帧读 | 第一页每一帧都是浅色画布底 `rgb(234, 234, 239)`（`#EAEAEF`），第二页每一帧都是深色画布底 `rgb(10, 10, 11)`（`#0A0A0B`），不出现透明，也不先闪一帧另一套（v1.08：样式表在 `<head>` 里阻塞首帧，选过的外观由它之前的内联脚本写到 `data-theme`） |

后置：无。

#### `TC-CORE-055` 切项目不串状态 — 对应 `REQ-CORE-009`、`REQ-CORE-014`、`REQ-CORE-005`（v0.76）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Alpha --device mobile --screens 2 --messages 2` 与 `pnpm seed:project --name Bravo --device mobile --screens 3 --no-shot`；打开 Alpha，建一条 OpenAI 兼容桩通道并在输入框里选中（第 1a 步的版数档位只在模型通道下出现，v0.82）。
切项目一律经顶栏项目切换器（客户端导航）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | Alpha 里 `⌥G` 放锚点、版数选「2 版」，切到 Bravo | Bravo 里没有「新屏 · 此处」标签与锚点幽灵框，版数是「1 版」 |
| 2 | 切回 Alpha，双击 /s1 进交互（输入框自动收起），再切到 Bravo | Bravo 里输入框显示、没有聚焦的卡 |
| 3 | 切回 Alpha；路由把之后的 Alpha 详情 GET 拖 2.5 s；直改 Alpha 的 /s2，等页面因项目事件发出 Alpha 的详情 GET，趁它在途切到 Bravo，等 4 s | 画布仍是 Bravo 的 3 张卡、没有加载态、标签页标题是「Bravo · Quilt」（晚到的 Alpha 详情落在已卸载的页面上，被丢弃） |

后置：无。

#### `TC-CORE-056` 别处发起的一轮出现在本页的作业 chip 上 — 对应 `REQ-CORE-006`、`REQ-CORE-020`（v0.76）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Talk --device mobile --screens 2 --no-shot`；打开项目；起 OpenAI 兼容桩（每个回应拖 8 s），建一条指向它的「Slow 056」通道并验证通过。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 经 API 以「Slow 056」对 /s1 发一轮「别处发起的一轮」（等价于另一个标签页或 MCP 发起） | 6 s 内本页输入框上方出现这个作业的 chip（`job-chip`，`data-job-id` 就是它）：`data-state=running`，文案写「改「…」」，带取消键（`cancel-job`）；此时作业仍是 queued / running；随后取消该作业 |

后置：删除慢桩通道。

#### `TC-CORE-075` 不存在的项目：不订阅事件流、不写断线 — 对应 `REQ-CORE-009`、`REQ-CORE-005`（`API-CORE-030`，v0.83）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Doomed --device mobile --screens 1 --messages 2 --no-shot`；记下页面发出的每条 `/v1/projects/{id}/events` 请求的时刻。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `/p/22222222-3333-4444-8555-666666666666`（不存在的项目），等画布区写「这个项目不存在或已被删除」后再看 5 s | 这 5 s 里顶栏从没出现 `live-status`；转到「不存在」态之后没有再发事件流请求 |
| 2 | 新开一页打开 Doomed，卡片出来后经 `DELETE /v1/projects/{id}` 删掉它（等价于另一个标签页删），再看 5 s | 8 s 内画布区转到「这个项目不存在或已被删除」；之后 5 s 里没有 `live-status`、没有新的事件流请求 |

后置：无（项目已删）。

#### `TC-CORE-076` 作业失败写在 chip 上；窄视口 toast 让开输入框与胶囊；失败标记的点击区 — 对应 `PAGE-CANVAS`、`REQ-CORE-020`、`REQ-CORE-005`（v0.83）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Toasts --device mobile --screens 2 --no-shot` 与 `pnpm seed:project --name "Toasts Desk" --device desktop --screens 1 --no-shot`；起 OpenAI 兼容桩（端口 3994，每个回应拖 1.5 s），建通道「Stub 76」（Key 对、验证通过，输入框里选它——stub 轮次的缺省通道是本机 agent，发不出去）与「坏 Key 76」（Key 错）；输入框发出的一轮经路由改走「坏 Key 76」。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 390×844 打开 Toasts，输入框写「造一个设置页」按 `Enter`，等失败 chip；再点它的「×」（`dismiss-job`） | 不弹提示条（`toast` 为 0）；输入框上方出一枚失败 chip（`job-chip`，`data-state=failed`），写着「造屏失败」、带「重试」（`retry-job`），下沿在输入框上沿之上；点「×」后它消失 |
| 1b | `⌘/` 收起输入框；路由让 `POST …/jobs` 回 500（`title` 为「导出没发出去（测试）」），点工具栏「导出原型」 | 底边留一枚胶囊（`composer-pill`）；这条 toast 的下沿在胶囊上沿之上 |
| 1c | 1440×900 打开 Toasts，同样让「导出原型」失败 | toast 下沿与输入框上沿相距 8～24 px（toast 紧贴输入框，不被多推高） |
| 2 | 1440×1000，Toasts 的 /s1 与 Toasts Desk 那一屏各做一次：路由让这一屏的预览文档一直回 403 JSON，双击卡片，等「加载失败 · 重试」（`frame-retry`） | 两次的点击区都不小于 24×24 屏幕像素（桌面屏聚焦缩放约 0.77），中心点命中它自己 |

后置：删两条通道，关桩。

#### `TC-CORE-077` 骨架动画只在卡片可见时运行；截图取不到有出口 — 对应 `REQ-CORE-004`、`PAGE-CANVAS`（v0.83）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Shots77 --device mobile --screens 8`（带截图，/s1～/s8 横排）；镜头 `{x:100, y:100, zoom:0.6}`（/s1～/s4 整张、/s5 半张在视口里，/s6～/s8 在视口外）；`document.getAnimations()` 里目标在 `.skeleton` 内、`playState` 为 `running` 的记为「在跑的骨架动画」，按目标所在卡片与画布视口相不相交分「视口内 / 视口外」。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 路由扣住全部截图对象请求（懒加载的图一张都回不来），打开项目；再在画布中央横向滚轮平移约 1000 px | 两个时刻都是：视口内的卡有在跑的骨架动画，视口外的卡一个都没有 |
| 1b | 新上下文模拟「减少动态效果」，同样扣住截图打开 | 在跑的骨架动画 0 个（骨架仍画着） |
| 2 | 新上下文：/s1 的截图前 2 次请求中止、之后放行，/s2 的截图一直中止；打开项目 | 15 s 内 /s1 换上截图；20 s 内 /s2 停在不动的线框、卡片正中「截图没取到 · 重试」（`shot-retry`），卡里没有在跑的动画；之后 4 s 不再请求 /s2 的截图（共 ≤ 4 次） |
| 2b | 量「截图没取到 · 重试」；放行 /s2 的截图后点它 | 点击区不小于 24×24 屏幕像素、中心点命中它；10 s 内 /s2 换上截图 |
| 3 | 让之后的详情回包里 /s3 的截图地址带上 `&roll=1`，这个地址一律中止；直改 /s1 触发一次整体重取，等新地址被请求后再等 10 s | /s3 一直留着旧截图（可见、解码完成），没有「截图没取到」；新地址至多请求 4 次 |

后置：无。

#### `TC-CORE-078` 根路由以外的中文错误页与 404 — 对应 `REQ-CORE-009`、§13 导航（v0.83）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Broken --device mobile --screens 1 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `/no-such-page` | 「没有这个页面」并写明地址，不出现路由库的英文默认页（`Unexpected Application Error`、`404 Not Found`）；点「回到最近的项目」落到 `/p/…` |
| 2 | 路由让 `GET /v1/projects` 中止，打开 `/settings` | 「没连上 Quilt 服务」+「重试」，不是英文默认页；撤掉路由点「重试」→ 落到 `/p/<最近项目>?settings=usage` |
| 3 | 路由把 Broken 的详情回包里 `designSystem` 改成 `null`（画布页渲染时抛异常），打开它 | 「页面出错了」+「重新加载」，不是英文默认页；撤掉路由点「重新加载」→ 卡片出来 |

后置：无。

### CORE · 画布交互与键盘

v0.80 起，执行脚本 `tests/e2e/canvas.ts`（`pnpm --filter @quilt/tests e2e:canvas`，`ONLY` / `RUN` 同其他套件；v0.83 的 `TC-CORE-079` 也在这一套里）。
每一步各开一个新的浏览器上下文、各自登记结果（`TC-CORE-05x 第 n 步`），前一步失败不挡后一步；全程不调模型。
在跑作业用 `pnpm seed:job --project <id> --status running` 种（不入队，页面照常认领、在输入框上方出一枚作业 chip，`Esc` 取消走真实的 `POST /v1/jobs/{id}/cancel`）；视口 1440×900，镜头经 `quilt:view:<id>` 预置。

#### `TC-CORE-057` Esc 由近及远 — 对应 `REQ-CORE-004`、`REQ-CORE-020`、`REQ-EDIT-006`（v0.80）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name EscChain --device mobile --screens 3 --no-shot`；经 `POST /v1/projects/{id}/components` 建组件 `Bar` 并摆到 (0, 1000)；每一步开始前确保项目里恰好有一个 running 的种子作业（上一步取消了就再种一个），打开项目、等它的作业 chip（`job-chip`）出现，焦点放回 body；页面上监听 `POST /v1/jobs/*/cancel`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 依次按 `⌥S`、`⌥T`、`⌥D` 打开屏列表 / 本机 agent / 设计系统面板（每次等面板画出来），各按一次 `Esc` | 每一下 `Esc` 都把面板关掉（URL 去掉 `panel`，外壳 `data-panel=closed`）；全程没有取消请求 |
| 2 | `⌥D`，点进 DESIGN.md 文本框（`#ds-md`）键入「草稿 42」，按 `Esc`；再按 `Esc` | 第一下：文本框失焦，面板仍开着（`panel=design`），文本框里仍有「草稿 42」，没有取消请求；第二下：面板关上，仍没有取消请求 |
| 3 | `⌘E` 进待命态，按 `Esc`；再 `⌘E`，单击 /s1 进它的选择元素态，按 `Esc`，再按 `Esc` | 待命态一下 `Esc` 即退出模式（`panel` 去掉、`armed-hint` 消失）；聚焦时第一下只退出聚焦（`.card.focused` 为 0，`panel=inspect` 仍在），第二下才退出模式；全程没有取消请求 |
| 4 | 单击 /s2，按 `Esc`；再按 `Esc` | 第一下：画布选中清空（`.selected` 为 0），目标标签（`target-chip`）仍是 1 枚，没有取消请求；第二下（什么都没开）：发出 1 次取消请求，作业转 `cancelled` |

后置：无。

#### `TC-CORE-058` 卡片标签、选中描边与指针 — 对应 `REQ-CORE-004`、`REQ-CORE-024`、`REQ-EDIT-006`（v0.80）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Pointer --device mobile --screens 4 --no-shot`；建组件 `Header Bar`（`h-14` 页头，摆到 (0, 1000)）与 `Tab Bar`（`h-16` 三格，摆到 (470, 1000)）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 镜头 `{x:400,y:120,zoom:1}` 打开，读 /s1 卡片 `.label` 的矩形并在它中心取 `elementFromPoint`；镜头换 `{x:400,y:-760,zoom:1}` 重开，对 `Header Bar` 组件卡做同样的事 | 两处命中的都是标签本身（标签画在卡片上方、没被卡片裁掉）；组件卡标签写「Header Bar · 用于 0 屏」 |
| 2 | 镜头 `{x:200,y:60,zoom:0.6}`，指针放在 /s2 卡片中心，按住空格，按下鼠标拖 (100, 60) 分 10 步，松开鼠标与空格 | 世界层平移 (100, 60)（各差 ≤ 3 px）；/s2 卡片的 `transform` 不变；没有任何 `PATCH` 请求 |
| 3 | 镜头 `{x:600,y:300,zoom:0.1}`，`⌘A` | 4 屏都 `.selected`；每张的 `outline-width` × 缩放 在 1.5～3 px 之间（屏幕上约 2 px） |
| 4 | 镜头 `{x:420,y:20,zoom:0.5}`，`⌘E` | 待命提示（`armed-hint`）的文字色与底色按「底色合成在白底上」算对比度 ≥ 4.5:1（颜色经 1×1 canvas 读回字节，不解析 `oklab`）；文案里有「Esc」 |
| 5 | 镜头 `{x:400,y:-780,zoom:1}`，等 `Tab Bar` 量完（`data-ready`），双击它进交互态，等镜头停稳（v1.23 起镜头会摆到卡片上）；从它左下外侧空白处按下，分 20 步拖到它的 iframe 中心，再松开 | 拖到 iframe 上时选框（`marquee`）四边与「起点—指针」矩形各差 ≤ 4 px（仍跟手）；在 iframe 上松开后选框消失，`Tab Bar` 被选中 |
| 6 | 同第 5 步的镜头与交互态，指针放在 `Tab Bar` 上，按住 `Ctrl` 滚轮 5 次（每次 −40） | 画布缩放变大超过 5%（捏合转发给画布） |
| 7 | 同第 5 步的镜头与交互态，指针放在 `Tab Bar` 上，普通滚轮 4 次（每次 +60） | 世界层 `y` 减小超过 20 px（组件里没有可滚区域，滚轮平移画布） |
| 8 | 镜头 `{x:700,y:380,zoom:0.1}`，在小地图（`minimap`）视口框中心按下，分 15 步拖 (+300, +180)，逐步读 `data-view`；松开后再读 | 拖动中视口框的四边始终在 176×112 之内；松开前后 `data-view` 各值差 ≤ 0.6（松手不重新缩放、不跳） |
| 9 | 镜头 `{x:400,y:120,zoom:0.4}`，焦点放回 body，`⌘A` | 4 屏与 2 张组件卡都 `.selected` |
| 10 | 镜头同第 5 步，`Tab Bar` 进交互态；按住 `Header Bar` 卡片，分 20 步拖到 `Tab Bar` 的 iframe 中心（不松手时读卡片位置），松开后 `⌘Z` | 拖到 iframe 上时 `Header Bar` 卡片的位置与指针位移一致（各差 ≤ 4 px，拖卡片同样不在 iframe 上卡住）；`⌘Z` 撤回这次移动 |
| 11 | 镜头 `{x:400,y:120,zoom:1}`，在小地图视口框中心按下，分 5 步拖 (+10, +5) 后松开，记下镜头与 `data-view`；经 MCP `quilt.create_screen` 新建一屏（`/landed`，落在 /s4 右侧），等小地图 `data-screens` 变为 5 再读 `data-view`；按记下的镜头新开页面读 `data-view` | 新屏落地后 `data-view` 与同一镜头新开页面读到的各差 ≤ 0.6（外接框按含新屏的卡片重算，不沿用拖动时冻结的那个） |
| 12 | 同第 5 步的镜头与交互态，焦点放回 body；从同一起点按下，分 20 步拖到 `Tab Bar` 的 iframe 中心，拖到一半（第 10 小步）按下空格不放，拖到后读选框，再松开鼠标与空格 | 选框四边与「起点—指针」矩形各差 ≤ 4 px（中途按空格改写了视口的 class，拖过 iframe 仍跟手）；松开后选框消失 |
| 13 | 新开页面，镜头缩放 0.5；指针停在画布中央，按住 `Ctrl` 滚轮 `deltaY=−20` 一次，再 `deltaY=−300` 一次（v1.31） | 第一次缩放变为原来的 2^0.2 倍（约 1.149，误差 1%），第二次只放大 25%（误差 1%），指针下的世界点不动 |

后置：删掉第 11 步新建的 `/landed`（脚本在该步结束时经 `API-CORE-018` 删除；第 10 步已撤回位置）。

#### `TC-CORE-059` 键盘可达、工具栏几何与减少动态效果 — 对应 `REQ-CORE-004`、`REQ-CORE-005`（v0.80）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Keys --device mobile --screens 4 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 镜头 `{x:3000,y:2400,zoom:0.5}`（风格指南卡在视口外）打开，焦点放回 body，按 `Tab`；继续按 `Tab` 直到焦点落在「风格指南」 | 第一个停靠点是项目切换器（`project-switcher`）；8 次 `Tab` 内走到风格指南卡，它获焦后整张在视口内（镜头平移过去）、`outline` 可见（不是透明色） |
| 2 | 镜头 `{x:200,y:80,zoom:0.5}`，从 body 连按 `Tab` 到第一张屏卡；按 `→`；按空格；按 `Enter`，等角标「交互中」；在 iframe 里按 `Esc`；焦点放回 body，`⌘K` 输入 `s3` 回车，再按 `Enter` | 10 次 `Tab` 内走到屏卡，且是阅读顺序第一张 /s1；`→` 到 /s2；空格选中 /s2（只它一张 `.selected`）；`Enter` 进入 /s2 的交互，就绪后焦点在 iframe（`activeElement` 为 `IFRAME`）；`Esc` 退出后焦点回到 /s2 卡片；`⌘K` 选中 /s3 后按 `Enter` 进入 /s3 的交互 |
| 3 | 量工具栏「适配视图」「选择元素」「设计系统」「本机 agent」四个按钮的纵坐标；单击 /s1 选中，再量；点工具栏「进入交互」，再量、读同一点下的按钮；在同一坐标再点一次，再量、读指针下的按钮与焦点所在 | 四个按钮在空闲 / 选中 / 交互 / 退出后纵坐标都不变（差 ≤ 1 px）；恰好选中一屏时工具栏有「进入交互」；进入后同一点下是「退出交互」；退出后同一点下回到「进入交互」，焦点也在这一格 |
| 4 | 双击 /s1，等「交互中」，点 iframe 里的标题（焦点进 iframe），按 `⌥S`；再按 `⌥S`；双击 /s2，等「交互中」，点 iframe 里的标题，按 `⌥D` | 焦点在 iframe 里时 `⌥S` 打开屏列表（`panel=screens`），`⌥D` 打开设计系统面板（`panel=design`）——运行时转发了 ⌥ + 字母 |
| 5 | 新上下文模拟「减少动态效果」（`reducedMotion: reduce`），镜头 `{x:900,y:500,zoom:1.2}`；用 `MutationObserver` 记下世界层 `transform` 的每一次写入，按 `F`；再 `⌘K` 输入 `s4`（等列表只剩一行）回车 | 两次镜头移动都只写一次 `transform`（直接到位，没有中间值） |

后置：无。

#### `TC-CORE-079` 小地图拖完视口框之后的镜头变化不跳 — 对应 `REQ-CORE-024`（v0.83）· 级别: 回归 · 执行者: AI

前置：同 `TC-CORE-058` 的 `Pointer` 项目（4 屏 + 2 个组件卡）；镜头 `{x:400,y:120,zoom:1}`；视口框位置读小地图的 `data-view`；「框该挪多少」= 镜头的屏幕位移 × 框宽 / 画布视口宽。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 在视口框中心按下，分 6 步拖 (+24, +12) 后松开；在画布中央滚一次滚轮（`deltaY` 40，镜头平移 20 px） | 框只按镜头位移挪：各值与「松手时 + 该挪多少」差 ≤ 1 px，宽高不变（不重新缩放、不跳） |
| 2 | 拖 (+30, +16) 后松开，再连续滚 24 次（每次 `deltaY` 200） | 每一次框的位移不超过「镜头位移 × 上一次的框宽 / 视口宽 + 2 px」，框始终在 176×112 之内（贴边之后外接框随镜头连续向外扩） |
| 3 | 拖 (+24, +12) 后松开；经 `PATCH /v1/projects/{id}` 改项目名（项目事件 → 整体重取详情，卡片几何不变），等那次详情 GET 回来 | 框与松手时各值差 ≤ 0.6 |

后置：项目名改回 `Pointer`。

#### `TC-CORE-093` 输入框打字不重量工具条 — 对应 `REQ-CORE-020`（设计文档 `PAGE-CANVAS` 输入框，v1.04）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name TypeFast --device mobile --screens 1 --no-shot`；打开，等通道下拉出现；在页面里给工具条（`.composer-bar`）的 `getBoundingClientRect` 计数。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 在输入框打一个字，计数清零，再打 19 个字 | 计数为 0（第一个字让发送键的不可用说明消失，工具条内容变了，量一次属正常） |
| 2 | 点选那一屏 | 计数大于 0（屏数档位收起，内容变了要重量） |

后置：删项目。

#### `TC-CORE-097` 外观：浅色 / 深色 / 跟随系统 — 对应 `REQ-CORE-039`（设计文档 §13.1、`PAGE-CANVAS` 设置弹层「外观」，v1.08）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Theme --device mobile --screens 3`（带截图与连线）；视口 1440×900；本机没有记过外观。基准色取自 `brand/`（v1.15）：画布底浅 `#EAEAEF` / 深 `#0A0A0B`，标记色浅 `#0071E3` / 深 `#0A84FF`。脚本在 `tests/e2e/canvas.ts`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 系统偏好浅色，打开项目；从工具栏「设置」进「系统」节，在「外观」组点「深色」；按 `Esc` 关掉，单击 `/s1` | 打开时 `<html>` 没有 `data-theme`、画布底是浅色；点「深色」后当场 `data-theme="dark"`、`quilt:theme` 记为 `dark`、画布底变深，页面没有刷新；卡片底在两套下都是白 `rgb(255, 255, 255)`；选中描边是深色标记色；小地图里有深色标记色的像素（视口框，v1.15 起用标记色）；再按 `Enter` 进入 /s1 交互，连线 canvas 里有深色标记色的像素、没有浅色标记色的像素（v1.29 起连线只在交互时画） |
| 2 | 本机记为深色后刷新；`⌘E` 进选择元素，点 `/s2`，在屏里点第一个按钮或链接；再把 `data-theme` 改成 `light` | 屏内选中框的边框是深色标记色、外圈 halo 是深色 `rgb(0, 0, 0)`；改成浅色后不用重进，边框换成浅色标记色、halo 换成白 |
| 3 | 本机记为浅色，打开 `?settings=system`，把系统偏好切到深色；再点「跟随系统」，系统偏好切回浅色 | 固定浅色时系统偏好深色不影响外壳；点「跟随系统」后 `data-theme` 与 `quilt:theme` 都去掉、外壳跟着系统变深，系统切回浅色外壳跟着变浅；「跟随系统」一行写着当前是哪一套 |

后置：无。

#### `TC-CORE-124` 输入框停靠、拖动、收起成胶囊与记忆 — 对应 `REQ-CORE-004`（`PAGE-CANVAS`「停靠与收起」，v1.16）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Dock --device mobile --screens 3 --no-shot`；每一步都新开浏览器上下文（本机记录是空的）打开该项目，视口 1440×900。脚本在 `tests/e2e/canvas.ts`（`ONLY=TC-CORE-124`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 看输入框停在哪；按住它顶部那一行的空白处（收起按钮左边）拖到视口左侧中部 (60, 460) 松手；刷新 | 一开始 `data-dock=bottom`；松手后 `data-dock=left`，卡片左缘 ≤ 24 px，不压住小地图与右侧工具栏；本机 `quilt:composer:canvas` 记为 `edge=left`、`collapsed=false`；刷新后首帧仍停在左边，位置差 ≤ 2 px |
| 2 | 聚焦把手（`composer-grip`）按 `→`，再按 `↓`；点把手，在弹出的三选一（`composer-dock-menu`）里点「左边」 | `→` 后停到右边，卡片右缘在右侧工具栏左缘之内；`↓` 后回到底边；菜单选「左边」后停到左边 |
| 3 | 点输入框的「收起」（`composer-collapse`）；把胶囊拖到视口右侧 (1380, 500) 松手；点胶囊 | 输入框不可见，底边留一枚写「写一句」的胶囊（`composer-pill`，`data-dock=bottom`），本机记为 `collapsed=true`；胶囊拖过去后 `data-dock=right`；点它后输入框在右边展开、光标落回输入区 |
| 4 | 本机记为右边，视口改成 390×844 刷新；再把视口改回 1440×900、打开 `/sketch` | 窄视口只停底边，本机记录仍是 `edge=right`；草稿本的输入框按自己的记录停（`quilt:composer:sketch` 没有记录，缺省底边） |

后置：无。

#### `TC-CORE-126` 焦点在文本框里按 `⌘E` 照样开关选择元素 — 对应 `REQ-CORE-004`（`PAGE-CANVAS` 快捷键分档，v1.16）· 级别: 回归 · 执行者: AI · 源自缺陷 2026-10-20 开着选择元素点进输入框后按 ⌘E 关不掉

前置：`pnpm seed:project --name Keys --device mobile --screens 2 --no-shot`；新开浏览器上下文打开该项目，视口 1440×900。脚本在 `tests/e2e/canvas.ts`（`ONLY=TC-CORE-126`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 焦点在画布上，按 `⌘E` | 进入选择元素（画布上方出「选择元素中」提示 `armed-hint`） |
| 2 | 点进底部输入框，键入 `abc`，按 `⌘E` | 退出选择元素（`armed-hint` 消失）；输入框里仍是 `abc`，焦点仍在输入框 |
| 3 | 焦点仍在输入框里，再按 `⌘E` | 重新进入选择元素 |

后置：无。

#### `TC-CORE-127` 底边收起与展开就地换形，中线不横移 — 对应 `REQ-CORE-004`（`PAGE-CANVAS`「停靠与收起」，v1.16）· 级别: 回归 · 执行者: AI · 源自缺陷 2026-10-20 收起输入框时胶囊从输入框左缘滑到底边正中

前置：用 `TC-CORE-124` 的 Dock 项目；本机 `quilt:composer:canvas` 记为底边正中、展开（`{edge:"bottom",at:0.5,collapsed:false}`），打开该项目，视口 1440×900，量输入框的中线。脚本在 `tests/e2e/canvas.ts`（`ONLY=TC-CORE-127`）。
每一步都在页面里点下去，从下一帧起逐帧（rAF）量 320 ms。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点输入框的「收起」（`composer-collapse`），逐帧量胶囊（`composer-pill`）的中线 | 每一帧胶囊中线与输入框中线相差 ≤ 2 px：在原地变成胶囊，不从输入框左缘滑过来 |
| 2 | 点胶囊，逐帧量输入框的中线 | 每一帧输入框中线与胶囊中线相差 ≤ 2 px：在原地展开，不从胶囊处滑开 |

后置：删掉本机的 `quilt:composer:canvas` 记录。


#### `TC-CORE-139` 双击组件卡把镜头摆过去 — 对应 `REQ-EDIT-006`、`REQ-CORE-005`（`PAGE-CANVAS`「共享组件」镜头摆过去，v1.23）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name CompFocus --device mobile --screens 6 --no-shot`；经接口建组件 `Bar`（一行底栏，自然尺寸约 390×64）；视口 1440×900，打开项目，按 `F` 适配视图。
「可用区」= 可用区探针 `[data-testid=safe-area]` 的框（画布视口让开顶栏、输入框与两侧工具栏后的区域，镜头居中以它为准）；「卡片」= `[data-testid=component-card][data-name=Bar]` 在页面上的框。
脚本 `tests/e2e/canvas.ts`（`ONLY=TC-CORE-139`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 记下卡片的框；双击卡片，等 400 ms | 卡片进交互态（`live-dot` 出现）；卡片中心与可用区中心相差 ≤ 24 px；卡片宽等于它的自然宽（装得下时 1:1），比双击前大 |
| 2 | 按 `Esc` | 退出交互态；卡片的框与第 1 步结束时相差 ≤ 1 px（镜头留在那儿） |
| 3 | 把镜头缩到 0.3、把卡片平移到可用区右下角，再双击卡片 | 同第 1 步：卡片回到可用区正中、按 1:1 显示 |

后置：无。

### CORE · 安装与运行

#### `TC-CORE-031` 一键安装冷启动 — 对应 `REQ-CORE-017` · 级别: 冒烟 · 执行者: AI

前置：`pnpm --filter @quilt/web build && pnpm --filter quilt-canvas build`；`npm pack` 得到 `quilt-canvas-<ver>.tgz`；一个空的临时目录作为 `--home`；端口 3410 / 3411 空闲。
脚本 `tests/e2e/install.ts` 全自动执行，全程不碰仓库 `.data` 与 `~/.quilt`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `npm install <tgz>` 到临时 prefix | 装出 `node_modules/.bin/quilt`；依赖里是 `playwright-core`（安装时不下载浏览器） |
| 2 | `quilt --home <空目录> --port 3410 --preview-port 3411 --no-open` | 120 s 内 `GET /v1/health` 200；`<home>/config.env` 生成且含随机 `QUILT_SECRETS_KEY` 与 `PREVIEW_SIGNING_SECRET`；`<home>/db` 存在（PGlite）；`<home>` 权限 700、`config.env` 600（v1.03） |
| 3 | `GET /`、`GET /assets/*.js`、`GET /p/不存在` | 主页是打包的前端（含 `<div id="root">` 与 `/assets/*.js`）；静态资源 `Content-Type` 为 JavaScript；SPA 路径回退到 `index.html` |
| 4 | `GET /v1/config`；`GET http://127.0.0.1:3411/healthz`；`POST /mcp` initialize | `local=true`、`previewOrigin=http://127.0.0.1:3411`、`home` 等于临时目录；预览域 200；MCP 免鉴权返回 200 |
| 5 | `POST /v1/projects` 建项目（带画布 origin `http://localhost:3410` 作 `Origin`）；再带 `Host: rebind.attacker.example:3410` 调 `GET /v1/projects`（v0.75） | 201；`<home>/db` 非空；伪造 `Host` 的请求 403 |
| 6 | 杀掉进程，把 `<home>` 改成 755、`config.env` 改成 644（老版本落盘的样子），再以同样参数启动 | 二次启动就绪且日志无「首次运行」；`GET /v1/projects` 仍含步骤 5 的项目；权限补回 700 / 600 |

后置：停进程、删临时目录。

#### `TC-CORE-060` 只受理本机来源的请求 — 对应 `REQ-CORE-017`、`REQ-AGENT-002`（`ADR-016` v0.75）· 级别: 回归 · 执行者: AI

前置：API 已起（任一形态），记下 API 端口 `<P>` 与画布 origin（跑脚本时即 `QUILT_E2E_WEB`）。脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-060`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 带 `Host: rebind.attacker.example:<P>` 调 `GET /v1/projects`、`GET /v1/channels`、`POST /mcp`（`tools/call quilt.list_projects`） | 三个都 `403`，`type` 为 `/errors/forbidden`，响应里没有项目与通道 |
| 2 | `POST /v1/projects`（`Content-Type: text/plain`），`Origin` 分别为 `http://evil.example` 与 `null`；再以 `Origin: http://evil.example` 调 `POST /mcp` | 全部 `403 /errors/forbidden`；项目列表里没有 `csrf-060` |
| 3 | `POST /v1/projects` 带画布 origin 作 `Origin`、再带 `http://127.0.0.1:<P>`；不带 `Origin`、以 `Host: 127.0.0.1:<P>` 调 `GET /v1/projects`；MCP 客户端（不带 `Origin`）调 `quilt.list_projects` | `201` / `201` / `200`；MCP 正常返回并列出刚建的 `legit-060` |
| 4 | 无头 Edge 以 `--host-resolver-rules=MAP rebind.test 127.0.0.1` 启动（DNS 重绑之后的状态），打开 `http://rebind.test:<P>/`，页内 `fetch('/v1/projects')` 与 `fetch('/mcp', POST)`；再从该页提交一个 `enctype=text/plain` 的表单到 `http://localhost:<P>/v1/projects` | 两个同源 fetch 都 `403`；表单导航的响应 `403`；项目列表里仍没有 `csrf-060` |

后置：无（项目随下一次 `pnpm seed` 清掉）。

#### `TC-CORE-070` 从 `127.0.0.1` 打开画布：交互态与屏内跳转 — 对应 `REQ-CORE-005`、`REQ-PROTO-001`、`REQ-CORE-017`（设计文档 §15 安全「预览域」，v0.82）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Loopback --device mobile --screens 3`；画布地址的端口记作 `<P>`（打包形态即 API 端口），`WEB_ORIGIN=http://localhost:<P>`。
脚本 `tests/e2e/core.ts`（`ONLY=TC-CORE-070`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 带 `Origin: http://127.0.0.1:<P>` 取 /s1 的预览地址（主机换成 `127.0.0.1`）；再带 `Origin: http://evil.example` 取一次 | `200`；CSP 的 `frame-ancestors` 含 `http://localhost:<P>`、`http://127.0.0.1:<P>`、`http://[::1]:<P>`；第一次的 `Access-Control-Allow-Origin` = `http://127.0.0.1:<P>`，名单外的 Origin 不被回显 |
| 2 | 无头 Edge 打开 `http://127.0.0.1:<P>/p/<id>`，双击 /s1 | 角标「交互中」；10 s 内 iframe 里的 `h1` 是 Screen 1（修复前 `frame-ancestors` 只有 `WEB_ORIGIN`，iframe 被拦） |
| 3 | 在画布空白处滚一下露出「Go to /s2」，点它 | 角标变 /s2，iframe 里的 `h1` 是 Screen 2（父页跨源取目标屏 HTML 成功）；按 `Esc` 退出 |

后置：无。

### CORE · 草稿本

#### `TC-CORE-098` 取回草稿本：第一次建、同时取只建一个、删了再建 — 对应 `REQ-CORE-040`（`API-CORE-046`、§16「两个标签页同时第一次打开草稿本」，v1.13）· 级别: 回归 · 执行者: AI

前置：§3 的隔离测试栈（`LLM_DRIVER=stub`）；本机 docker 里有 `quilt-pg`（脚本用 `docker exec quilt-pg psql` 数被测库里 `kind='sketchbook'` 的行）；先 `GET /v1/sketchbook` 再 `DELETE /v1/projects/<它>`，库里没有草稿本（行数 0）。
脚本 `tests/e2e/sketch.ts`（`ONLY=TC-CORE-098`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 同时发出 5 个 `GET /v1/sketchbook`；再数行 | 5 个都 `200`、`projectId` 相同，`Cache-Control` 含 `no-store`；行数 1 |
| 2 | `GET /v1/projects/<projectId>` | `project.kind=sketchbook`、`name=草稿本`、`deviceType=mobile`，`screens` 为空 |
| 3 | 再 `GET /v1/sketchbook`；MCP `quilt.get_sketchbook {}` | 两处都返回同一个 `projectId` |
| 4 | `DELETE /v1/projects/<projectId>`，再 `GET /v1/sketchbook`，再数行 | 删除 `204`；新的 `projectId` 与旧的不同、`screens` 为空；行数 1 |

后置：无。

#### `TC-CORE-099` 第一次打开草稿本；草稿本不进项目列表与入口落点 — 对应 `REQ-CORE-040`（`PAGE-SKETCH`、`API-CORE-005`，v1.13）· 级别: 回归 · 执行者: AI

前置：`pnpm seed`（只有 `Demo Mobile`、`Demo Desktop` 两个项目，从没打开过草稿本）；视口 1440×900。
脚本同上（`ONLY=TC-CORE-099`，套件里排第一条）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `Demo Mobile` 的画布，点左上角项目切换器，再点菜单里的「草稿本」 | 「草稿本」（`sketchbook-entry`）在项目列表之上；点后地址变为 `/sketch`、没有 `d`，标签页标题「草稿本 · Quilt」，看板 `data-state=empty`、有空看板提示（`sketch-empty`），记录栏没有项 |
| 2 | `GET /v1/projects` | 仍只有那 2 个项目，`kind` 都是 `app` |
| 3 | 经 API 在草稿本里出一张草稿（stub，`[stub-frame:component]`），草稿本成了最近更新的项目；再 `GET /v1/projects`，再调 MCP `quilt.list_projects` | 两处都只列那 2 个，没有草稿本的 id |
| 4 | 打开 `/` | 落到 `/p/<Demo Mobile 或 Demo Desktop 的 id>`，不落到草稿本 |
| 5 | 打开 `/p/<草稿本 id>` | 重定向到 `/sketch` |
| 6 | 在草稿本页点切换器 chip，选「Demo Desktop」 | chip 写「草稿本」；菜单列 2 个项目与「新建项目…」；选后地址变为 `/p/<Demo Desktop 的 id>` |

后置：无。

#### `TC-CORE-100` 出一张组件草稿、改一轮、回到旧版 — 对应 `REQ-CORE-040`（`PAGE-SKETCH`、`API-CORE-015`，v1.13）· 级别: 回归 · 执行者: AI

前置：§3 的桩通道「草稿桩」已建并验证；打开 `/sketch`（看板为空），输入框通道选「草稿桩」；本机没记过画框选择。
「草稿桩」对含「迷你控制条」的一句回播放器控制条（根元素 `data-frame="component"`、宽 360 px、歌名「夜航星」），对含「圆形」的一句回第二版（按钮变圆、多一条 `aria-label="音量"` 的滑块）。
脚本同上（`ONLY=TC-CORE-100`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 看动词行与画框选择；输入「一个音乐播放器的迷你控制条，深色毛玻璃」，点发送 | 发送前动词行写「新草稿」、画框选择是「自动」；发送后看板先是 `data-state=generating`（骨架），作业完成后变 `draft`，地址的 `d` 是新草稿的 id |
| 2 | 量看板上的草稿 | `draft-view` 的 `data-frame=component`；iframe 的宽高等于草稿根元素的宽高（宽 360 px）四周各加 64 px 的透明边，中心与看板中心相差不超过 2 px；记录栏多出这一项；动词行写「改「<草稿名>」」，画框选择收起 |
| 3 | 输入「按钮换成圆形，加一个音量滑块」，发送，等作业完成 | 这张草稿的修订数为 2；看板里的草稿换成有音量滑块的新版 |
| 4 | 点「版本」，在弹层里对第 1 版点「回到这一版」 | 弹层列 2 版；之后修订数为 3，最新一版 `sourceKind=restore`、正文与第 1 版相同；看板里没有音量滑块、写着「夜航星」 |

后置：无。

#### `TC-CORE-101` 收起后接着出下一张手机页，再重开 — 对应 `REQ-CORE-040`（`PAGE-SKETCH`「收起」与「记录栏」，v1.13）· 级别: 回归 · 执行者: AI

前置：「草稿桩」已建并验证（对含「记账」的一句回记账首页，根元素 `data-frame="mobile"`；句中带「慢」时拖 6 s 再回）；经 API 用「草稿桩」出草稿 A（「一个音乐播放器的迷你控制条」）；打开 `/sketch?d=<A>`，输入框通道选「草稿桩」。
脚本同上（`ONLY=TC-CORE-101`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 在输入框里写「随手写的字」，按 `Esc`；再按一次 `Esc` | 第一下只清掉字，看板仍是 A；第二下看板清空（`data-state=empty`），地址没有 `d`，A 留在记录栏，焦点在输入框 |
| 2 | 画框选「手机页」，发送「一个记账 App 的首页」，等作业完成 | 新草稿 B 摆上看板，`data-frame=mobile`，iframe 里的视口是 390×844；记录栏里 B 排在 A 之前 |
| 3 | 发送「把预算卡片挪到最上面，慢慢来」，随即按 `Esc` | 看板清空；记录栏里 B 带 `data-generating="true"`；作业照常完成，之后 B 不再标生成中、修订数为 2 |
| 4 | 点记录栏里的 A | A 回到看板，地址的 `d` 是 A |

后置：无。

#### `TC-CORE-102` 草稿本只受理单屏单版的造与改 — 对应 `REQ-CORE-040`（`API-CORE-010` 草稿本规则、`API-CORE-006`、MCP `quilt.generate_screens`，v1.13）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：草稿本里有两张有内容的草稿 A、B（stub，`[stub-frame:component]`）；记下草稿本的作业数与消息数。
下文的请求都带 `runner:{kind:"model",driver:"stub",model:"stub"}`。
脚本同上（`ONLY=TC-CORE-102`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 对草稿本 `POST messages`，逐个带：`count:3`、`versions:2`、`mode:"chat"`、`targetComponentIds:[<任意 id>]`、`anchor`、`variantOf:A` 加 `variantName`、`route:"/x"`、`preset:"link_repair"` 加 `targetScreenIds:[A]`、`targetScreenIds:[A,B]` | 9 次都是 `400 /errors/validation`，`errors` 里点名对应字段；作业数与消息数都没变 |
| 2 | 对 `Demo Mobile` `POST messages` 带 `frame:"component"` | `400 /errors/validation`，点名 `frame` |
| 3 | 对草稿本 `POST jobs {kind:"generate", input:{count:2}}`；MCP `quilt.generate_screens` 带 `versions:2` | 前者 `400 /errors/validation`，后者返回错误 `/errors/validation`；作业数没变 |
| 4 | 发新草稿：第一行「一二三四五六七八九十一二三四五六七八九十多出来的字」，第二行 `[stub-frame:component]`；等作业完成 | 作业 `generate`，屏数与版数都是 1；草稿本恰好多 1 屏，名字是第一行的前 20 个字，路由形如 `/draft-<n>`；它只有 1 版，`sourceKind=generate`，`lintReport` 没有违规 |
| 5 | 对这张草稿发「标题加粗」，第二行 `[stub-patch-miss]`（补丁对不上，退回整张重写）；等作业完成 | 作业 `edit_screens`、版数 1；草稿恰好 2 版，最新一版属于这个作业 |

后置：无。

#### `TC-CORE-103` 画框：自动由模型声明、选定直接写、改画框只对草稿有效并重拍截图、组件与页面不互换 — 对应 `REQ-CORE-040`（`API-CORE-010` 草稿本规则、`API-CORE-012`、`PAGE-SKETCH`「草稿工具条」，v1.13、v1.17）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：「草稿桩」已建并验证（对带 `[size:320x96]` 的一句回一个 320×96、根上没写 `data-frame` 的色块）；`pnpm seed:project --name FrameApp --device mobile --screens 1 --no-shot`。
截图尺寸读 PNG 头。
脚本同上（`ONLY=TC-CORE-103`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 发新草稿「一个天气 App 的首页」，第二行 `[stub-frame:mobile]`，`frame:"auto"`（stub）；等截图 | 草稿 `frame=mobile`；截图 780×1688（390×844、DPR 2，只拍首屏） |
| 2 | 用「草稿桩」发新草稿「一个色块」，第二行 `[size:320x96]`（缺省 `auto`）；等截图 | 草稿 `frame=component`（根元素没写 `data-frame` 按组件）；截图 896×448（根元素的框连同四周各 64 px 的透明边，DPR 2，误差 2 px 内） |
| 3 | MCP `quilt.generate_screens`：提示「一个产品官网首页」加第二行 `[stub-hold:4000]`、`frame:"desktop"`（stub）；作业在跑时取草稿本详情；等作业完成与截图 | 在跑时新草稿已在详情里，`frame=desktop`、还没有当前修订；完成后截图 2560×1600 |
| 4 | `PATCH /v1/screens/<第 1 步的草稿> {frame:"desktop"}`；等截图 | `200`，返回的 `screen.frame=desktop`；修订数与当前修订都没变；30 s 内截图变成 2560×1600，截图地址从 `….mobile.webp` 换成 `….desktop.webp` |
| 5 | `PATCH /v1/screens/<FrameApp 的屏> {frame:"mobile"}` | `422 /errors/validation`；这屏的 `frame` 仍为 `null` |
| 6 | `PATCH` 第 1 步的草稿 `{frame:"component"}`；`PATCH` 第 2 步的草稿 `{frame:"mobile"}`；再 `PATCH` 第 1 步的草稿 `{frame:"mobile"}` | 前两个都 `422 /errors/validation`、`path=frame`，两张草稿的 `frame` 仍是 `desktop` 与 `component`；第三个 `200`，`frame=mobile` |
| 7 | 打开 `/sketch?d=<第 1 步的草稿>` 看工具条的画框控件（`draft-frame`）；再打开第 2 步的草稿 | 页面草稿的控件只有「手机页」「桌面页」两项，停在「手机页」；组件草稿的工具条上没有这个控件 |

后置：无。

#### `TC-CORE-104` 草稿作业的冲突、取消、失败与已删 — 对应 `REQ-CORE-040`（§16 草稿本竞态、`API-CORE-009`、`API-CORE-015`、`API-CORE-018`，v1.13）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：「草稿桩」已建并验证（句中带 `[fail]` 时回 400：不重试的供应商错误）。
脚本同上（`ONLY=TC-CORE-104`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 发新草稿「一张慢慢出来的卡片」，第二行 `[stub-hold:6000]`；随即再发一张新草稿；等第一张的屏行出现后 `DELETE` 它 | 第一张 `202`；第二张 `409 /errors/screen-busy`；删除 `409 /errors/screen-busy` |
| 2 | 取消第一张的作业 | `200`，作业 `cancelled`；15 s 内那张没有内容的草稿从详情里消失 |
| 3 | 用「草稿桩」发新草稿「一张会失败的卡片 [fail]」 | 作业 `failed`、`errorClass=provider`；草稿本的屏数不变，每张都有当前修订 |
| 4 | 出一张草稿 A，记下第 1 版；对 A 发「标题改大」加第二行 `[stub-hold:5000]`；在跑时再对 A 发一句，再 `POST restore` 第 1 版（`expectedRevisionId` = 第 1 版）；作业完成后再发一次同样的 restore | 改 `202`；再改 `409 /errors/screen-busy`；在跑时回到旧版 `409 /errors/screen-busy`；完成后同样的 restore `409 /errors/revision-conflict`（版本已过期） |
| 5 | `DELETE` A，再对 A 发一句 | 删除 `204`；改 `404 /errors/not-found` |

后置：无。

#### `TC-CORE-105` 发送被挡：上一张还在生成、这一张还在改 — 对应 `REQ-CORE-040`、`REQ-CORE-020`（`PAGE-SKETCH` 输入框，v1.13）· 级别: 回归 · 执行者: AI

前置：「草稿桩」已建并验证（句中带「慢」时拖 6 s）；经 API 用「草稿桩」出草稿 A；打开 `/sketch`（看板为空），输入框通道选「草稿桩」。
脚本同上（`ONLY=TC-CORE-105`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 发送「一张慢慢出来的卡片」，看板进入生成中后按 `Esc`；写「再来一张」，点发送、再按 `Enter` | 收起后动词行写「新草稿」；发送键禁用，两次都没有发出 `POST messages`，字留在输入框；输入框上方写「上一张草稿还在生成…」 |
| 2 | 等那张出来；点记录栏里的 A，发送「标题改小一点，慢慢改」；在跑时写「再改一句」，点发送、再按 `Enter` | 同样被挡、没有请求、字留着；原因写「「<A 的名字>」正在改…」 |

后置：无。

#### `TC-CORE-106` 看板摆放：放不下等比缩小、不抢看板、删掉与已删的草稿 — 对应 `REQ-CORE-040`（`PAGE-SKETCH`、`API-CORE-018`、`API-CORE-010`，v1.13）· 级别: 回归 · 执行者: AI

前置：「草稿桩」已建并验证（对含「官网」的一句回桌面页，根元素 `data-frame="desktop"`）；视口 1440×900，第 1 步改在 1280×800 下做、做完改回（v1.17 起记录栏浮在看板上，1440×900 的看板放得下整张 1280×800 的桌面页）；打开 `/sketch`（看板为空），输入框通道选「草稿桩」。
脚本同上（`ONLY=TC-CORE-106`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 画框选「桌面页」，发送「一个产品官网首页」，等作业完成 | iframe 里的视口是 1280×800；看板上的草稿宽度小于 1280、宽高比 1.6（误差 0.02），整张落在看板之内 |
| 2 | 点「收起」，发送「又一张慢慢出来的卡片」；它还在生成时点记录栏里的桌面页 D；等新草稿 N 生成完再等 1.5 s | 记录栏里 N 标生成中；点 D 后看板是 D；N 完成后看板仍是 D，N 在记录栏里 |
| 3 | 在 D 上点删除，在确认框里点「删除」 | 看板清空；记录栏与草稿本详情里都没有 D |
| 4 | 拦掉本页的项目事件流后打开 N；经 API 删掉 N；在输入框写「标题换个颜色」，发送 | 发送返回 `404`；看板清空，提示「这张草稿已被删除」 |
| 5 | 打开 `/sketch?d=<N>` | 看板为空，提示「这张草稿已被删除」 |

后置：放开事件流。

#### `TC-CORE-107` 把草稿放进项目：落成屏并按设计系统改写 — 对应 `REQ-CORE-041`（`API-CORE-047`、`ADR-031`，v1.13）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：草稿本里有草稿 A（stub，「一个音乐播放器的迷你控制条」加第二行 `[stub-frame:component]`），记下它当前版的正文与修订数；`pnpm seed:project --name CopyTarget --device mobile --screens 3 --no-shot`（项目 P），记下 P 最右一屏的 `x` 与 P 的消息数。
正文比较时去掉 `data-qid`、合并空白。
脚本同上（`ONLY=TC-CORE-107`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/sketchbook/drafts/<A>/copy {projectId:P, as:"screen", name:"Player Bar", restyle:true, runner:stub}` | `201`，带 `screen` 与 `job`；P 有 4 屏；新屏路由 `/player-bar`、`x` 大于原最右一屏、`frame=null`；它只有 1 版，`sourceKind=sketch`，正文与 A 的当前版相同；`job` 是 `edit_screens`，`screenIds=[新屏]`，提示词是 `RESTYLE_PROMPT` |
| 2 | 等改写作业结束；取 P 的消息 | 作业 `succeeded`；新屏有 2 版，最新一版属于这个作业；P 的消息数没变，没有一条挂着这个作业 |
| 3 | 读新屏两版的 HTML；取 A 的修订 | 两版里都没有草稿本或 A 的 id；A 的修订数没变 |
| 4 | 对 A 发「按钮换成圆形」，等作业完成 | P 里那屏的当前修订没变 |
| 5 | 同一个名字、`restyle:false` 再放一次 | `201`，只带 `screen`，路由以 `/player-bar` 开头且不等于 `/player-bar`；P 的作业数没变 |
| 6 | MCP `quilt.copy_draft {screenId:A, projectId:P, as:"screen", restyle:false}`（不给名字） | 返回的 `screen.name` 等于 A 的名字 |

后置：无。

#### `TC-CORE-108` 把草稿放进项目：落成组件、带脚本拒绝、名字冲突、目标不对 — 对应 `REQ-CORE-041`（`API-CORE-047`，v1.13）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name CopyComponents --device mobile --screens 1 --no-shot`（项目 P）。
组件 HTML 与草稿正文比较时去掉 `data-qid`、`data-frame`、`data-component`，合并空白。
脚本同上（`ONLY=TC-CORE-108`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 出草稿 C（「一个迷你播放器组件」加第二行 `[stub-frame:component]`）；`copy {projectId:P, as:"component", name:"MiniPlayer", restyle:false}` | `201`，只带 `component`；组件 HTML 与 C 的当前版正文相同，不含草稿本或 C 的 id |
| 2 | `copy {as:"component", name:"MiniPlayerStyled", restyle:true, runner:stub}`，等作业结束 | `201`，`job.kind=edit_component`、提示词是 `RESTYLE_PROMPT`；作业 `succeeded`，组件版本加 1 |
| 3 | 再以 `MiniPlayer` 放一次 | `409 /errors/component-name-taken`；P 的组件数没变 |
| 4 | 出草稿 S（「一个会动的计数器」加第二行 `[stub-script]`）；`copy {as:"component", name:"Counter"}`；再 `copy {as:"screen", name:"Counter", restyle:false}` | S 的正文里有 `<script>`；落成组件 `400 /errors/validation`，响应写「草稿里有脚本或样式表，组件放不下，放成屏」，组件数没变；落成屏 `201` |
| 5 | 目标是草稿本自己、目标项目不存在、`screenId` 是 P 的屏，各 `copy` 一次 | 都是 `404 /errors/not-found` |
| 6 | 发新草稿「一张还没出来的卡片」加第二行 `[stub-hold:5000]`，屏行出现后对它 `copy`；之后取消作业 | `400 /errors/validation`（草稿还没有内容） |

后置：无。

#### `TC-CORE-109` 「写回项目…」弹层：放成新屏 — 对应 `REQ-CORE-041`（`PAGE-SKETCH`「写回项目…」弹层，v1.13，v1.14 改名）· 级别: 回归 · 执行者: AI

前置：「草稿桩」已建并验证；`pnpm seed:project --name CopyDesk --device desktop --screens 1 --no-shot`（项目 P），先打开一次 P 的画布（成为上次打开的项目）；经 API 用「草稿桩」出手机页草稿 M（「一个记账 App 的首页」，`frame:"mobile"`）；打开 `/sketch?d=<M>`，输入框通道选「草稿桩」。
脚本同上（`ONLY=TC-CORE-109`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点「写回项目…」 | 弹层（`copy-dialog`）出现：目标项目缺省是 CopyDesk；方式是「新屏」（`copy-as` 的 `data-value=screen`）；名字缺省是 M 的名字；「按该项目的设计系统改写」已勾选，写着「1 次模型调用」；提示里写着「手机页」与「桌面」（画框与项目设备形态对不上） |
| 2 | 点提交 | 请求体 `projectId=P`、`as=screen`、`restyle=true`，`runner` 是「草稿桩」；提示条「已写回「CopyDesk」」 |
| 3 | 点提示条上的「去看看」 | 地址变为 `/p/<P>`，画布上有 2 张屏 |

后置：等改写作业结束。

#### `TC-CORE-110` 交给本机会话出草稿、改草稿 — 对应 `REQ-CORE-040`、`REQ-AGENT-003`（`API-CORE-010` 草稿本规则、`API-CORE-030`，v1.13）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：同 `TC-AGENT-009` 的假会话环境（API 与脚本以同一个 `QUILT_CLAUDE_SESSIONS_DIR` 运行，本机 `claude` 可用；未满足时登记「跳过」）；起一个假会话「Stub 草稿」。
指令都带 `HANG`：假会话收到后不动，脚本以会话身份经 MCP 回写。
脚本同上（`ONLY=TC-CORE-110`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 交给假会话发新草稿「HANG 一张天气卡片」（`runner:{kind:"agent", tool:"claude-code", sessionId}`） | `202`，作业 `generate`、`runner=agent`；假会话收到的提示词带本作业的 `(job <id>)`、`quilt.create_screen`、草稿本的 `projectId`、「route 可省」、`data-frame`，写明不调 `quilt.get_design_contract`，没有 `Target screens` |
| 2 | 以会话身份 `quilt.create_screen {projectId:草稿本, name:"天气卡片", html:<根上 data-frame="mobile"、写死色值>, jobId}`（不带 route）；带同一 `jobId` 再 `create_screen` 一张；再 `quilt.finish_job` | 草稿路由形如 `/draft-<n>`、`frame=mobile`；修订属于本作业，`lintReport` 没有违规；第二次 `create_screen` 报 `/errors/validation`，草稿本的屏数不变（`INV-CORE-003`）；作业 `succeeded`，`output.screenIds=[这张草稿]` |
| 3 | 交给假会话改这张草稿「HANG 加一行湿度」；以会话身份 `quilt.patch_screen`（带 `expectedRevisionId` 与 `jobId`），再 `finish_job` | 作业 `edit_screens`；提示词带 `screenId=<草稿> expectedRevisionId=<当前修订>`、`quilt.patch_screen`、`quilt.update_screen` 与本作业的 id；收口后草稿有 2 版 |
| 4 | 打开 `/sketch`（看板为空），输入框通道选「交给本机 Claude Code」、不选会话，写「HANG 一个登录表单」，点发送、再按 `Enter` | 发送键禁用，两次都没有请求，原因里写着「会话」 |
| 5 | 会话下拉选「Stub 草稿」，发送；以会话身份带这个作业的 `jobId` `quilt.create_screen` 一张草稿 | 15 s 内这张草稿摆上看板（`draft-view` 的 `data-draft-id` 是它） |

后置：收口第 5 步的作业；输入框通道换回「草稿桩」；关假会话。

#### `TC-CORE-111` 草稿本出稿走查 — 对应 `REQ-CORE-040` · 级别: 回归 · 执行者: AI

前置：§3 的隔离测试栈；复位 `pnpm seed`（对测试库），之后建「草稿桩」并验证。
脚本同上（`ONLY=TC-CORE-111`）；截图按截图键存成 `docs/test-runs/run-<轮次>-flow-sketch/<Sn>.png`，热点（选择器与视口坐标）写同目录的 `hotspots.json`。
拍法：无头 Edge，视口 1440×900、DPR 1；浅色（`colorScheme: light`，`localStorage['quilt:theme']=light`）；没有新手引导；展示种子：`pnpm seed` 加「草稿桩」的固定回复（播放器控制条两版，见 `tests/e2e/sketch.ts`）；每张图等页内图片加载完、草稿 iframe 的字体加载完，再等 0.6 s 拍；不滚动。

| # | 操作 | 预期 | 截图键 |
| --- | --- | --- | --- |
| 1 | 打开 `Demo Mobile` 的画布，点项目切换器，点菜单里的「草稿本」 | 菜单顶部有「草稿本」；点后进入 `/sketch` | FLOW-SKETCH/S1 |
| 2 | 等草稿本页打开 | 看板为空、有空看板提示，记录栏为空 | FLOW-SKETCH/S2 |
| 3 | 画框保持「自动」，输入「一个音乐播放器的迷你控制条，深色毛玻璃」，点发送 | 动词行写「新草稿」；发送后看板进入生成中 | FLOW-SKETCH/S3 |
| 4 | 等作业完成 | 播放器控制条按根元素大小摆在看板正中 | FLOW-SKETCH/S5 |
| 5 | 输入「按钮换成圆形，加一个音量滑块」，点发送，等作业完成 | 动词行写「改「<草稿名>」」；完成后看板里的草稿有音量滑块 | FLOW-SKETCH/S6 |
| 6 | 点工具条上的「收起」 | 看板清空，这张草稿留在记录栏 | FLOW-SKETCH/S8-a、FLOW-SKETCH/S8-b |
| 7 | 点记录栏里的这张草稿 | 草稿回到看板，带音量滑块 | FLOW-SKETCH/S9 |

后置：`pnpm seed`（对测试库）。

#### `TC-CORE-112` 从屏建草稿：整屏与一块 — 对应 `REQ-CORE-043`（`API-CORE-048`、`ADR-032`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name ForkApp --device mobile --screens 2 --no-shot`（项目 P，第一屏 S），把 P 的圆角档改成 `round`（让它的 prelude 与草稿本的不同）；记下 S 当前版的 HTML。
正文比较时去掉 `data-qid`、合并空白。
脚本同上（`ONLY=TC-CORE-112`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/sketchbook/drafts {fromScreenId:S}` | `201`，新草稿在草稿本里：名字「Screen 1」、`frame=mobile`、路由 `/draft-<n>`；`refProjectId=P`、`targetScreenId=S`、`targetQid=null`；`target` 是 `{projectId:P, projectName:"ForkApp", screenName:"Screen 1"}`；它只有 1 版，`sourceKind=fork`、没有偏离；正文与 S 当前版相同；HTML 带 P 的 prelude；`data-qid` 从 `q1` 重编 |
| 2 | 同样建草稿，带 S 的 `<main>` 那个元素的 `qid` | `201`：`frame=component`；名字是「Screen 1 · 」接那一块可见文字的前 10 个字；`targetQid` 是那个 `qid`、`refProjectId=P`；正文就是那个元素连同子树 |
| 3 | MCP `quilt.create_draft {fromScreenId:S, qid:<S 的 h1>}` | 不报错；草稿名「Screen 1 · Screen 1 v」、`targetQid` 是那个 h1 的 `qid` |
| 4 | 依次建草稿：`qid:"q9999"`；来源是第 1 步的草稿；来源是不存在的 id；不带 `fromScreenId` | 依次 `404 /errors/element-not-found`、`404 /errors/not-found`、`404`、`400`（`errors` 点名 `fromScreenId`） |
| 5 | 在 P 上发一轮钉死路由 `/later` 的懒生成（stub 拖 6 s），新屏建出、第一版还没落库时拿它建草稿 | `400 /errors/validation`，`errors` 点名 `fromScreenId` |
| 6 | 同一个 `Idempotency-Key` 对 S 连发两次建草稿 | 第一次 `201`、第二次 `200`，返回同一张草稿；草稿本只多 1 张 |

后置：无。

#### `TC-CORE-113` 参照项目：设置、改稿与出稿按它写、删了退回自由风格 — 对应 `REQ-CORE-042`（`API-CORE-012`、`API-CORE-010`、`ADR-033`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：「草稿桩」已建并验证（它记下每次调用的系统提示）；`pnpm seed:project --name RefApp --device mobile --screens 2 --no-shot`（项目 P），圆角档改成 `round`，确认 P 的 prelude 与草稿本的不同；草稿本里用 stub 出组件草稿 D（「一张余额卡片」加第二行 `[stub-frame:component]`）。
脚本同上（`ONLY=TC-CORE-113`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `PATCH /v1/screens/<D> {refProjectId:P}` | `200`，`screen.refProjectId=P`；D 的修订仍是 1 条 |
| 2 | 给 P 的一屏设参照；给 D 设参照为草稿本；给 D 设参照为不存在的 id | 依次 `422`（点名 `refProjectId`）、`404 /errors/not-found`、`404`；D 的参照仍是 P |
| 3 | 用「草稿桩」对 D 改一轮「标题加粗」 | 改稿调用的系统提示以草稿生成器标记开头，带 `REFERENCE PROJECT: RefApp`、P 的 DESIGN.md 开头、`bg-X / text-X` 说明、路由表 `/s1 (Screen 1)` 与 `COMPONENT RECIPES`；D 的新版 HTML 带 P 的 prelude |
| 4 | MCP `quilt.update_screen` 写 D（带当前修订） | 不报错，D 的当前版 HTML 带 P 的 prelude |
| 5 | 删掉 P；用「草稿桩」再改 D 一轮 | 删项目 `204`；D 的 `refProjectId` 变成 `null`；这一轮系统提示不带 `REFERENCE PROJECT`、带「There is no design system」；新版按草稿本的 prelude |
| 6 | 新建项目 RefApp2（Q），给 D 设参照 Q，再设回 `null` | 两次都 `200`，最后 `refProjectId=null` |
| 7 | 把 Q 的圆角档改成 `round`；用「草稿桩」出新草稿（「一张会员卡」），请求带 `refProjectId:Q` | 出稿调用的系统提示带 `REFERENCE PROJECT: RefApp2`；新草稿的 `refProjectId=Q`，第一版 HTML 带 Q 的 prelude |
| 8 | 在 Q 上发消息带 `refProjectId:Q`；在草稿本发新草稿带 `refProjectId`=草稿本；改第 7 步的草稿时带 `refProjectId:Q` | 依次 `400`（点名 `refProjectId`）、`404`、`400`（点名 `refProjectId`） |

后置：无。

#### `TC-CORE-114` 覆盖整屏可回溯；改写缺省按参照项目；写回目标 — 对应 `REQ-CORE-044`、`REQ-CORE-041`（`API-CORE-047`、`ADR-032`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name OverApp --device mobile --screens 2 --no-shot`（项目 P，第一屏 S），记下 S 的修订列表与当前版 N 的正文；草稿本里用 stub 出手机页草稿 D（「一张新的首页」加第二行 `[stub-frame:mobile]`），记下它的修订数与当前版正文。
脚本同上（`ONLY=TC-CORE-114`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/sketchbook/drafts/<D>/copy {projectId:P, as:"overwrite"}`；再带上 `screenId:S`、`expectedRevisionId:N`、`restyle:true` 发一次 | 第一次 `400`，`errors` 点名 `screenId` 与 `expectedRevisionId`；第二次 `400`，点名 `restyle` |
| 2 | `{projectId:P, as:"overwrite", screenId:S, expectedRevisionId:N}` | `201`：`screen.id=S`、带 `revisionId`、`previousRevisionId=N`、没有 `job`；S 多 1 版：`sourceKind=sketch`、`seq=N.seq+1`、父修订是 N，正文与 D 当前版相同、带 P 的 prelude；原有修订不变；D 的写回目标是 S、`targetQid=null`；D 的修订数不变 |
| 3 | `POST /v1/screens/<S>/revisions/<N>/restore {expectedRevisionId:<第 2 步的新版>}` | `201`，S 的最新一版正文回到 N 的正文 |
| 4 | D 没有参照时 `as:"screen"` 写进 P；给 D 设参照 P 后再写一次新屏；新建桌面项目 OtherApp，把 D 写成它的新屏；最后 `as:"component"` 写进 P | 第一次 `201` 带 `edit_screens` 改写作业，D 的写回目标变成这张新屏；第二次没有 `job`；第三次带 `edit_screens` 作业；落成组件 `201` 带 `component`、没有 `job`，D 的写回目标不变 |
| 5 | MCP `quilt.copy_draft {screenId:D, projectId:P, as:"overwrite", targetScreenId:S, expectedRevisionId:<S 当前版>}`；再不带 `targetScreenId` 调一次 | 第一次不报错，`screen.id=S`、`previousRevisionId` 是调用前的当前版；第二次报错并点名 `targetScreenId` |

后置：无。

#### `TC-CORE-115` 换一块：只换那个元素，组件实例与其余原样 — 对应 `REQ-CORE-044`、`REQ-CORE-043`（`API-CORE-047`、`ADR-032`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name BlockApp --device mobile --screens 2 --no-shot`（项目 P，第一屏 S），把 S 的 `<nav>` 提成共享组件 TabBar（S 多一版，`<nav>` 成了实例）；从 S 的 `<main>`（记下它的 `qid`）建草稿 F，用 stub 改一轮「换成一张播放卡片」（`[stub-frame:component]`），F 的正文含「Now playing」。
脚本同上（`ONLY=TC-CORE-115`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/sketchbook/drafts/<F>/copy {projectId:P, as:"overwrite", screenId:S, qid:<main 的 qid>, expectedRevisionId:<S 当前版>}` | `201`，`previousRevisionId` 是原当前版；S 的新版里没有 `<main>`、有「Now playing」，换进去的根沿用 `<main>` 原来的 `qid`；顶栏与 TabBar 实例（`data-component="TabBar"`）与之前一字不差；F 的写回目标是 S、`targetQid` 是那个 `qid` |
| 2 | 用 stub 再改 F 一轮（`[stub-patch]`），按 F 的写回目标（`screenId`、`qid`）再写一次 | `201`；S 只多 1 版，正文含「Patched title」，TabBar 实例仍不变 |

后置：无。

#### `TC-CORE-116` 写回的冲突与失败：别处改过、正在改、组件实例、元素不在、超限 — 对应 `REQ-CORE-044`（`API-CORE-047`，§16「写回时目标屏已被别处改过」「写回时目标屏正在改」，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name ClashApp --device mobile --screens 2 --no-shot`（项目 P，第一屏 S），把 S 的 `<nav>` 提成共享组件 TabBar；草稿本里用 stub 出组件草稿 D（「一块面板」）；记下 S 的修订数与当前版 N。
脚本同上（`ONLY=TC-CORE-116`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 用元素直改把 S 的标题改成「别处改过」；再以 `expectedRevisionId:N` 覆盖整屏 | 直改 `201`；覆盖 `409 /errors/revision-conflict`；S 的修订数只多直改那 1 条，当前版仍是直改那一版 |
| 2 | 对 S 发一轮 stub 拖 6 s 的改屏；跑着时以当前版覆盖整屏 | 覆盖 `409 /errors/screen-busy`，S 的修订数不变；等那一轮结束 |
| 3 | 以 TabBar 实例根、实例里的一个链接各做一次换一块 | 都是 `409 /errors/component-locked` |
| 4 | 换一块 `qid:"q9999"`；`screenId` 填草稿 D 自己；目标项目填草稿本 | 依次 `404 /errors/element-not-found`、`404 /errors/not-found`、`404` |
| 5 | MCP `quilt.create_screen` 在草稿本建一张很长的草稿，拿它换掉 S 的标题 | 建草稿不报错；换一块 `400 /errors/validation`，`errors` 点名 `html`、消息含「256 KB」；S 的修订数与当前版都没变 |

后置：无。

#### `TC-CORE-117` 草稿里只改一块（接口） — 对应 `REQ-CORE-045`（`API-CORE-006`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：「草稿桩」已建并验证；草稿本里用 stub 出组件草稿 D（「一张播放卡片」），记下它当前版 R0、正文里一个 `<p>` 的 `qid` 与 `<h1>` 的 `qid`。
脚本同上（`ONLY=TC-CORE-117`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/<草稿本>/jobs {kind:"regenerate_subtree", input:{screenId:D, qid:<p>, prompt:"换成一行青色的小字", expectedRevisionId:R0, runner:stub}}`，等作业结束 | `202`，作业成功；D 有 2 版，最新一版 `sourceKind=subtree`、没有偏离；那个 `<p>` 换成「Regenerated block」并沿用原 `qid`；`<h1>` 原样 |
| 2 | 再以 R0 对 `<h1>` 发同样的作业；在草稿本里对普通项目 SubApp 的一屏发 | 依次 `409 /errors/revision-conflict`、`404 /errors/not-found` |
| 3 | 给 D 设参照 SubApp；用「草稿桩」对 `<h1>` 发「标题换成本项目的主色」；再经 MCP 对 D 发一次 `regenerate_subtree` | 作业成功；这次调用的系统提示带 `REFERENCE PROJECT: SubApp` 与 `DRAFT RULES`；新版带 SubApp 的 prelude；MCP 那次作业也成功 |

后置：无。

#### `TC-CORE-118` 交给本机会话：有参照的草稿读参照项目的契约，只改一块用草稿规则 — 对应 `REQ-CORE-042`、`REQ-CORE-045`（`ADR-033`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：API 与脚本以同一个 `QUILT_CLAUDE_SESSIONS_DIR` 启动（§3），本机 `claude` 可用（否则跳过）；起一个假会话「Stub 参照」接投递；`pnpm seed:project --name AgentRef --device mobile --screens 1 --no-shot`（项目 P）；草稿本里用 stub 出组件草稿 D，设参照 P。
脚本同上（`ONLY=TC-CORE-118`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 改 D 一轮，通道选这个会话 | `202`；投递的提示词要会话先 `quilt.get_design_contract { projectId: "<P>" }`，带 `REFERENCE PROJECT`，写回的 `projectId` 是草稿本、`screenId=<D>`；不含「There is no design system」 |
| 2 | 对 D 的 `<h1>` 发 `regenerate_subtree`，通道选这个会话 | `202`，作业 `runner=agent`；投递的提示词带那个元素的 `data-qid`、「on the target draft」、`DRAFT RULES` 与 `expectedRevisionId=<D 当前版>`，不含「Target screens」 |

后置：关掉假会话。

#### `TC-CORE-119` 画布上「到草稿本里改」：整屏与一块 — 对应 `REQ-CORE-043`（`PAGE-SKETCH`「从画布进来」、`API-CORE-048`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name ForkUi --device mobile --screens 2 --no-shot`（项目 P，第一屏 S），记下 S 的 `<h1>` 的 `qid`；视口 1440×900。
脚本同上（`ONLY=TC-CORE-119`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 P 的画布，单击 /s1，点工具栏「到草稿本里改」（`fork-to-sketch`） | 地址变为 `/sketch?d=<新草稿>`，看板打开这张草稿；它的写回目标是 S、`targetQid=null`、画框 `mobile`、参照项目 P |
| 2 | 回到 P 的画布，单击 /s1 再 `Shift` 单击 /s2 | 工具栏上没有「到草稿本里改」 |
| 3 | `⌘E` 进选择元素，点 /s1，在屏里点那个 `<h1>`，点检查器里的「到草稿本里改」（`el-fork-to-sketch`） | 地址变为 `/sketch?d=<又一张新草稿>`；它的写回目标是 S、`targetQid` 是那个 `<h1>` 的 `qid`、画框 `component` |

后置：无。

#### `TC-CORE-120` 「写回项目…」弹层：覆盖整屏、版本过期、写回目标被删 — 对应 `REQ-CORE-044`（`PAGE-SKETCH`「写回项目…」弹层、`API-CORE-047`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name BackApp --device mobile --screens 2 --no-shot`（项目 P，第一屏 S）；从 S 建整屏草稿 F（`API-CORE-048`），用 stub 改它一轮，等这一版的截图拍好；打开 `/sketch?d=<F>`。
脚本同上（`ONLY=TC-CORE-120`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点「写回项目…」 | 弹层出现：目标项目缺省是 BackApp；方式是「覆盖整屏」（`copy-as` 的 `data-value=overwrite`）；`copy-compare` 里并排两格：左边目标屏当前版（种子不拍截图，写「还没有截图」）、右边草稿缩略图；`copy-restore-hint` 写着「Screen 1」与「第 <S 当前 seq> 版」；没有改写勾选 |
| 2 | 经 API 用元素直改把 S 的标题改成「别处改过」，再点确认 | 弹层不关，`copy-error` 写「刚被改过」；`copy-restore-hint` 换成「第 <seq+1> 版」 |
| 3 | 再点确认 | 请求体 `as=overwrite`、`screenId=S`、`expectedRevisionId` 是直改那一版，不带 `restyle` 与 `qid`；提示条「已写回「BackApp」」；S 最新一版 `sourceKind=sketch`、父修订是直改那一版 |
| 4 | 经 API 删掉 S，重新打开 F 的「写回项目…」 | `copy-target-gone` 写着原来那一屏不在了；方式退回「新屏」，目标项目是参照项目 BackApp |

后置：按 `Esc` 关弹层。

#### `TC-CORE-121` 「写回项目…」弹层：换一块，在活预览里点选 — 对应 `REQ-CORE-044`（`PAGE-SKETCH`「写回项目…」弹层、`API-CORE-047`、`ADR-032`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name PickApp --device mobile --screens 2 --no-shot`（项目 P，第一屏 S），把 S 的 `<nav>` 提成共享组件 TabBar；从 S 的 `<main>` 建草稿 F，用 stub 改一轮「换成一张播放卡片」（`[stub-frame:component]`）；打开 `/sketch?d=<F>`。
脚本同上（`ONLY=TC-CORE-121`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点「写回项目…」 | 方式缺省「换一块」（`data-value=replace`）；活预览（`target-picker`）就绪，`copy-picked` 写「换掉 …」（预选的是 `<main>`） |
| 2 | 在活预览里点 TabBar 实例里的一个链接 | `copy-locked` 写着这是共享组件；`copy-picked` 不变 |
| 3 | 点确认 | 请求体 `as=overwrite`、`screenId=S`、`qid` 是 `<main>` 的 `qid`、`expectedRevisionId` 是 S 当前版；提示条「已写回「PickApp」」；S 的新版含「Now playing」，TabBar 实例与之前一字不差 |

后置：无。

#### `TC-CORE-122` 草稿里点选一块改它 — 对应 `REQ-CORE-045`（`PAGE-SKETCH`「选元素」、`API-CORE-006`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：草稿本里用 stub 出组件草稿 D（「一张播放卡片」加第二行 `[stub-frame:component]`），记下它当前版 R0 与正文里一个 `<p>` 的 `qid`；打开 `/sketch?d=<D>`，输入框通道选「草稿桩」。
每次在草稿里点之前，等草稿的框稳住：组件草稿打开和每落一版都会重载、再报一次尺寸，框先是 1280×800 的占位，再缩成「根元素的框 + 四周各 64 px」并重新居中。
脚本同上（`ONLY=TC-CORE-122`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点工具条「选元素」（`draft-pick`），在草稿里点那个 `<p>` | 「选元素」`aria-pressed=true`；工具条上没有「批注」（`draft-annotate` 为 0）；输入框多一枚胶囊（`draft-pick-chip`）写「「<D 的名字>」里的 …」；动词行写「改这一块」 |
| 2 | 输入「换成一行青色的小字」，点发送 | 请求 `POST /v1/projects/<草稿本>/jobs`，`kind=regenerate_subtree`，`screenId=D`、`qid` 是那个 `<p>` 的、`expectedRevisionId=R0`；D 的最新一版 `sourceKind=subtree`；新版落库后胶囊消失 |
| 3 | 再点草稿里的标题出胶囊，焦点放在空输入框里按 `Esc`；再按一次 `Esc` | 第一下胶囊消失、看板仍是 `draft`；第二下「选元素」关掉（`draft-pick` 不再 `aria-pressed`），看板仍是 `draft`（v1.38） |
| 4 | 「选元素」关着、焦点不在输入框里，按 `⌘E` 两次、`⌥N` 一次；再点进草稿里一段字（焦点进了草稿 iframe）按 `⌘E` | `⌘E` 开、关「选元素」（`aria-pressed` 跟着翻转），`⌥N` 什么也不开；焦点在草稿里按 `⌘E` 照样打开「选元素」（预览运行时转发，v1.16） |

后置：无。

#### `TC-CORE-123` 参照项目与「来自」 — 对应 `REQ-CORE-042`、`REQ-CORE-043`（`PAGE-SKETCH` 工具条「参照」与输入框「参照」、`API-CORE-012`、`API-CORE-010`，v1.14）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name RefUi --device mobile --screens 1 --no-shot`（项目 P）；草稿本里用 stub 出组件草稿 D；打开 `/sketch?d=<D>`，输入框通道选「草稿桩」。
脚本同上（`ONLY=TC-CORE-123`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 看工具条；在「参照」（`draft-ref`）里选 RefUi | 一开始参照是自由风格（`data-value` 为空）、没有「来自」；选了之后 D 的 `refProjectId=P`，触发器的 `data-value=P` |
| 2 | 经 API 从 P 的第一屏建整屏草稿 W，打开 `/sketch?d=<W>` | 名字旁「来自」（`draft-origin`）写着「RefUi · Screen 1」 |
| 3 | 打开 `/sketch`（看板空），在输入框的「参照」（`sketch-ref`）里选 RefUi，输入「一张会员卡」发送 | 一开始参照是自由风格；请求 `POST …/messages` 带 `refProjectId=P`、不带 `targetScreenIds`；新草稿摆上看板，它的 `refProjectId=P` |

后置：无。

#### `TC-CORE-125` 看板放大：工具条在顶行，草稿居中、放到能放下的最大，输入框与记录栏浮在上面 — 对应 `REQ-CORE-040`（`PAGE-SKETCH`「看板」「草稿工具条」，v1.16、v1.17）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：草稿本里没有在跑的作业（有就先取消：同一时间只许一张新草稿在生成）；草稿本里用 stub 出手机页草稿 D（「一个记账 App 的首页」，`frame:"mobile"`）；本机没有 `quilt:composer:sketch` 记录；视口 1440×900，记录栏开着。
脚本同上（`ONLY=TC-CORE-125`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `/sketch?d=<D>`，量工具条、项目切换器、看板与草稿 iframe 的框 | 工具条与项目切换器在同一行（顶边差 ≤ 8 px），看板从工具条下面开始；草稿在看板里居中（中心差 ≤ 2 px），缩放 = min(1, 看板宽 / 390, 看板高 / 844)（差 ≤ 0.01） |
| 2 | 点「收起」把输入框收成胶囊 | 看板与草稿的框都不变（差 ≤ 1 px）：输入框浮在看板上，不让位 |
| 3 | 点胶囊展开，点把手，在菜单里选「左边」 | 看板不变；输入框停在左边、与看板相交（浮在上面） |
| 4 | 点记录栏的开合键（`rail-toggle`） | 记录栏收起；看板的框不变（差 ≤ 1 px）：记录栏浮在看板上，不让位 |

后置：删掉本机的 `quilt:composer:sketch` 与 `quilt:sketch-rail` 记录。

#### `TC-CORE-128` 打开着的草稿出新版、换画框都原地换，不重载、不出加载中 — 对应 `REQ-CORE-040`（`PAGE-SKETCH`「看板」，v1.18）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：经 MCP `quilt.create_screen` 在草稿本里建手机页草稿 D「十月账单」（根元素 `data-frame="mobile"`，一个 `<h1>十月账单</h1>` 加 24 行列表，比视口高）；视口 1440×900，打开 `/sketch?d=<D>`，在草稿的 window 上打一个标记、往下滚到 400 px。
每一步动手前在父页按帧（`requestAnimationFrame`）记看板：骨架（`.draft-skeleton`）与「加载中…」出现的帧数、`draft-iframe` 是不是开始时那一个元素、它最宽到多少。
脚本同上（`ONLY=TC-CORE-128`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 经接口改 D 一轮「标题改一下」，第二行 `[stub-patch]`（stub），等草稿里的 `<h1>` 变成「Patched title」 | 15 s 内变；草稿 window 上的标记还在、`draft-iframe` 一直是同一个元素；骨架与「加载中…」0 帧；滚动位置仍是 400（差 ≤ 2） |
| 2 | 经接口回到第 1 版（`POST /v1/screens/<D>/revisions/<第 1 版>/restore`） | `201`；`<h1>` 变回「十月账单」，标记还在、同一个元素，骨架与「加载中…」0 帧 |
| 3 | `PATCH /v1/screens/<D> {frame:"desktop"}` | `200`；10 s 内 iframe 的布局宽变成 1280；标记还在、同一个元素，骨架与「加载中…」0 帧 |
| 4 | 用 stub 出组件草稿 C（「一张播放卡片」，第二行 `[stub-frame:component]`），打开它、等框稳住后打标记；改 C 一轮「标题改一下」加 `[stub-patch]` | `<h1>` 变成「Patched title」；标记还在、同一个元素，骨架与「加载中…」0 帧；全程 iframe 最宽不到 1000（没有退回 1280×800 的占位框） |

后置：无。


#### `TC-CORE-129` 缩小显示的屏不走缩放变换，玻璃卡片旁不闪灰条 — 对应 `REQ-CORE-040`、`REQ-CORE-004`（`PAGE-CANVAS`「聚焦屏不走缩放变换」、`PAGE-SKETCH`「看板」，v1.19）· 级别: 回归 · 执行者: 皆可（第 3 步要可见窗口：AI 须先征得用户同意，否则记待人工）· 源自缺陷 2026-10-20 选元素时玻璃卡片旁闪出灰色渐变、下面一排图标消失

前置：草稿本里经 MCP 建手机页草稿「记账App」，正文是 `tests/e2e/fixtures/glass-ledger.html`（卡片同时带 `backdrop-blur-xl` 与大投影，下面一排白底图标）；另建项目 Glass，放同一份正文的 `/ledger` 屏；视口 1440×900，看板与镜头都把屏缩小显示（倍率 < 1）。
「缩放连乘」= iframe 自己与各层祖先计算后的 transform 的缩放（matrix 的 a）相乘；「显示倍率」= iframe 的显示宽 ÷ 布局宽；「里面的宽」= iframe 里根元素的宽。
脚本同上（`ONLY=TC-CORE-129`，只含第 1、2 步）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `/sketch?d=<记账App>`，量草稿 iframe 的缩放连乘、显示倍率与里面的宽 | 显示倍率 < 0.99；缩放连乘 = 1（差 ≤ 0.01）；里面的宽不小于 390、多出不到一个设备像素 |
| 2 | 打开项目 Glass，`⌘E` 点 `/ledger` 进选择元素，等 1.2 s；量同样三项，再读世界层的缩放倍率 | 显示倍率 = 镜头倍率（差 ≤ 0.01）；缩放连乘 = 1；里面的宽同第 1 步 |
| 3 | 可见窗口（有头 Edge，DPR 2）里，第 1、2 步各打开 2 次，看卡片四周与它下面那排图标 | 卡片右侧没有灰色渐变条，下面那排图标都在；iframe 里 `innerWidth` = 390 |

后置：无。

#### `TC-CORE-138` 草稿里只改一块时带参考图 — 对应 `REQ-CORE-045`、`REQ-CORE-012`（`PAGE-SKETCH`「选元素」、`API-CORE-006`「参考图」，v1.21）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：「草稿桩」已建并验证；草稿本里用 stub 出组件草稿 D（「一张播放卡片」加第二行 `[stub-frame:component]`），记下它当前版 R0 与正文里一个 `<p>` 的 `qid`；打开 `/sketch?d=<D>`，输入框通道选「草稿桩」；一张 1×1 的 PNG 当参考图。
脚本 `tests/e2e/sketch.ts`（`ONLY=TC-CORE-138`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点「选元素」，等框稳住后点草稿里那个 `<p>`；用输入框的「加参考图」选那张 PNG，等它传完 | 输入框出胶囊、动词行写「改这一块」；参考图区有 1 张缩略图，没有「上传中…」 |
| 2 | 输入「照这张图的感觉改」，点发送 | 请求 `POST /v1/projects/<草稿本>/jobs`，`kind=regenerate_subtree`、`qid` 是那个 `<p>` 的、`attachmentIds` 1 个；没有出错提示条；作业输入的 `imageKeys` 1 个；这一轮的用户消息带 1 张附件 |
| 3 | 等作业结束 | 作业成功；D 的最新一版 `sourceKind=subtree`；「草稿桩」收到的这次调用带图，用户提示以草稿本的参考图说明开头（「The user attached reference image(s)」）；输入框里的缩略图与胶囊都清掉 |
| 4 | 接口：在草稿本里再传一张图，发 `export_prototype` 带 `attachmentIds:[这张图]`；再对 D 的当前版发 `regenerate_subtree` 带 `attachmentIds:[一个不存在的 id]` | 都是 `400 /errors/validation`，字段 `attachmentIds`；没有建出作业 |
| 5 | MCP：再传一张图（`quilt.create_upload_url`，`mediaType=image/png`），调 `quilt.regenerate_subtree` 对那个 `<p>` 带 `attachmentIds` 与 stub 通道 | 作业成功，作业输入的 `imageKeys` 1 个 |

后置：无。

#### `TC-CORE-150` 草稿本按 `⌘Z` 回到上一版 — 对应 `REQ-CORE-040`（`PAGE-SKETCH`「快捷键」，v1.25）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：经接口出一张组件草稿「一个音乐播放器的迷你控制条」并改两轮（「按钮换成圆形，加一个音量滑块」「标题改成夜航星 · 现场版」），共 3 版；打开 `/sketch?d=<这张草稿>`，看板显示第 3 版。
脚本 `tests/e2e/sketch.ts`（`ONLY=TC-CORE-150`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点一下看板空白处（焦点不在文本框里），按 `⌘Z` | 提示「已回到第 2 版」；多出第 4 版，`sourceKind=restore`、父修订是第 2 版、内容与第 2 版相同；看板换成这一版 |
| 2 | 点进草稿 iframe 里不是输入框的地方，按 `⌘Z` | 由预览运行时转发，同样生效：多出第 5 版，内容与第 1 版相同 |
| 3 | 再按 `⌘Z` | 提示「已经是第一版」；版本数不变 |
| 4 | 在输入框里打「abc」，按 `⌘Z` | 输入框里的字被撤销；版本数不变 |
| 5 | 经接口再改一轮并拖住它（`[stub-hold:5000]`），趁它在跑按 `⌘Z` | 提示这张草稿正在改；版本数只因这一轮多 1，`⌘Z` 没有再建版本 |

后置：无。

#### `TC-CORE-151` 截图存储瘦身：无损 WebP、旧版本只留缩略图、回到旧版共用对象 — 对应 `REQ-CORE-007`、`REQ-CORE-004`（`ADR-037`、`API-CORE-015`，v1.27）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`，要 `QUILT_E2E_RESTART`）

前置：隔离栈；`pnpm seed:project --name Shots --device mobile --screens 2`（带截图）；把 /s1 经接口改两轮，共 3 版（v1、v2、v3），等截图都拍完。对象目录取被测栈 `GET /v1/config` 的 `home` 下的 `objects/`。
脚本 `tests/e2e/core/backend.ts`（`ONLY=TC-CORE-151`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 读 v3 的 `screenshot_key` 与对象文件头 | 键以 `.webp` 结尾；文件是 `RIFF…WEBP`，里面是无损块 `VP8L`；缩略图照旧是 `.thumb.webp` |
| 2 | 经测试库把 v1 的 `created_at` 改到 25 小时前，用短首轮间隔重启 API，等 `screenshot.prune` 跑完一轮 | v1 的 `screenshot_key` 为空、对象文件已删，缩略图与 HTML 还在；v2（24 小时内）与 v3（当前版）的截图不动 |
| 3 | `GET` v1 的修订；打开画布的修订面板 | `screenshotUrl` 为空、`thumbUrl` 可用；面板里 v1 照常显示缩略图 |
| 4 | MCP `quilt.get_revision` 取 v1 | 返回的截图地址取得到图（当场从 HTML 重拍）；v1 的 `screenshot_key` 又有值 |
| 5 | 回到 v2（`API-CORE-015`） | 新的 v4 与 v2 的 `html_key`、`screenshot_key`、`thumb_key` 相同；屏的对象目录里没有多出文件；没有为 v4 重拍 |
| 6 | 再按第 2 步把 v1 的截图清掉，然后回到 v1 | v5 与 v1 共用 `html_key`，截图是新拍的（新的键），缩略图跟着新拍 |
| 7 | 把 /s1 改成叠层呈现，回到 v2 | 新一版重拍截图，键是 `.overlay.webp` |
| 8 | 把 v2 的 `created_at` 改到 25 小时前，回到 v2 让新一版 v7 共用它的截图，再让 `screenshot.prune` 跑一轮 | v2 的 `screenshot_key` 置空，但对象还在（v7 是当前版、还在用它） |
| 9 | 往测试库写一版 `screenshot_key` 以 `.png` 结尾的当前版（拷一张 PNG 进对象目录），重启 API，等后台转换 | 键换成 `.webp`、PNG 文件已删、WebP 与原 PNG 逐像素相同 |
| 10 | 等 `screenshot.retry` 再跑一轮 | 第 2 步清掉的旧版截图没有被补回来 |

后置：恢复默认的首轮间隔重启一次 API。

#### `TC-CORE-158` 选元素不被全透明的遮罩挡住 — 对应 `REQ-EDIT-001`（`PAGE-CANVAS`「选元素的命中」，v1.34）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）· 源自缺陷 2026-10-22 草稿本里 moneynote 选元素只能选中最大的一块

前置：草稿桩通道就绪（同 `TC-EDIT-041`）；经 `POST /v1/projects/<草稿本>/messages` 用桩通道发「一个带抽屉的账单页」，桩回一张手机草稿：标题、一段说明、「筛选」按钮，外加一个收起的底部抽屉——全屏 `fixed inset-0 z-50 pointer-events-none` 的容器里一层 `opacity-0` 的遮罩，抽屉面板 `translate-y-full` 移在视口外。打开这张草稿。
脚本 `tests/e2e/sketch.ts`（`ONLY=TC-CORE-158`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开「选元素」，点标题 | 草稿里的选中框标签写「h1 · <标题的 qid>」（修复前写「div · <遮罩的 qid>」：点哪都选中遮罩） |
| 2 | 点「筛选」按钮 | 选中框标签写「button · <按钮的 qid>」 |
| 3 | 关掉「选元素」，取按钮中心点的命中元素 | 不留选中框；命中的是按钮本身，遮罩照旧不挡点击 |

后置：无（草稿随下一次 `pnpm seed` 清掉）。

#### `TC-CORE-160` 选元素时悬停框跟着滚动 — 对应 `REQ-EDIT-001`（`PAGE-CANVAS`「选元素的命中」，v1.37）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）· 源自缺陷 2026-10-22 选元素时只悬停不点，滚动页面后悬停框停在原处

前置：草稿桩通道就绪（同 `TC-EDIT-041`）；经 `POST /v1/projects/<草稿本>/messages` 用桩通道发「一个长列表的账单页」，桩回一张手机草稿：标题加 30 行账单，一屏放不下。打开这张草稿。
脚本 `tests/e2e/sketch.ts`（`ONLY=TC-CORE-160`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开「选元素」，指针移到第 3 行中间、不点 | 悬停框（1 px 虚线）的上沿比第 3 行的上沿高 2 px |
| 2 | 指针不动，草稿往下滚 160 px（约 3.5 行） | 悬停框跟到此刻指针下的那一行，上沿仍比它高 2 px，框住的不再是第 3 行（修复前悬停框停在原处） |

后置：关掉「选元素」。

### CORE · 界面语言

浏览器语言由 Playwright 上下文的 `locale` 给（它同时决定 `navigator.languages` 与页面请求的 `Accept-Language`）；每条用例新开上下文，本机没有记过语言。
「页面上的中文」的数法：文字节点（含读屏专用的 sr-only）与 `aria-label` / `title` / `placeholder` / `alt` 里的中文字符与中文标点（含全角符号）；标了 `lang="zh…"` 的元素（设置里的语言名「中文」）与屏的 iframe 不算。
「请求带的语言」只看页面发往 `/v1/` 的 fetch / xhr 请求；项目事件流是 `EventSource`，带不了自定义头，按设计文档 §8 不算在内。

#### `TC-CORE-152` 局域网 IP 用 http 打开画布 — 对应 `REQ-CORE-004`（§15「局域网访问」，v1.30）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）· 源自缺陷 2026-10-22 从局域网 IP 用 http 打开画布整页白屏

前置：`pnpm seed:project --name Lan --device mobile --screens 2 --no-shot`；新开一个 1440×900 的浏览器上下文，每个文档加载前删掉 `crypto.randomUUID` 与 `navigator.clipboard`：浏览器在非安全上下文里就是这样，只有 HTTPS 与 localhost 算安全上下文，局域网 IP 走 http 不算。
脚本 `tests/e2e/canvas.ts`（`ONLY=TC-CORE-152`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开项目 | 两张屏卡出现，页面没有未捕获的异常 |
| 2 | 点工具栏「接上跳转」 | 提示「正在为 2 屏接上跳转」，`GET /v1/projects/<id>/jobs` 多出一个 `edit_screens` 作业 |
| 3 | 点输入框的「加参考图」选一张 PNG | 输入框里出现这张图的缩略图 |
| 4 | 打开设置「模型」节，点 Claude Code 接入命令旁的「复制」 | 提示「已复制」，不是「复制失败」 |

后置：无（项目随下一次 `pnpm seed` 清掉）。

#### `TC-CORE-130` 缺省语言跟随浏览器 — 对应 `REQ-CORE-046`（`PAGE-CANVAS` 设置弹层「语言」、§13.1 字体与字阶，v1.20）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Locale --device mobile --screens 2 --no-shot`；每一步新开浏览器上下文、按步骤给浏览器语言，视口 1440×900，打开该项目。脚本在 `tests/e2e/i18n.ts`（`ONLY=TC-CORE-130`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 浏览器语言 `en-US`，打开项目 | `<html lang="en">`；工具栏「设置」（`open-settings`）的标签是 `Settings`；`--semantic-typography-body-font-family` 以 `-apple-system` 开头、`--semantic-typography-body-line-height` 为 `1.5`；页面上没有中文；发往 `/v1/` 的请求（≥ 3 个）都带 `X-Quilt-Locale: en` |
| 2 | 浏览器语言 `zh-CN`，打开项目 | `<html lang="zh-CN">`；「设置」的标签是「设置」；正文字体以 `PingFang SC` 开头、行高 `1.6`；请求都带 `X-Quilt-Locale: zh`；同一种数法在这个页面上数得出中文（第 1 步的「没有中文」才算数） |
| 3 | 浏览器语言分别为 `zh-TW`、`ja-JP`，打开项目 | `zh-TW` 是中文界面（`lang="zh-CN"`、「设置」）；`ja-JP` 是英文界面（`lang="en"`、`Settings`） |
| 4 | 浏览器语言 `zh-CN`、本机 `quilt:locale` 记为 `en`，打开项目；再换浏览器语言 `en-US`、本机记为不认识的 `fr`，打开项目 | 前者是英文界面，请求都带 `X-Quilt-Locale: en`（选过的优先于浏览器语言）；后者按浏览器语言是英文界面 |

后置：无。

#### `TC-CORE-131` 设置里切换语言：即时生效、刷新后记住、别的页面跟着换 — 对应 `REQ-CORE-046`（`PAGE-CANVAS` 设置弹层「语言」，v1.20）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Switch --device mobile --screens 2 --no-shot`；新开浏览器上下文，浏览器语言 `en-US`，视口 1440×900。脚本在 `tests/e2e/i18n.ts`（`ONLY=TC-CORE-131`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 `/p/<id>?settings=system`；再依次点左栏三节 | 设置弹层标题 `Settings`，左栏 3 个 tab 依次写 `Usage` / `Models` / `System`，`System` 选中；右栏「Language」组两个选项写「中文」（`lang="zh-CN"`）与 `English`（`lang="en"`），`English` 选中；说明里有 `Screens you generate from now on are written in this language too`；三节逐节看，除语言名「中文」外页面上没有中文 |
| 2 | 点「中文」（`locale-zh`）；再点左栏「模型」 | 页面没有刷新（点之前在 `window` 上留的标记还在，URL 仍带 `settings=system`）；`<html lang="zh-CN">`，弹层当场换成中文：标题「设置」、左栏「用量 / 模型 / 系统」，「中文」选中；本机 `quilt:locale` 为 `zh`；切到「模型」后发出的请求都带 `X-Quilt-Locale: zh` |
| 3 | 刷新页面，进「系统」一节 | 仍是中文（`lang="zh-CN"`、标题「设置」），「中文」选中 |
| 4 | 点 `English`；在同一浏览器里另开一页打开 `/sketch` | 换回英文，本机记为 `en`；草稿本页 `<html lang="en">`，页面上没有中文 |

后置：无。

#### `TC-CORE-132` 接口错误文案按请求的界面语言 — 对应 `REQ-CORE-046`（§8 开头「界面语言」、§14，v1.20）· 级别: 回归 · 执行者: 皆可

前置：不要种子；`<missing>` 是一个不存在的项目 id（随机 UUID）。curl 缺省不带 `Accept-Language`，Node 的 `fetch` 缺省带 `Accept-Language: *`。第 7 步要能给每个 MCP 请求加请求头的客户端（脚本里的 `mcpWith`）。脚本在 `tests/e2e/i18n.ts`（`ONLY=TC-CORE-132`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `GET /v1/projects/<missing>`：一次什么头都不带，一次只带 `Accept-Language: *` | 都是 404、`type=/errors/not-found`，`title` 为「资源不存在」 |
| 2 | 同一请求带 `X-Quilt-Locale: en`；再带 `X-Quilt-Locale: EN` | 都是 404、`type` 不变，`title` 为 `Not found`；响应体的字段与第 1 步一样 |
| 3 | 只带 `Accept-Language`，依次为 `en-US,en;q=0.9`、`zh-CN,zh;q=0.9,en;q=0.8`、`en;q=0.5, zh-TW;q=0.8`、`fr-FR` | `title` 依次为 `Not found`、「资源不存在」、「资源不存在」（取 q 最高的 `zh-TW`）、`Not found`（不以 `zh` 开头的都是英文） |
| 4 | `X-Quilt-Locale: zh` 加 `Accept-Language: en-US`；`X-Quilt-Locale: fr` 加 `Accept-Language: en-US`；只带 `X-Quilt-Locale: fr` | 依次为「资源不存在」（头优先）、`Not found`（不认识的值当没有这个头，看 `Accept-Language`）、「资源不存在」 |
| 5 | `POST /v1/channels` 建 OpenAI 兼容通道但不给端点：一次带 `X-Quilt-Locale: en`，一次不带语言头 | 都是 400 `/errors/validation`；英文的 `title` 为 `Invalid request parameters`、`errors[0].message` 为 `OpenAI-compatible models need an endpoint`；不带头的是「请求参数不合法」与「OpenAI 兼容的模型必须填端点」；两边 `errors[].path` 一样，都是 `endpoint` |
| 6 | `GET /v1/projects` 带 `Origin: http://evil.example`：一次加 `X-Quilt-Locale: en`，一次不加 | 都是 403 `/errors/forbidden`；加了的 `title` 为 `Request origin is not on the local allowlist (Host / Origin)`，不加的为「请求来源不在本机名单（Host / Origin）」（语言先于来源校验定下） |
| 7 | MCP 调 `quilt.get_project`（`projectId=<missing>`）：一个客户端不带语言头，另一个客户端每个请求带 `X-Quilt-Locale: en` | 两次都是 `isError`、`type=/errors/not-found`；不带头的 `title` 为「资源不存在」，带 `en` 的为 `Not found` |

后置：无。

#### `TC-CORE-133` 作业失败 chip 的英文文案，换语言当场换字 — 对应 `REQ-CORE-046`（§14 作业失败文案、`PAGE-CANVAS`「作业 chip」，v1.20）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name "Fails EN" --device mobile --screens 2 --no-shot`；起一个 OpenAI 兼容桩（端口 3941；Key 不对回 401，每个回应拖 2.5 s，让画布先认领作业再收到失败，同 `TC-CORE-045`），建一条 Key 错的通道「Bad key 133」；新开浏览器上下文，浏览器语言 `en-US`，打开项目。作业经接口发、不带语言头，画布从项目事件流认出它们。脚本在 `tests/e2e/i18n.ts`（`ONLY=TC-CORE-133`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/<id>/messages` 对 `/s1` 改屏（`make it dark`），`runner` 指到坏 Key 通道 | 输入框上方出这个作业的失败 chip（`data-state=failed`），结果句为 `Edit “Screen 1” · Edit failed: the model’s key was rejected (HTTP 401).`（能重试，只写原因）；「重试」（`retry-job`）写 `Retry`、标签 `Retry: Edit “Screen 1”`；×（`dismiss-job`）的标签 `Dismiss failure notice: Edit “Screen 1”`；整叠（`job-chips`）的标签 `Jobs` |
| 2 | `POST /v1/projects/<id>/jobs` 对 `/s1` 最后一个元素建 `regenerate_subtree`，`runner` 指到坏 Key 通道 | 失败 chip 的结果句为 `Regenerate block in “Screen 1” · Regenerating this block failed: the model’s key was rejected (HTTP 401). Check this model’s key in Settings → Models or switch to another model, then click “Regenerate block” in the Inspector again`；只有 ×、没有「重试」；两枚 chip 里都没有中文 |
| 3 | 从工具栏「设置」进「系统」节，在「语言」组点「中文」，按 `Esc` 关掉 | 两枚失败 chip 留着、当场换成中文：`改「Screen 1」 · 改屏失败：模型的 Key 被拒绝（HTTP 401）。` 与 `重生成「Screen 1」的一块 · 重做这一块失败：模型的 Key 被拒绝（HTTP 401）。到「设置 → 模型」检查这个模型的 Key 或换一个模型，然后在检查器里再点一次「重生成这块」`；「重试」写「重试」 |

后置：删通道、关桩。

#### `TC-CORE-134` 屏里修改标记的英文，换语言当场换字 — 对应 `REQ-CORE-046`（§13.1「画布标记」，v1.20）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name "Marks EN" --device mobile --screens 1 --no-shot`；新开浏览器上下文，浏览器语言 `en-US`，打开项目，双击 `/s1` 进交互（角标 `Interactive`）。「重生成一块」经 `POST /v1/projects/<id>/jobs` 对屏里的 `<h1>` 建 `regenerate_subtree`，`runner` 用 stub 驱动，要求里写 `[stub-hold:<毫秒>]` 拖住（§3）。脚本在 `tests/e2e/i18n.ts`（`ONLY=TC-CORE-134`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 建一个拖 6 s 的重生成一块 | 屏里那一块挂修改中的角标（`[data-quilt-mark][data-kind=working]`），字是 `Editing…` |
| 2 | 等它做完 | 那一块挂改完的角标（`data-kind=done`），字是 `Updated` |
| 3 | 再建一个拖 15 s 的；角标出现后从工具栏「设置」进「语言」点「中文」，按 `Esc` 关掉；等它做完 | 换之前角标写 `Editing…`；换完仍在交互中（角标「交互中」），修改中的角标当场写「修改中…」；做完后改完的角标写「已更新」 |

后置：无。

#### `TC-CORE-135` 带 `X-Quilt-Locale` 的写屏作业记下界面语言、提示词要求这种语言 — 对应 `REQ-CORE-046`（`API-CORE-006`「界面语言」、`ENT-GenerationJob` 的 `input.locale`，v1.20）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name "Locale Jobs" --device mobile --screens 1 --no-shot`；起一个 OpenAI 兼容桩（端口 3942；单屏规划回一屏、每次一个新路由，出屏与改屏回一屏 HTML；记下每个请求的系统提示），建通道「Stub 语言」并验证。每一步都等作业到终态，只看这一步里桩收到的请求。
英文的语言要求原句：`LANGUAGE: unless the request explicitly asks for a language, write all visible text on the screen in English. This takes precedence over any other language rule above.`；中文版把 `English` 换成 `Simplified Chinese`。脚本在 `tests/e2e/i18n.ts`（`ONLY=TC-CORE-135`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/<id>/messages` 带 `X-Quilt-Locale: en`，`content`「做一个登录页」，`runner` 指到桩通道 | 202，作业 `kind=generate`、`input.locale=en`，作业成功；这一轮桩收到的每个请求（规划与出屏，≥ 2 个）系统提示都以英文的语言要求结尾；这一轮的助手消息以 `Generated 1 screen: ` 开头 |
| 2 | 同样发，带 `X-Quilt-Locale: zh` | `input.locale=zh`；系统提示以 `Simplified Chinese` 那一句结尾；助手消息以「已生成 1 屏：」开头 |
| 3 | 同样发，不带 `X-Quilt-Locale`，只带 `Accept-Language: en-US,en;q=0.9` | 作业 `input` 里没有 `locale`；系统提示里没有 `LANGUAGE:`；助手消息以「已生成 1 屏：」开头 |
| 4 | MCP 调 `quilt.generate_screens`（同一句、`count=1`、同一通道） | 返回的作业 `input` 里没有 `locale`；这一轮的系统提示里没有 `LANGUAGE:` |
| 5 | `POST /v1/projects/<id>/messages` 带 `X-Quilt-Locale: en`，`content`「改成深色」，`targetScreenIds` 为 `/s1` | 作业 `kind=edit_screens`、`input.locale=en`；系统提示以英文的语言要求结尾；助手消息以 `Updated 1 screen: ` 开头 |

后置：删通道、关桩。

#### `TC-CORE-136` 作业的界面语言只取这次请求的头：重试与请求体 — 对应 `REQ-CORE-046`（`API-CORE-006`「界面语言」、`API-CORE-034`，v1.20）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name "Locale Retry" --device mobile --screens 1 --no-shot`；桩与通道同 `TC-CORE-135`（端口 3942，通道「Stub 重试」）；带 `X-Quilt-Locale: en` 发一轮「做一个登录页」（作业记 `locale=en`），等它结束，记下这一轮的用户消息 id `<mid>`。每一步都等作业到终态。脚本在 `tests/e2e/i18n.ts`（`ONLY=TC-CORE-136`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST /v1/projects/<id>/messages/<mid>/retry` 带 `X-Quilt-Locale: zh` | 202，新作业 `input.locale=zh` |
| 2 | 同一个 `<mid>` 再重试一次，不带语言头 | 202，新作业 `input` 里没有 `locale`（不沿用旧作业的 `en`） |
| 3 | `POST /v1/projects/<id>/jobs` 建 `edit_screens`，请求体的 `input` 里写 `locale: "en"`：一次不带语言头，一次带 `X-Quilt-Locale: zh` | 不带头的作业 `input` 里没有 `locale`；带头的为 `zh`（只认请求头，不认请求体） |

后置：删通道、关桩。

#### `TC-CORE-137` 草稿本的名字跟着请求的界面语言 — 对应 `REQ-CORE-046`（`API-CORE-046`「名字跟着界面语言」，v1.20）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed`；取草稿本 `GET /v1/sketchbook`；经 MCP `quilt.create_screen` 在草稿本里建手机页草稿「标题 $5 套餐」（名字带 `$`，验证标题替换不把它当成替换语法）；`pnpm seed:project --name "No Lang" --device mobile --screens 1 --no-shot`。
脚本在 `tests/e2e/i18n.ts`（`ONLY=TC-CORE-137`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 分别带 `X-Quilt-Locale: en`、`X-Quilt-Locale: zh`、只带 `Accept-Language: en-US,en;q=0.9`、什么都不带，取草稿本的项目详情 | `project.name` 依次是「Sketchbook」「草稿本」「Sketchbook」「草稿本」 |
| 2 | 带 `X-Quilt-Locale: en` 取详情，打开这张草稿的 `previewUrl`；再带 `zh` 做一遍 | `previewUrl` 分别带 `lang=en`、`lang=zh`；下发文档的 `<title>` 分别是「Sketchbook · 标题 $5 套餐」「草稿本 · 标题 $5 套餐」 |
| 3 | 带 `X-Quilt-Locale: en` 取 No Lang 的详情 | 它那一屏的 `previewUrl` 不带 `lang` |

后置：无。

### CORE · 设置、用量与使用记录

#### `TC-CORE-140` 用量统计接口：范围、按周汇总、删掉的项目与模型 — 对应 `REQ-CORE-008`（`API-CORE-052`、`ADR-036`，v1.24）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：隔离测试栈；台账为空（`pnpm seed` 已清，脚本另把 `usage_entries` 删空）；`pnpm seed:project --name UsageA --device mobile --screens 1 --no-shot`；经 `API-CORE-028` 建一个指向 stub 端点的通道「Stub A」，用它在 UsageA 出一屏（台账多一条，带项目、任务类型与通道快照）；再往测试库的 `usage_entries` 直接写两条：① 100 天前一条，`driver=stub`、`model=old-model`，五个快照列都空；② 今天一条，`project_id` 与 `channel_id` 是库里没有的 uuid，`project_name=Gone`、`channel_label=Old Model`、`kind=edit_screens`。第 7 步的本机会话用假会话（§3「本机 agent」）。
脚本 `tests/e2e/settings.ts`（`ONLY=TC-CORE-140`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `GET /v1/me/usage/stats?range=7d&utcOffset=480` | `200`、`no-store`；`unit=day`，`buckets` 7 项、最后一项含今天；`totals.jobs` 等于近 7 天的台账条数；`models` 按全部时间的 Token 降序，「Stub A」`deleted=false`、「Old Model」`deleted=true` |
| 2 | 同上，`range=30d` | `buckets` 30 项，每项 `tokens` 各模型之和等于那天台账的 Token 合计 |
| 3 | 同上，`range=all` | 跨度超过 60 天：`unit=week`，每项 `from` 是周一，最后一项含今天；`activity.days` 是 90 项，与 `range` 无关 |
| 4 | 看第 3 步的 `projects` 与 `kinds` | `projects` 有 UsageA（`deleted=false`）、Gone（`deleted=true`）与一项 `id=null`（第 ① 条）；`kinds` 含 `generate`、`edit_screens` 与 `other` |
| 5 | 把项目改名为 UsageB、把通道显示名改为 Stub B，再取 `range=all` | 项目名是 UsageB，模型 `label` 是 Stub B，数不变 |
| 6 | 删掉项目 UsageB 与通道 Stub B，再取 `range=all` | 两者都还在、`deleted=true`，名字是删除前的 UsageB 与 Stub B，Token 不变 |
| 7 | 经 `API-AGENT-002` 建一条交给本机会话的改屏作业并以 `quilt.finish_job` 收尾 | 台账条数不变 |
| 8 | `range=1y`；`range=7d&utcOffset=900` | 都是 `400 /errors/validation` |
| 9 | `pnpm seed:project --name UsageExport --device mobile --screens 1 --no-shot`，经 `API-CORE-006` 建 `kind=export_prototype` 的作业，等它成功后取 `range=7d`（v1.28） | 台账多一条，`driver` 与 `model` 都空、`kind=export_prototype`；`totals.jobs` 多 1；`kinds` 里 `export_prototype` 的 `jobs` 是 1、`byModel` 为 `{}`；`models` 每项的作业次数与导出前相同 |

后置：删掉 UsageExport（第 5、6 步的项目与通道已删掉）。

#### `TC-CORE-141` 设置「用量」看板：日历、范围、悬停与空态 — 对应 `REQ-CORE-008`（`PAGE-CANVAS` 设置「用量」，v1.24）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：同 `TC-CORE-140` 前置建出的台账（独立建，不依赖它的第 5、6 步）；视口 1440×900；打开 `/p/<UsageA>?settings=usage`。
脚本 `tests/e2e/settings.ts`（`ONLY=TC-CORE-141`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 看左栏与活动卡 | 左栏三节「用量 / 模型 / 系统」，「用量」选中；日历 13 或 14 列 × 7 行，共 90 个日期格，今天那格的档位 ≥ 1；活跃天数、作业次数与 `activity` 一致 |
| 2 | 看「统计」 | 分段控件缺省「近 7 天」；四张看板的数与 `range=7d` 的 `totals` 一致；每日 Token 7 根柱；模型表里「Old Model」那行文字是灰的、带「已删除」 |
| 3 | 悬停今天那根柱 | 120 ms 内出现提示：各模型名、Token 与占比，合计等于当天的 Token |
| 4 | 点「近 30 天」，读滑块的 `transform`；刷新页面 | 滑块移到「近 30 天」下面，过渡时长 200 ms；柱子 30 根；刷新后仍是「近 30 天」（本机 `quilt:usage-range`） |
| 5 | 悬停日历里今天那格 | 提示写「<月> 月 <日> 日 · N 次」，N 等于今天的作业数 |
| 6 | 以减弱动态（`reducedMotion: reduce`）重开 | 柱子、胶囊与滑块的过渡与动画时长都是 0 |
| 7 | 拦下 `GET /v1/me/usage/stats`，回一份没有任何用量的结果，重开 | 日历全是最浅一档，图表区与三张排行写「还没有用量」，没有报错 |
| 8 | 拦下它回 `500`，重开；点左栏「模型」；放开拦截后回「用量」点「重试」 | 「用量」节写读取失败并给「重试」；「模型」节照常显示；重试后看板出现 |
| 9 | 经 `API-CORE-006` 导出 UsageA（`kind=export_prototype`），成功后重开；悬停「任务类型」里「导出」那行（v1.28） | 那行的横条是一整段，颜色是图表轴线色（`--semantic-color-data-viz-axis`），宽度大于 0；提示里只有合计一行，不列任何模型 |

后置：无。

#### `TC-CORE-142` 设置三节与旧地址 — 对应 `REQ-CORE-039`、`REQ-CORE-046`、`REQ-CORE-047`、`REQ-AGENT-002`（`PAGE-CANVAS` 设置弹层，v1.24）· 级别: 回归 · 执行者: AI

前置：`pnpm seed`；打开 `Demo Mobile`。
脚本 `tests/e2e/settings.ts`（`ONLY=TC-CORE-142`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 依次打开 `?settings=runners`、`?settings=appearance`、`?settings=language`、`?settings=record`、`?settings=xyz` | 前一个开「模型」、地址换成 `settings=models`；中间三个开「系统」、地址换成 `settings=system`；最后一个开「用量」 |
| 2 | 在「系统」里看四组，选「深色」，再选 English | 四组小标题依次是外观、语言、协作、使用记录；选深色后 `<html>` 带深色标记；换 English 后左栏是 Usage / Models / System，不刷新页面 |
| 3 | 焦点放在左栏「用量」，按两次 `↓` | 「系统」选中，地址 `settings=system`；换节时右栏有 150 ms 的淡入 |
| 4 | 切到「模型」，看最下面的 MCP 接入 | 两条可复制命令（`mcp-add`、`codex-mcp-add`），点「复制」提示已复制 |
| 5 | 按 `Esc` 关闭；按工具栏「设置」，再按 `Esc` | 关闭后焦点落在工具栏「设置」；从它打开时落在「用量」（`settings=usage`），关闭后焦点回到它 |

后置：语言改回中文、外观改回跟随系统。

#### `TC-CORE-143` 界面上「通道」都叫「模型」 — 对应 `REQ-CORE-011`、`REQ-CORE-013`（§4 术语「通道」，v1.24）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed`；打开 `Demo Mobile`。
脚本 `tests/e2e/settings.ts`（`ONLY=TC-CORE-143`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 中文界面下依次打开设置「模型」节、「添加模型」弹层、输入框的模型下拉，各读一次页面文字 | 三处都没有「通道」二字；左栏与按钮写「模型」「添加模型」，下拉底部写「管理模型…」 |
| 2 | 换成 English 后同样三处 | 都没有 channel（不分大小写），写 Models / Add model / Manage models… |
| 3 | 带 `X-Quilt-Locale: zh` 与 `en` 各建一条指定了不存在通道 id 的作业 | 都是 `404`，中文标题里没有「通道」，英文标题里没有 channel |

后置：语言改回中文。

#### `TC-CORE-144` 使用记录开关与状态 — 对应 `REQ-CORE-047`（`API-CORE-049`、`API-CORE-050`，v1.22 / v1.24）· 级别: 回归 · 执行者: AI

前置：隔离测试栈，开关关着、没有任何记录（种子不清使用记录：脚本把 `record_events`、`model_calls` 删空，默认用户的 `record_usage` 置 false、`record_since` 置空，删掉对象目录下的 `records/`）；打开 `Demo Mobile` 的设置「系统」。
脚本 `tests/e2e/record.ts`（`ONLY=TC-CORE-144`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `GET /v1/record` | `200 { enabled:false, since:null }`，三个计数都是 0，`dir` 是本机绝对路径 |
| 2 | 在「系统」里打开「使用记录」 | 发出 `PATCH /v1/record {enabled:true}`；开关显示开；`since` 是刚才的时间；`record_events` 多一条 `type=record`；下面两行写条数、占用与存放位置 |
| 3 | `PATCH /v1/record {enabled:"yes"}` | `400 /errors/validation`，开关不变 |
| 4 | 带 `Origin: http://evil.example` 调 `GET /v1/record`、`PATCH /v1/record`、`POST /v1/record/events` | 都是 `403 /errors/forbidden`，开关与条数不变 |
| 5 | 在界面上关掉开关 | `enabled=false`，`since` 不变；条数与位置两行照样显示 |
| 6 | 再打开 | `since` 换成新的时间 |

后置：关掉开关。

#### `TC-CORE-145` 事件批的写入：开关、去重与上限 — 对应 `REQ-CORE-047`（`API-CORE-051`，v1.22）· 级别: 回归 · 执行者: AI

前置：隔离测试栈。
脚本 `tests/e2e/record.ts`（`ONLY=TC-CORE-145`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 开关关着，`POST /v1/record/events` 一批 3 条 | `204`；`record_events` 条数不变 |
| 2 | 打开开关，同一个 `sessionId` 发 `seq` 1～3 | `204`；多 3 条，`source=web`、`user_id` 是默认用户、`at` 是请求里给的 |
| 3 | 把第 2 步那批原样再发一次 | `204`；条数不变 |
| 4 | 发 201 条；发一条序列化后超过 16 KB 的；发一条 `type` 不在枚举里的 | 都是 `400 /errors/validation`，整批不写 |
| 5 | 发一条 `data` 里有 2500 字字符串的 | 写进去的这一项只有长度，没有原文 |
| 6 | 关掉开关后用另一个 `sessionId` 发一批 | `204`；条数不变 |

后置：关掉开关。

#### `TC-CORE-146` 浏览器采集：点击、输入、断线重发与密钥框 — 对应 `REQ-CORE-047`（`API-CORE-051` 浏览器端，v1.22）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：隔离测试栈；建一条验证过的 OpenAI 兼容桩通道（§3：stub 轮次从输入框发一轮要它，新打开的页面缺省选中它）；打开开关；打开 `Demo Mobile`。
脚本 `tests/e2e/record.ts`（`ONLY=TC-CORE-146`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点工具栏「屏列表」；在输入框里打「做一个登录页」，停 2 s；发送 | 10 s 内 `record_events` 里依次有这次点击（`target` 是按钮的 `data-testid` 或名字）、一条 `type=input` 且 `data` 是全文「做一个登录页」、一条发送 |
| 2 | 打开设置「模型」→「添加模型」，在 API Key 框里填 `sk-test-SECRET-123` 再取消 | 整张 `record_events` 里搜不到 `SECRET-123` |
| 3 | 拦下 `POST /v1/record/events` 让它连不上，点 3 下工具栏按钮，等 6 s；放开拦截，再等 6 s | 放开后这 3 次点击写进库；同一 `sessionId` 的 `seq` 从 1 起连续、没有缺号 |
| 4 | 在设置里关掉开关，再点 3 下 | 之后没有新的点击事件 |

后置：关掉开关。

#### `TC-CORE-147` 模型调用的记录 — 对应 `REQ-CORE-047`（`ENT-ModelCall`，v1.22）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：隔离测试栈；打开开关；`pnpm seed:project --name Rec --device mobile --screens 1 --no-shot`；两条验证过的 OpenAI 兼容桩通道：一条照常回（造屏都用它），一条验证之后每次回 503（第 2 步）；第 3 步用假会话（§3「本机 agent」）。
脚本 `tests/e2e/record.ts`（`ONLY=TC-CORE-147`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 在 Rec 里造 1 屏 | `model_calls` 多至少一行，`job_id` 是这次作业；`body_key` 指向的 JSON 里有发给模型的完整提示词与模型的原始回复 |
| 2 | 用一个会报错的 stub 模型造 1 屏 | 作业失败；`model_calls` 那一行带错误与重试次数 |
| 3 | 把一次改屏交给本机会话（假会话） | `model_calls` 一行 `purpose` 是投递，正文是投递出去的那段指令 |
| 4 | 把对象存储里的 `records/` 设为只读，再造 1 屏；恢复权限 | 作业照常成功；API 日志有一行记录失败 |
| 5 | 关掉开关再造 1 屏 | `model_calls` 不再增加 |

后置：关掉开关，恢复 `records/` 权限。

#### `TC-CORE-148` MCP 调用的记录 — 对应 `REQ-CORE-047`（`API-AGENT-002`，v1.22）· 级别: 回归 · 执行者: AI

前置：隔离测试栈；打开开关；MCP 客户端连上本机 `/mcp`。
脚本 `tests/e2e/record.ts`（`ONLY=TC-CORE-148`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 调 `quilt.list_projects` | `record_events` 多一行 `source=mcp`、`type=tool`，`data` 里有工具名、成败与耗时 |
| 2 | 调 `quilt.validate_screen`，`html` 是 3000 字 | 这一行 `data` 里的 `html` 只有长度 |
| 3 | 关掉开关再调一次 `quilt.list_projects` | 不再增加 |

后置：关掉开关。

#### `TC-CORE-149` 删除时留归档 — 对应 `REQ-CORE-047`（`API-CORE-018`、`API-CORE-031`，v1.22）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：隔离测试栈；打开开关；`pnpm seed:project --name Arch --device mobile --screens 3`（带截图）；第 6 步要 `QUILT_E2E_RESTART`。
脚本 `tests/e2e/record.ts`（`ONLY=TC-CORE-149`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 删 /s3 | `204`；`records/archive/<今天>/screen-<id>/` 下有清单与这屏每个修订的 HTML、截图 |
| 2 | 经接口在草稿本里发一个新草稿（带 `[stub-hold:6000]`），生成中取消这个作业 | 空草稿被删掉，`records/archive/` 下多一份它的归档 |
| 3 | 把 `records/archive/` 设为只读，删 /s2；恢复权限 | 删除照常 `204`；API 日志有一行归档失败 |
| 4 | 删项目 Arch | `204`；`records/archive/<今天>/project-<id>/` 下有清单与 `projects/<id>/` 的全部对象 |
| 5 | 关掉开关，另建一个项目再删掉 | 不留归档 |
| 6 | 触发一次 `storage.gc`：另建一个项目导出一次，把导出文件的修改时间拨回 25 小时前，重启 API（启动 1 分钟后先扫一轮，同 `TC-CORE-090`），等那份导出被清掉 | `records/` 下的文件一个不少 |

后置：关掉开关，恢复权限。

### CORE · 协作显示与作业完成

v1.32 协作显示与 v1.33 作业完成 chip 的用例都在 `tests/e2e/collab.ts`（`e2e:collab`）。
「几个人」是同一浏览器里几个不带预置身份的上下文（`lib.ts` 的 `bareContext`），各自往 `localStorage` 的 `quilt:me` 记一个人：甲（颜色 1）、乙（颜色 3）、丙（颜色 5）。
从输入框发改屏用套件开头建的 OpenAI 兼容桩通道「协作桩」（3962 端口），验证请求不拖、其余拖 4 s，好在作业进行中看「正在改」。
前置共用：`pnpm seed`；`pnpm seed:project --name Collab --device mobile --screens 3 --no-shot`；视口 1440×900。

#### `TC-CORE-153` 第一次打开填名字 — 对应 `REQ-CORE-048`（`PAGE-CANVAS`「协作者」身份，v1.32）· 级别: 回归 · 执行者: AI

前置：丙（颜色 1，已记名字）先打开 Collab；再开一个不带名字的上下文。
脚本 `tests/e2e/collab.ts`（`ONLY=TC-CORE-153`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 不带名字的上下文打开 Collab，按 `Esc` | 弹出「你叫什么」（`collab-name-dialog`），「开始」`aria-disabled=true`；`Esc` 后对话框还在 |
| 2 | 名字填「  甲  」，点「开始」 | 填后「开始」可用；对话框关掉；`quilt:me` 记下 `name=甲`（去掉首尾空格）、`color=2`（跳过在线的丙用着的 1）、`id` 是 UUID；丙的顶栏 5 s 内出现「甲」的头像 |
| 3 | 刷新页面；再打开草稿本 `/sketch` | 都不再弹对话框 |
| 4 | 打开设置「系统」，「协作」组里名字改成「甲二」点「保存」，颜色选第 5 个 | `quilt:me` 变成 `name=甲二`、`color=5`，`id` 不变；丙那边的头像 5 s 内换成「甲二」 |

后置：关掉两个上下文。

#### `TC-CORE-154` 两人同开一个项目：头像、光标、选中、拖卡、跟随、离开 — 对应 `REQ-CORE-048`（`PAGE-CANVAS`「协作者」，`API-CORE-053`，v1.32）· 级别: 回归 · 执行者: AI

前置：甲、乙各开一个上下文打开 Collab。
脚本 `tests/e2e/collab.ts`（`ONLY=TC-CORE-154`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 甲看顶栏右侧 | 恰好一个头像（`peer-avatar`），`data-name=乙` |
| 2 | 乙在画布上移动指针 | 2 s 内甲这边出现乙的光标（`peer-cursor`，`data-name=乙`，不 `hidden`），上面写「乙」 |
| 3 | 乙单击选中 /s1 | 甲这边出现一道描边（`peer-outline`），左上角与 /s1 卡的位置一致；/s1 卡右上方挂「乙」的标签（`peer-chip`） |
| 4 | 乙按住 /s2 拖 180 px 再松手 | 拖动中甲这边的 /s2 跟着右移超过 20 px；松手后 5 s 内甲、乙两边 /s2 的位置一致，且等于 `GET /v1/projects/<id>` 里的位置 |
| 5 | 甲点乙的头像；乙用滚轮平移画布；甲自己滚一下滚轮；甲再点头像跟随、焦点离开后按 `Esc` | 跟随时头像 `aria-pressed=true`，视口四周有描边（`follow-frame`），写「正在跟随 乙」；乙平移后 3 s 内甲的世界层 `transform` 变了；甲自己滚动后描边消失、头像不再 `aria-pressed`；`Esc` 同样停止跟随 |
| 6 | 甲再跟随乙，然后乙关掉页面 | 15 s 内甲这边乙的头像消失，光标、描边、跟随描边都不在；提示条写「乙 已离开」 |

后置：关掉两个上下文。

#### `TC-CORE-155` 屏内光标与「正在改」 — 对应 `REQ-CORE-048`（`PAGE-CANVAS`「协作者」聚焦与正在改，v1.32）· 级别: 回归 · 执行者: AI

前置：甲、乙各开一个上下文打开 Collab（接着 `TC-CORE-154` 跑时 /s2 已被挪过，不影响）。
脚本 `tests/e2e/collab.ts`（`ONLY=TC-CORE-155`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 乙双击 /s1 进交互，在屏里移动指针 | 甲这边 /s1 卡上标「乙 · 交互中 /s1」；3 s 内乙的光标落在甲这边 /s1 卡的框里 |
| 2 | 乙按 `Esc` 退出交互，输入框选「协作桩」，选中 /s2 发「改成深色」 | 作业进行中（桩拖 4 s）甲这边 /s2 卡上标「乙 正在改」；作业结束后 30 s 内这枚标签撤掉 |

后置：关掉两个上下文。

#### `TC-CORE-156` 草稿本里的协作者 — 对应 `REQ-CORE-048`（`PAGE-SKETCH`「协作者」，v1.32）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：经 `POST /v1/projects/<草稿本>/messages`（`runner` 为 stub）建两张手机草稿「一个登录页」（草稿 1）、「一个设置页」（草稿 2）；甲打开草稿 2，乙打开草稿 1。
脚本 `tests/e2e/collab.ts`（`ONLY=TC-CORE-156`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 甲看记录栏 | 草稿 1 的缩略图角上有一个小头像（`rail-viewers`） |
| 2 | 甲点乙的头像 | 甲的看板换到草稿 1（`?d=` 是草稿 1） |
| 3 | 乙在草稿上移动指针 | 3 s 内甲这边出现乙的光标 |
| 4 | 乙输入框选「协作桩」，发「改成深色」 | 作业进行中甲这边画框上方标「乙 正在改」 |
| 5 | 作业结束后，乙开「选元素」点草稿里的第一个标题或段落 | 甲的草稿 iframe 里出现一个 `[data-quilt-peer]` 框，上面写「乙」；块贴着草稿顶部时名字在框里，不被画框裁掉 |
| 6 | 乙在记录栏点开草稿 2；甲再自己点开草稿 1 | 甲的看板跟着换到草稿 2；甲点草稿 1 后留在草稿 1，头像不再 `aria-pressed` |

后置：关掉两个上下文。

#### `TC-CORE-159` 链式跟随与互相跟随 — 对应 `REQ-CORE-048`（`PAGE-CANVAS`「协作者」链式跟随与互相跟随，`API-CORE-053` 的 `following`，v1.32）· 级别: 回归 · 执行者: AI

前置：甲、乙、丙各开一个上下文打开 Collab，视口都是 1440×900，互相看到头像。
脚本 `tests/e2e/collab.ts`（`ONLY=TC-CORE-159`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 乙点丙的头像，甲点乙的头像；丙用滚轮平移画布 | 甲的横幅写「正在跟随 乙 · 乙在跟随 丙」，乙的头像 `aria-pressed=true`；丙平移后 3 s 内甲的世界层 `transform` 变了，且与乙的完全相同（两人都直接看丙的视野） |
| 2 | 乙改点甲的头像 | 跟随连成一圈：甲收到提示「乙 也在跟随你，你已停止跟随乙」，甲的跟随描边消失、乙的头像不再按下；乙的横幅写「正在跟随 甲」；之后 2 s 内甲、乙的世界层 `transform` 都不变 |
| 3 | 乙按 `Esc` 停止跟随；甲、乙同时点对方的头像 | 4 s 内两人里恰好一个还在跟随（跟随描边合计 1 个） |

后置：关掉三个上下文。

#### `TC-CORE-157` 作业完成的 chip：任务完成、悬停停表、10 秒淡出 — 对应 `REQ-CORE-020`（`PAGE-CANVAS`「作业 chip」，v1.33）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：甲打开 Collab；改屏都经 `POST /v1/projects/<id>/messages` 发给 /s1（等价于别处发起的一轮），`runner` 为 stub，内容带 `[stub-hold:<毫秒>]` 拖住。
脚本 `tests/e2e/collab.ts`（`ONLY=TC-CORE-157`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 发一轮改屏（拖 1.5 s） | 输入框上方出这个作业的 chip，`data-state=running` |
| 2 | 等作业成功 | 同一枚 chip 转成 `data-state=succeeded`：结果句是「任务完成 · 改「Screen 1」」，圆形对勾的动画是 `job-done-pop`；没悬停时 ×（`dismiss-job`）透明度为 0；宽度收窄到正好包住对勾与文字（chip 右缘与文字右缘相距 ≤ 16 px），比在跑时窄，左缘与在跑时相同（v1.36） |
| 3 | 悬停在 chip 上，一直停到成功后 11 s | × 透明度变成 1，chip 向右展开（变宽 ≥ 28 px，左缘不动）；11 s 时 chip 还在 |
| 4 | 指针移开 | 3 s 后 chip 还在；12 s 内淡出撤掉 |
| 5 | 再发一轮（拖 0.5 s），成功后悬停、点 × | 1 s 内 chip 撤掉 |
| 6 | 换一个「减少动态效果」的上下文打开 Collab，再发一轮 | 完成 chip 上的对勾没有动画（`animation-name: none`） |

后置：关掉上下文。

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
| 3 | 查看 /s1 到 /s2 的正常链接 | `app-map` 中该边 `toScreenId` 为 /s2 屏 id；双击 /s1 进入交互时画出连到 /s2 的连线（v1.29 起平时不画） |

后置：无。

#### `TC-PROTO-003` 改路由后地图重派生 — 对应 `REQ-PROTO-002` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-PROTO-002` 的项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `PATCH /v1/screens/<s2 屏>`，body `{"route":"/settings"}` | HTTP 200，`screen.route` 为 `/settings` |
| 2 | curl `GET /v1/projects/<id>/app-map` | 原断链边 `toScreenId` 变为 /s2 屏 id |
| 3 | 刷新画布 | 红色断链标记消失；双击 /s1 进入交互时画出这条连线 |
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
| 2 | 等作业完成 | 浏览器自动下载 `GET /v1/jobs/<id>/export`，建议文件名是 `Export - Prototype.html` |
| 3 | 断网后用浏览器打开该文件 | 显示 /s1 内容；点击链接后 URL hash 变为 `#/s2` 且内容切换；6 屏均可到达 |
| 4 | 对比导出文件中 /s1 的截图与画布上 /s1 的截图 | 主色、布局一致（视觉比对留证据截图） |
| 5 | `PATCH /v1/projects/<id>` 把项目名改成 `健身/打卡`，浏览器再下载同一个作业的导出 | 响应头带 `filename*=UTF-8''`；建议文件名是 `健身_打卡 - Prototype.html`（下载时取当前项目名，`/` 换成 `_`） |

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

#### `TC-PROTO-008` 画布连线显示与开关（已废弃：v1.29 连线只在交互时画）— 对应 `REQ-PROTO-002` · 级别: 回归 · 执行者: 皆可

已废弃，不再执行：连线平时不画、只在一屏进入交互时画这一屏进出的（设计文档 v1.29），见 `TC-PROTO-014`。以下是废弃前的步骤，留作对照。

前置：先执行 `TC-PROTO-007`（Form 项目）；打开该项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 查看画布 | 卡片之间有带箭头的连线：连线 canvas（`data-testid=link-edges`，v1.02 起不是 SVG）的 `data-drawn` ≥ 4（s1→s2、s1→s3、s2→s3、s3→s1），同一对屏合并为一条并标注条数，`data-max-count` ≥ 3；canvas 上有画出来的像素 |
| 2 | 点工具栏「连线」 | 连线全部消失；/s1 卡片上的「断链 /settings」标记仍在 |
| 3 | 再点「连线」 | 连线恢复；刷新页面后开关状态保持 |

后置：无。

#### `TC-PROTO-009` 接上跳转修复轮 — 对应 `REQ-PROTO-002` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Repair --device mobile --screens 2 --unlinked`（/s1 含无跳转目标的主按钮「Continue」）；打开（真实 LLM）；记录 `app-map` 边数。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 不选中任何屏，点工具栏「接上跳转」 | 提示「正在为 2 屏接上跳转」（未选中时作用于全部屏）；对话面板出现该作业，这一轮的描述是「接上跳转：把 2 屏的按钮 / 表单连上路由」 |
| 2 | 等待作业完成（≤ 240 s） | 对话面板显示「已生成」；/s1 新修订里「Continue」变为带 `href` 或 `data-href="/s…"` 的导航元素 |
| 3 | curl `GET /v1/projects/<id>/app-map` | 边数比前置记录多 |
| 4 | 只选中 /s1 后再点「接上跳转」 | 提示「正在为 1 屏接上跳转」；该作业的 `screenIds` 只含 /s1 |

后置：无。

#### `TC-PROTO-010` 未设计的交互只提示不跳转 — 对应 `REQ-PROTO-001` · 级别: 回归 · 执行者: 皆可

前置：先执行 `TC-PROTO-007`（Form 项目，/s1 含 `href="#"` 的「Coming soon」链接）；打开该项目。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击 /s1 聚焦，点「Coming soon (not designed)」 | iframe 仍显示 /s1（标题不变、`iframe` 未重建）；画布出现 toast「这个交互还没有设计…」 |
| 2 | curl `GET /v1/projects/<id>/app-map` | `edges` 中没有 `href="#"` 的边 |

后置：按 Esc 退出交互。

#### `TC-PROTO-011` 聚焦屏内捏合缩放画布 — 对应 `REQ-PROTO-001` · 级别: 回归 · 执行者: 皆可

前置：同 `TC-PROTO-010`；聚焦 /s1 后记录画布缩放（世界层 `transform` 的 `scale`）与 `window.scrollY` / `visualViewport.scale`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 指针在 iframe 内触发带 ctrlKey 的 wheel（deltaY = −100，触控板捏合放大） | 画布缩放上升；`visualViewport.scale` 仍为 1，`window.scrollY` 仍为 0，顶栏可见 |
| 2 | 同样操作 deltaY = +100 | 画布缩放回落 |

后置：按 Esc 退出交互。

#### `TC-PROTO-012` 叠层屏 — 对应 `REQ-PROTO-005`（v0.63）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Overlay --device mobile --screens 3`（fixture 里 /s1 → /s2 → /s3 互链）；打开项目，等截图出现。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点 /s2 卡片 → 工具栏「设为叠层」（`toggle-presentation`） | toast「已设为叠层屏」；/s2 卡片带 `overlay` 类与「叠层」片；`GET /v1/projects/{id}` 里 `presentation=overlay`；`GET` 它的 `previewUrl` 得到的文档含 `<style data-quilt-overlay>` |
| 1b | `POST jobs kind=generate { variantOf: /s2, variantName: err }`（stub） | 作业成功，变体继承 overlay |
| 2 | 双击 /s1 聚焦，点「Go to /s2」 | 角标 /s2；iframe 里多一层 `[data-quilt-overlay-layer="/s2"]`（内含 Screen 2 的 h1），底下 Screen 1 的 h1 仍在；iframe 未重建 |
| 3 | `Alt+←` | 叠层消失，角标回 /s1 |
| 4 | 再点「Go to /s2」，在层里点「Go to /s3」 | 层清空，DOM 换成 Screen 3，角标 /s3 |
| 5 | `Alt+←` | 角标 /s2；iframe 里底下是 Screen 1、上面压一层 `/s2`（后退按导航栈重摆，v0.65） |
| 5b | 在层里点指向 `/s1` 的链接 | 叠层消失、角标 /s1、底下仍是 Screen 1（叠层里指回来处的链接是关闭，不是再跳一次） |
| 5c | 经 MCP `patch_screen` 给 /s1 加 `<p id="ran">no</p><script>…textContent="yes"</script>` | 15 s 内 iframe 里 `#ran` 变成 `yes`（热更新换进来的脚本会执行） |
| 5d | 把脚本改成顶层 `const ranText = "yes"` 的写法，再 `patch_screen` 一次改别处 | 两次热更新后 `#ran` 都是 `yes`（同一个 window 里第二次执行顶层 `const` 不报已声明） |
| 5e | 打开 /s2 叠层；在 iframe 里向自己发 `quilt:mark { working: [q1] }`；清掉标记后经 MCP 改 /s1；`Alt+←` | 带虚线描边的 q1 在叠层里；关层后底下的 /s1 是新版本 |
| 5f | 再打开 /s2，点状态胶囊「err」；`Alt+←` | 仍只有一层叠层、层内容换成变体、底下 /s1 还在；后退后层消失 |
| 6 | `POST jobs kind=export_prototype` → 下载 | 单文件里 /s2 的 `<template>` 带 `data-presentation="overlay"`，运行时含 `data-quilt-overlay-layer` 的压层逻辑 |
| 6b | 把导出的单文件用浏览器打开，hash 依次 `#/s1` → `#/s2` → `#/s3` → `history.back()` → `history.back()` | 每步的叠层数与 `#quilt-root` 标题依次为 0·Screen 1、1·Screen 1、0·Screen 3、1·Screen 1、0·Screen 1 |
| 6c | 新开一页直接打开 `导出文件#/s2`，再 `history.back()` | 先是 1 层叠层、底下 Screen 1；后退后 0 层、仍是 Screen 1，页面没离开这个文件 |

后置：无。

### EDIT · 元素编辑与设计系统


#### `TC-PROTO-013` 接上跳转超过 20 屏分批全发 — 对应 `REQ-PROTO-002`（v1.03）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name RepairMany --device mobile --screens 25 --no-shot`；打开，什么都不选。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点工具栏「接上跳转」 | toast「正在为 25 屏接上跳转（分 2 批）」；`GET /v1/projects/<id>/jobs` 里有两个 `edit_screens` 作业，各 20 屏与 5 屏，合起来覆盖全部 25 屏；两个作业都跑完 |

后置：无（项目随下一次 `pnpm seed` 清掉）。

#### `TC-PROTO-014` 连线只在交互时显示 — 对应 `REQ-PROTO-002`（`PAGE-CANVAS`「连线」，v1.29）· 级别: 回归 · 执行者: AI

前置：先执行 `TC-PROTO-007`（Form 项目：/s1 的表单提交到 /s2、`data-href` 按钮到 /s3，另有断链 /settings）；视口 1440×1000；打开该项目。期望条数由脚本按 `app-map` 把同一对屏合并后算。
脚本 `tests/e2e/proto.ts`（`ONLY=TC-PROTO-007,TC-PROTO-014`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 查看画布 | 没有连线 canvas（`data-testid=link-edges`）；/s1 卡片上的断链 /settings 标记照常显示 |
| 2 | 双击 /s1 进入交互，期间逐帧记连线 canvas 的 `data-state` | canvas 出现，`data-screen` 是 /s1、`data-drawn` 等于 /s1 进出的屏对数；`data-state` 先是 `growing`，1 s 内变成 `done`；canvas 上既有标记色的像素（/s1 链去的线），也有三级文字色的像素（链回 /s1 的线） |
| 3 | 在 /s1 的 email 框填「a@b.co」，点「Sign in」跳到 /s2 | `data-screen` 换成 /s2，`data-drawn` 等于 /s2 进出、另一端不是 /s1 的屏对数；这个数为 0 时 canvas 撤掉 |
| 4 | 按 `Esc` 退出交互 | 连线 canvas 撤掉 |
| 5 | 点工具栏「连线」关掉，双击 /s1 进入交互；`Esc` 退出后刷新页面 | 进交互 1 s 后仍没有连线 canvas；断链标记仍在；刷新后「连线」仍是关（`aria-pressed=false`） |
| 6 | 点「连线」打开；以减弱动态（`reducedMotion: reduce`）双击 /s1 | 连线 canvas 第一次出现时 `data-state` 就是 `done`，没有 `growing` |

后置：退出交互，「连线」开着。

#### `TC-EDIT-001` 元素文案本地直改零 token — 对应 `REQ-EDIT-001` · 级别: 回归 · 执行者: 皆可

前置：`pnpm seed:project --name Edit --device mobile --screens 1`（fixture 含文案「登录」的按钮，qid 由响应可查）；打开；记录 `GET /v1/me/usage`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 不选中任何屏，按 `⌘E` 开启选择元素模式，再单击卡片进入，点击「登录」按钮元素 | 按键即开模式（不必先选中屏）；进入后卡片角标显示「选择元素中」而非「交互中」；元素上出现常驻选中框（`[data-quilt-selection]`，标签写 `button · <qid>`），鼠标移开仍在；右侧检查器显示其文案与样式字段 |
| 2 | 把文案改为「立即登录」，回车 | 800 ms 内卡片内文案变为「立即登录」；iframe 不重挂（`src` 与进入时相同，角标仍「选择元素中」）；检查器仍选中同一元素且「文案」字段已刷成「立即登录」（热更新后按 qid 重选，不退回空态），选中框仍在该元素上，元素出现「已更新」角标（`[data-quilt-mark][data-kind=done]`，4 s 后自撤）；`POST /v1/screens/<id>/elements/<qid>` 返回 201，`revision.sourceKind` 为 `manual` |
| 3 | curl `GET /v1/me/usage` | tokens 与前置记录完全相同 |
| 4 | 等待至多 10 s | 卡片截图更新为新文案 |

后置：无。

#### `TC-EDIT-002` 直改引入违规样式：照样落修订、违规记进 lintReport — 对应 `REQ-EDIT-001`（`ADR-005` v0.43）· 级别: 回归 · 执行者: 皆可

前置：同 `TC-EDIT-001` 项目；记录当前 revisionId 与修订数。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | curl `POST /v1/screens/<id>/elements/<qid>`，body `{"ops":[{"type":"style","value":"color:#ff0000"}],"expectedRevisionId":"<当前>"}` | HTTP 201，返回的修订 `lintReport.violations[]` 指出裸色值或内联样式 |
| 2 | curl `GET /v1/screens/<id>/revisions` | 修订数多 1 |
| 3 | 以第 1 步的新修订为基线，把类名改成 token 类 | 返回 201，新修订生效 |

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

#### `TC-EDIT-008` 元素批注攒批发送（已废弃：v1.23 撤下批注）— 对应 `REQ-EDIT-004` · 级别: 回归 · 执行者: AI

已废弃，不再执行：批注整体撤下（设计文档 v1.23）。以下是废弃前的步骤，留作对照。

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
| 1 | 画布选桩通道，`⌘A`，发送「所有页面正文字再大一点」，等这个 `edit_screens` 作业成功 | 设计系统 `version` 不变（`⌘A` + 发送 = 普通改全部，不碰设计系统） |
| 2 | `⌥D` 打开设计系统面板，在「用一句话改设计系统」（`ds-instruction`）填同一句，点「提炼并预览」（`ds-propose`） | 创建 `kind=propose_design_system` 作业，`input.instruction` 为这句话；作业成功后弹预览（`ds-proposal`）：2 条可勾选的约定，文案是绝对规则、不含「再大一点」 |
| 3 | 点「确认写入」（`ds-proposal-confirm`）→ 出现「按新约定重生成所有屏？」→ 点「不重生成」（`ds-proposal-write-only`） | 点「确认写入」时即发 `PUT design-system` 带 `conventions`（v0.78）；DESIGN.md 出现 `## 约定` 节且含那两条；`version+1`；「不重生成」不建 `edit_screens` 作业；设计系统面板（`ds-conventions`）列出 2 条 |
| 4 | 在面板删除第 1 条，确认框里点「删除」（v1.03） | 剩 1 条；`version` 再 +1 |

后置：删除用例创建的通道；桩服务关闭。

#### `TC-EDIT-010` 品牌色板 — 对应 `REQ-EDIT-005`（v0.35）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name Palette --device mobile --screens 2 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 读新项目的 `designSystem.tokens.colors` | 含 `success` / `onSuccess` / `warning` / `onWarning`（没挂色板也有语义色）；新建项目默认挂中性色板（v0.92，`ADR-028`），`background` 为 `NEUTRAL_PALETTE.light.background`（`#fafafa`） |
| 2 | `PUT design-system` 带 `palette.light = {primary:#284CCA, background:#F4F1EA, success:#1D7153}` | `200`、`version+1`；这三键取原值，`secondary` 等没覆盖的键与第 1 步一致 |
| 3 | 跑 `apply_design_system screenIds=all` | 作业成功；新修订的 prelude 含 `--color-primary:#284CCA` 与 `--color-success:#1D7153`，`<body>` 内容与回刷前逐字相同 |
| 4 | 没有 `palette.dark` 时 `PUT colorMode=dark` | `400 /errors/validation`，消息说明要先给 `palette.dark` |
| 5 | `PUT` 带 `palette.dark`（只覆盖 `primary`）且 `colorMode=dark` | `200`；`tokens.colors.primary` 为暗色色板的值；**未覆盖键取 Material 暗色方案**（v0.38）：`surfaceVariant` 是暗值（如 `#45464f`，不是亮色的 `#e2e1ec`），`text-on-surface-variant` 压在 `bg-surface-variant` 上的对比度 ≥ 4.5:1；语义色也切到暗档（`success` 亮、`onSuccess` 深，与 `error`/`onError` 同规则） |
| 5b | 存量仍是 `colorMode=dark` 时只 `PUT {palette:null}`（不带 `colorMode`）；另起一次 `PUT {palette:{light:{primary},dark:{}}}`（不带 `colorMode`）；再显式 `PUT {colorMode:"dark"}`（此时无暗色色板）（v0.38） | 前两次都 `200`、`version+1`、落库 `colorMode=light` 且 `tokens` 是纯亮色派生（撤掉暗色色板就回落亮色——否则面板的亮 / 暗段控消失、模式却停在暗，用户没有退路；`dark:{}` 等同于没有暗色色板）；第三次仍 `400 /errors/validation`（`path=colorMode`） |
| 6 | `PUT palette=null, colorMode=light` | `200`；`tokens.colors` 回到纯种子派生值 `tokensFromSeed(seedColor,{colorMode:"light"})`（v0.92 起不等于第 1 步：第 1 步挂着中性色板） |
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
| 7a | 卡片报完尺寸（`data-ready`）后，在组件卡 iframe 里给根元素加 `backdrop-blur-xl` 类，再往根里插一个文档流里的 `backdrop-blur-md` 层、一个压在渐变块上的 `absolute backdrop-blur-md` 层，等 300 ms 读计算样式（v0.73，v0.76 收窄范围） | 根元素与文档流里那层的 `backdrop-filter` 为 `none`（组件预览文档关掉了它们的背景模糊，Tailwind 生成的规则压不过它）；absolute 那层是 `blur(…)`——它背后是组件自己的内容，关掉就与屏里不一样 |
| 8 | （真实 LLM）目标为 `TabBar` 组件，输入框发「把第二个 tab 的文案改成 Search，其他都别动」 | `POST messages` 带 `targetComponentIds=[cid]`，作业 `kind=edit_component`；作业 chip 写「改组件「TabBar」」；作业成功后组件 `version+1`、`summary` 含 `Search`，用它的每一屏各出一条 `sourceKind=component`、`jobId=本作业` 的新修订且 HTML 含 `Search`；助手消息以「已更新组件「TabBar」」开头并写「同步 N 屏」 |
| 9 | 双击画布上的组件卡；按 `Esc`（v0.53 组件卡可交互） | 镜头摆到卡片上（v1.23，位置与缩放的判定见 `TC-CORE-139`）；卡片带 `focused`、手势罩 `.gesture` 已移除、iframe 的 `pointer-events` 为 `auto`（组件里的按钮点得动）、右上出现呼吸绿点（`.live-dot`，`aria-label="交互中"`，8 px、`sk-pulse` 动画，不透明度在变）；此时双击一张屏卡进交互，组件的 `focused` 自动退掉（两态互斥）；`Esc` 退出交互态（焦点在组件 iframe 内按也有效）。再往组件里塞一个 `href="#"` 的链接并点它（v0.55 链接惰性）：不出现任何 toast、iframe 也不跳走 |
| 10 | 目标为该组件，发「顶部一级频道导航：关注 / 推荐 / 附近 / 活动，默认选中「推荐」，点任意一条要真切换」；产出按组件预览文档渲染后点第 3 条（v0.54 组件交互契约） | 产出通过 `validateComponentHtml`（单根、无 `<script>`）；HTML 里每条是 `<label>` 且首个孩子是 `type="radio" class="peer sr-only"`、`name` 带组件名前缀，选中态全部写成 `peer-checked:` 变体、默认值只在 `checked` 上（**没有任何一条把选中样式硬编码进 class**），焦点环走 `peer-focus-visible:`，条目带 `data-slot` / `data-part`；渲染后点第 3 条：该条 `input.checked` 为 true、字重与字号升到选中档、indicator `opacity` 为 1，原选中项三项同时回落；容器高度前后一致（选中态变粗变大不得顶高）|
| 11 | 双击组件卡进交互态 → 按 `⌘E` → 点组件里某条 tab 的文字 → 检查器把「文案」改掉并保存（v0.57 组件选元素直改） | 检查器标题为「检查器 · <组件名>」；**文案框读得到那条文字**（组件把文字设成 `pointer-events:none` 时也要能选中——选择元素态临时解除这层限制）；面板里没有「用 AI 重生成这块」与「记为共享组件」，取而代之是一句指向「改组件」的说明（`el-component-hint`）；保存后组件 `version` +1、HTML 里那条文案已变、用它的屏被回刷；**同一条上与旧文案逐字符相等的 `aria-label` / `title` 跟着改，邻条的不受影响；与文案原本就不同的（图标按钮那种）一个字都不动**（v0.59）；`expectedVersion` 过期时报「组件已被更新」而不是静默覆盖。**退出路径逐条查残留**（`⌘E` 再按一次 / `Esc` / 双击另一个组件 / 点画布空白 / 带着选择态刷新 / 只进不选就退出）：组件文档里不得留下选中框、`tag · qid` 标签、`[data-qid]{pointer-events:auto}` 那条样式或 `crosshair` 光标——组件卡的 iframe 常驻，不像屏那样退出即卸载 |

后置：无。

#### `TC-EDIT-013` 设计系统提案的落库时机、分批重生成与面板草稿 — 对应 `REQ-EDIT-003`、`REQ-EDIT-005`（v0.78）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Proposal --device mobile --screens 21 --no-shot`（21 屏多于单个 `edit_screens` 的 20 屏上限）；建一条指向本地 OpenAI 兼容桩的「Stub 提案」并验证，桩对提炼请求第一次回一条约定、之后回两条，都带 `regenerate:true`；浏览器里拦下画布发的 `POST /v1/projects/{id}/jobs`，记下请求体，提炼作业改走桩通道、重生成作业改走 stub 驱动（缺省通道是真实模型）；视口 1440×1000。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `⌥D` 打开设计系统面板，读「应用简介」与 DESIGN.md 两个文本框的 `scrollbar-width` | 都是 `thin` |
| 2 | 种子色十六进制改成 `#123456`，DESIGN.md 末尾加一行「草稿里加的一行」，简介末尾加「简介草稿」；点面板「关闭」再 `⌥D`；再 `⌥S` 切到屏列表、`⌥D` 切回 | 两次回来三处改动都还在，版本行带「有未保存改动」 |
| 3 | 「用一句话改设计系统」写一句点「提炼并预览」；预览里点「确认写入」；看第二步；按 `Esc` | 点「确认写入」后（第二步还没点）`version+1`、DESIGN.md 含新约定；第二步焦点落在「不重生成」（`ds-proposal-write-only`）；`Esc` 关掉后约定仍在，没有建 `edit_screens` 作业；面板里 DESIGN.md 草稿带上了新约定、「草稿里加的一行」与 `#123456` 都还在 |
| 4 | 再提炼一次，「确认写入」后点「重生成 21 屏」 | 建出 2 个 `edit_screens` 作业，`screenIds` 各 20 与 1 屏，合起来正好 21 屏 |
| 5 | 等两个作业跑完，在面板里删掉第一条约定（确认框里点「删除」，v1.03） | 种子色仍是 `#123456`，DESIGN.md 草稿仍有「草稿里加的一行」、没有删掉的那条约定、有剩下的那条 |
| 6 | 点「放弃改动」 | 种子色与 DESIGN.md 回到已保存的值，版本行不再带「有未保存改动」 |
| 7 | 种子色十六进制改成已保存值的小写、字体名末尾加一个空格，DESIGN.md 开头加一行，点「保存」（出现「回刷所有屏？」就点「以后再说」；只差大小写 / 空格本身不算改动、「保存」不亮，所以带上 DESIGN.md 这一行，v0.83 见 `TC-EDIT-024`）；再把种子色改成 `#654321`，删掉剩下的那条约定（确认框里点「删除」） | 保存后 `version+1`；种子色显示为大写的已保存值、字体名没有尾随空格，版本行不带「有未保存改动」，「保存」置灰、没有「放弃改动」；删约定后种子色仍是 `#654321`（v0.78 审查修复） |

后置：删掉「Stub 提案」通道。

#### `TC-EDIT-014` 批注与检查器的草稿与失败态（已废弃：v1.23 撤下批注）— 对应 `REQ-EDIT-004`、`REQ-EDIT-001`、`REQ-EDIT-002`（v0.78）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

已废弃，不再执行，被 `TC-EDIT-038` 取代：第 1～5 步验的是批注，随批注撤下；第 6 步（检查器按元素暂存）改由 `TC-EDIT-038` 验。以下是废弃前的步骤，留作对照。

前置：`pnpm seed:project --name Drafts --device mobile --screens 1`；经接口给这一屏预置一条未处理批注「已有的一条」；浏览器里拦下 `POST …/annotations/send`（记请求体、回 `202 {jobs:[]}`，不建作业），`POST /v1/screens/{id}/annotations` 可切换成回 `422`；`⌥N` 进批注态并点进 `/s1`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点选 `#toggle`，说明框写「写了一半的批注」；点选标题 `h1`；再点回 `#toggle` | 换到 `h1` 时说明框是空的；点回 `#toggle` 时「写了一半的批注」还在 |
| 2 | 建批注回 `422`，点「记下（不发送）」 | toast「批注说明太长」；说明框里的草稿还在 |
| 3 | 仍回 `422`，点「记下并立刻发送」 | 没有发出 `annotations/send`；草稿还在 |
| 4 | 建批注恢复正常，点「记下并立刻发送」 | 发出一次 `annotations/send`，`annotationIds` 只有刚记下的那一条（不含预置的那条）；说明框清空 |
| 5 | `PATCH /v1/annotations/{id}` 回 `500`；对一条未处理批注点「改写」，改成「改写后的说明」点「保存」 | 改写框不关，内容还是「改写后的说明」 |
| 6 | 退出批注，`⌘E` 进选择元素；点选 `#toggle`，文案改成「改过但还没保存的文案」、「用 AI 重生成这块」写「改成横向卡片」；点选 `h1`；再点回 `#toggle` | 换到 `h1` 时文案是它自己的（`Screen 1 …`）、说明为空；点回 `#toggle` 时没存的文案与说明都还在 |

后置：无。

#### `TC-EDIT-019` 作业落地：取消后不写、在跑时改的组件落地用新版 — 对应 `REQ-EDIT-002`、`REQ-EDIT-006`（设计文档 §11 running→cancelled、§16 作业并行真值表 `edit_component` 两行，v0.79）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Landing --device mobile --screens 2 --no-shot`；把 `/s1` 的 `<nav>` 提成共享组件 `Nav` 并同步到两屏；作业一律显式带 `runner:{kind:"model",driver:"stub",model:"stub"}`，指令里写 `[stub-hold:<ms>]` 让桩在模型那一步停住（§3）。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-019`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 对 `/s2` 的标题建 `regenerate_subtree`，指令带 `[stub-hold:2500]`；0.6 s 时 `POST /v1/jobs/<id>/cancel`，再等 3.5 s | 取消 `200`，作业 `cancelled`；`/s2` 的 current 不变、没有这个作业的修订 |
| 2 | 对 `Nav` 发一轮改组件（`targetComponentIds`），指令带 `[stub-hold:2500]`；0.6 s 时取消，再等 3.5 s | 取消 `200`；组件 `version` 不变，两屏 current 不变（没有回刷） |
| 3 | 对 `/s1` 的标题建 `regenerate_subtree`，指令带 `[stub-hold:3000]`；0.8 s 时 `PATCH /v1/components/<Nav>` 换成带标记 `Mark079` 的两个 tab；等作业结束 | `PATCH` 回 `200`，`skipped` 含 `/s1`、`applied` 含 `/s2`；作业 `succeeded`，`/s1` 的 current 是它的 `subtree` 修订且 HTML 含 `Mark079`（落地前一刻重读组件）；`/s2` 也含 `Mark079` |

后置：无。

#### `TC-EDIT-022` 截图卡住时回刷作业照常收口 — 对应 `REQ-EDIT-003`、`REQ-CORE-004`（设计文档 §17 Chromium 一行与 `screenshot.render`，v0.82）· 级别: 回归 · 执行者: AI

前置：`pnpm seed:project --name HangShots --device mobile --screens 1`；MCP 建两屏：`Fonts`（屏里的脚本把 `document.fonts.ready` 换成永不落定的 promise）与 `Icons`（页面加载完之后再调 `lucide.createIcons` 就死循环——截图的就绪判定会再调一次）。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-022`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `POST …/jobs` 建 `apply_design_system { screenIds: "all" }` | 120 s 内 `succeeded`、`revisionIds` 3 条（修复前停在 `running`） |
| 2 | 看 `Fonts` 与 Screen 1 这次的新修订 | 60 s 内都有截图（字体就绪是软条件，最多等 4 s） |
| 3 | MCP 再建一张普通屏 `After` | 60 s 内有截图（截图链没被卡住的那一张拖住） |
| 4 | 看 `Icons` 这次的新修订 | 没有截图（在「载入到拍完」的 30 s 上限处放弃、交给截图重试），修订照常在 |

后置：删项目。

#### `TC-EDIT-023` 回刷超时收口 — 对应 `REQ-EDIT-003`、`REQ-CORE-008`（设计文档 §11 迁移表「超时」，v0.82）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：设 `QUILT_E2E_RESTART`，且重启命令把调用方的环境变量传给新进程（§3）；本机 3987 端口起一个只收不回的服务（屏里一张指向它的图：截图等 `networkidle` 满 15 s、视口内图片再等 4 s，一张约 20 s）。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-023`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 以 `QUILT_JOB_TIMEOUT_BASE_MS=1000 SCREEN_CONCURRENCY=1` 执行重启；`pnpm seed:project --name Timeout --device mobile --screens 1 --no-shot`，MCP 建两张带那张图的屏 `Slow A` / `Slow B` | 就绪 |
| 2 | `POST …/jobs` 建 `apply_design_system { screenIds: [Slow A, Slow B] }`，等它结束 | `failed`、`errorClass=timeout`、`message=job exceeded 11s`（1 s + 2 屏 × 5 s）；`revisionIds` 1 条——恰好一屏 current 变了，另一屏没轮到、current 不变；作业在 60 s 内收口（修复前基数固定 3 min，没有手段走到这条路径：作业 `succeeded`） |

后置：删项目、关 3987 服务，不带这两个变量再执行一次重启。
#### `TC-EDIT-024` 设计系统面板：只差大小写 / 首尾空格不算改动 — 对应 `REQ-EDIT-003`（v0.83）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Normalize --device mobile --screens 2 --no-shot`；打开项目，`⌥D` 打开设计系统面板。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 种子色十六进制改成已保存值的小写，字体名前后各加两个空格 | 版本行不带「有未保存改动」，「保存」置灰，没有「放弃改动」 |
| 2 | 再在 DESIGN.md 开头加一行，点「保存」 | `version+1`；不弹「回刷所有屏？」；库里种子色不变，面板里种子色是大写的已保存值、字体名没有首尾空格，版本行不带「有未保存改动」，「保存」置灰 |
| 3 | 种子色改成 `#c2410c`，点「保存」 | 改完版本行带「有未保存改动」、「保存」可点；保存后弹「回刷所有屏？」（点「以后再说」）；库里种子色为 `#C2410C` |

后置：无。

#### `TC-EDIT-025` 改组件带上此前改成功的指令 — 对应 `REQ-EDIT-006`（`ADR-012` v0.87 修订）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed` 之后没有别的已验证通道（`GEMINI_API_KEY=` 运行）；`pnpm seed:project --name History --device mobile --screens 1 --no-shot`；本机 3976 端口起 OpenAI 兼容桩（`tests/e2e/openai-stub.ts`，记下每次收到的用户提示；改组件回一个单根 `<nav>`，用户提示里带 `FAILME` 时回 400、带 `CUTME` 时回 `finish_reason: "length"`），`POST /v1/channels` 建指向它的通道并探测通过；`POST /v1/projects/<id>/components` 直建组件 `TabBar`。
作业一律带这条通道；建作业遇 `429`（每分钟 10 个）等 5 s 再发。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-025,TC-EDIT-026,TC-EDIT-027`，三条共用项目与桩，`026` / `027` 依赖 `025` 的前置），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 对 `TabBar` 发「改」（`API-CORE-010`，`targetComponentIds=[TabBar]`）：`H1 点击的背景高亮就行，不需要下面的那个圆点`，等作业结束 | `succeeded`；桩收到的这次用户提示里没有 `EARLIER INSTRUCTIONS` |
| 2 | 再发 `H2 FAILME 切换加 200ms 过渡` | `failed`；组件 `version` 不变 |
| 3 | 再发 `H3 选中项文字加粗` | `succeeded`；用户提示有 `EARLIER INSTRUCTIONS ALREADY APPLIED TO THIS COMPONENT`，块里只有 `1. H1 点击的背景高亮就行，不需要下面的那个圆点` |
| 4 | 再发 `H4 图标换成线性风格` | 块里依次是 `1. H3 选中项文字加粗`、`2. H1 …`；整段用户提示里 `H2` 与 `改组件：` 都不出现 |

后置：留给 `TC-EDIT-026`。

#### `TC-EDIT-026` 改屏与局部重生成带上此前的指令：收哪些轮、回溯之后 — 对应 `REQ-CORE-006`、`REQ-CORE-007`、`REQ-EDIT-002`（`ADR-012` v0.87 修订）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`TC-EDIT-025` 的项目、桩与通道；桩对改屏回一张固定的屏（标题 `History`、按钮 `Primary action`），对局部重生成回一个 `<h1>`；`GET /v1/runners` 的 `default` 是这条桩通道。
下文「发」= `API-CORE-010`，`targetScreenIds=[Screen 1]`、带桩通道；「历史块」= 桩收到的那次用户提示里 `EARLIER INSTRUCTIONS ALREADY APPLIED TO THIS SCREEN` 之后的编号列表。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 发 `S1 标题改成「我的订单」` | `succeeded`；这次用户提示里没有 `EARLIER INSTRUCTIONS` |
| 2 | MCP `quilt.edit_screens`：`S3 底部加一行版权说明`（带桩通道） | `succeeded` |
| 3 | `POST …/jobs` 建 `apply_design_system { screenIds: "all" }`；再发接上跳转（`preset=link_repair`，正文留空） | 两个都 `succeeded`，Screen 1 各多一版 |
| 4 | 发 `S4 列表项加分隔线` | 历史块依次是 `1. S3 底部加一行版权说明`、`2. S1 标题改成「我的订单」`，共 2 条；块里没有 `data-qid`、`回刷`、`接上跳转`、`Apply the following` |
| 5 | 发 `S5 顶部加一条促销横幅`；然后把 Screen 1 回溯到第 4 步那一版（`API-CORE-015`，`expectedRevisionId` = 第 5 步那一版） | 回溯 `201`；新修订的 `parentRevisionId` 是第 4 步那一版 |
| 6 | 发 `S6 标题居中` | 历史块第 1 条是 `S4 列表项加分隔线`，整段用户提示里没有 `S5` |
| 7 | 对当前版的 `<h1>` 建 `regenerate_subtree`（`API-CORE-006`，带桩通道）：`S7 标题字号加大` | 桩收到的用户提示（`Within the screen …`）有历史块，第 1 条是 `S6 标题居中`，没有 `S5` |

后置：留给 `TC-EDIT-027`。

#### `TC-EDIT-027` 模型输出到上限被截断时不落残屏 — 对应 `REQ-CORE-006`（§17 LLM 供应商一行，v0.90）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`TC-EDIT-025` 的项目、桩与通道；桩对用户提示里带 `CUTME` 的请求照常回一张屏，但 `finish_reason` 是 `length`（OpenAI 兼容端点「输出到上限被截断」的停止原因）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 记下 Screen 1 的当前修订与修订数（`GET /v1/screens/<id>/revisions`）；发 `C1 CUTME 加一张很长的数据表`（`API-CORE-010`，`targetScreenIds=[Screen 1]`、带桩通道），等作业结束 | 作业 `failed`，`output.errorClass=provider`、`output.message` 含 `output hit the token limit`；当前修订与修订数都不变；这条作业的助手回执以「改屏失败：模型这次要写的内容超过了单次输出上限，结果不完整，没有保存。」开头、含「拆成几次」 |
| 2 | 数这一轮桩收到的、用户提示含 `C1 CUTME` 的请求 | 恰好 1 次（截断不重试） |

后置：关桩、删通道。

#### `TC-EDIT-028` 改元素之后截图及时换上 — 对应 `REQ-EDIT-001`、`REQ-CORE-004`（设计文档 §17 Chromium 一行，v0.93）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name QuickShot --device mobile --screens 1 --no-shot`；截图浏览器能访问外网 CDN（Tailwind Play CDN、unpkg、Google Fonts）；本机 3988 端口起一个只收不回的服务。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-028`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | MCP 建一屏 `Quick`（标题 `<h1 id="title">` 加一个 lucide 图标），轮询它的修订 | 120 s 内有截图（这一张从外网取 Tailwind、lucide 与字体；取不到记环境） |
| 2 | 连改三次标题的类（`POST /v1/screens/<id>/elements/<qid>`，`classes` 依次为 `text-2xl font-semibold`、`text-lg`、`text-xl font-bold`，每次带上一版的修订 id），每次从返回起计时到新修订有截图 | 三次都返回 201，新修订各在 3 s 内有截图（修复前每次 4.2–4.8 s：每张截图重下 CDN） |
| 3 | MCP 建一屏 `Slow`，视口内一张 8×8 的图指向 3988 端口 | 30 s 内有截图（等 `networkidle` 满 15 s、图片再等 4 s；修复前图片按 30 s 等，撞「载入到拍完」上限拍不成） |

后置：删项目，关 3988 端口的服务。

#### `TC-EDIT-029` 检查器的键盘操作与直改撤销 — 对应 `REQ-EDIT-001`（设计文档 `PAGE-CANVAS` 检查器一段「键盘操作与撤销」、`ADR-003` v0.95，v0.95）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Keys --device mobile --screens 1 --no-shot`；打开项目，`⌘E` 后点 `/s1` 进选择元素态；父页 `window` 与预览文档 `document` 上各挂一个记录 `⌘S` 是否被拦（`defaultPrevented`）的探针（注册在页面自己的处理之后）。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-029`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点屏里的 `#toggle`，检查器文案框改成「快捷一」，焦点留在文案框里按 `⌘S` | 新修订里文案是「快捷一」；父页这次 `⌘S` 被拦（不弹浏览器的保存网页） |
| 2 | 文案框改成「快捷二」，再点屏里的 `#toggle`，不点面板直接按 `⌘S`；之后焦点放到检查器内容区按 `Tab` | 点完元素焦点在检查器内容区（`data-testid=inspector-body`），不在 iframe 里；`⌘S` 保存出「快捷二」、被拦；`Tab` 后焦点在文案框 |
| 3 | 光标放到文案框末尾按 `Backspace`；再把文案改回「快捷二」 | 文案框变成「快捷」，当前修订不变（元素没被删） |
| 4 | 点屏里的 `#toggle`，把焦点放进 iframe（模拟焦点仍在屏里），按 `⌘S`，再按 `Delete` | `⌘S` 经运行时转发，提示「没有改动」，预览文档里这次 `⌘S` 被拦；`Delete` 后新修订里没有 `#toggle`，iframe 里也没有 |
| 5 | 焦点仍在 iframe，按 `⌘Z` | toast「已撤销删除元素」；新修订里 `#toggle` 回来、文案「快捷二」，iframe 热更新出来 |
| 6 | 再按 `⌘Z` | toast「已撤销修改元素」（连按不判成冲突）；文案回到「快捷一」 |
| 7 | 直接调直改接口（不经检查器）把文案改成「外部改」，再按 `⌘Z` | toast「这一屏之后又改过了，撤销不了这一步，去修订面板找回」；当前修订仍是「外部改」那一版 |
| 8 | 用 header 建共享组件 `AppBar`（不同步其他屏），挪到屏右侧，重开项目；双击组件卡进交互态、`⌘E`，选组件里的 `h1`，文案改成「组件改」按 `⌘S`，再按 `⌘Z` | toast「已更新组件「AppBar」」；`⌘Z` 提示「组件「AppBar」里的改动撤销不了，要改回去就再改一次组件」 |

后置：删项目。

#### `TC-EDIT-030` 检查器的类名一行一个：说明、换档与颜色下拉 — 对应 `REQ-EDIT-001`（设计文档 `PAGE-CANVAS` 检查器一段「类名编辑」，v0.96）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Classes --device mobile --screens 1 --no-shot`（默认 sharp 圆角档）；打开项目，`⌘E` 后点 `/s1`，再点屏里的 `#toggle`（类名 `inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold`）。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-030`），失败项攒齐一起报。
说明表与换档的取值规则另由单测 `web/twClass` 覆盖。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 看检查器的类名区 | 9 行，顺序与元素上的一致；`px-6`「左右内边距 24px」、`h-12`「高度 48px」、`items-center`「子元素纵向居中」、`rounded-full`「圆角：全圆」、`bg-primary`「背景色 primary」、`font-semibold`「字重 600」；`bg-primary` 那行的色板下拉选中 `primary` |
| 2 | `px-6` 那行点 ›，再点两次 ‹；看 `rounded-full` 那行的 › | 先变成 `px-7`、说明「左右内边距 28px」，再变成 `px-5`；`rounded-full` 的 › 不可点（`aria-disabled`） |
| 3 | `bg-primary` 那行的色板下拉选 `secondary` | 那一行变成 `bg-secondary` |
| 4 | 删掉 `font-semibold`；末行依次输入 `shadow-md` 回车、`gap-2 tracking-wide` 回车 | 末尾三行依次是 `shadow-md`、`gap-2`、`tracking-wide` |
| 5 | 把 `px-5` 改成 `px-`，再改成 `px-5 py-3` 并失焦 | 改成 `px-` 时输入框的横坐标与宽度不变（不能换档时 ‹ › 的位置仍占着）；失焦后拆成 `px-5`、`py-3` 两行 |
| 6 | 末行输入 `foo-bar bg-blue-500` 回车，看两行说明，再删掉这两行 | `foo-bar`「未收录」；`bg-blue-500` 的说明含「非 token 色」 |
| 7 | 焦点放到检查器内容区，按 `⌘S` | 新修订里 `#toggle` 的 `class` 是 `inline-flex items-center justify-center h-12 px-5 py-3 rounded-full bg-secondary text-on-primary shadow-md gap-2 tracking-wide` |

后置：删项目。

#### `TC-EDIT-031` 逐级选：Shift+↑ 选父级、Shift+↓ 回到子级、祖先路径 — 对应 `REQ-EDIT-001`（设计文档 `PAGE-CANVAS` 选中框一段之后「逐级选」，v1.00，v1.28 改键）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Climb --device mobile --screens 1 --no-shot`；画布 `⌘E` 进选择元素态、点 `/s1` 进聚焦。
第 1 个列表项的结构是 `div`（屏根）› `main` › `ul` › `li` › `a` › `span`「Item 1 of screen 1」。
另经 `POST /v1/projects/<id>/components` 建组件 `Box`（`<section class="p-4"><div><p><span>x</span></p></div></section>`）。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-031`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 指针移到「Item 1 of screen 1」上（焦点在画布上），按两次 `Shift+↑` | 悬停框先框住 `a`、再框住 `li`（与 `li` 的矩形一致，外扩 2 px）；检查器仍是空态 |
| 2 | 不动指针点一下 | 选中 `li`：检查器写 `<li> · <qid>`；祖先路径 `div › main › ul › li › a › span`，`li` 加粗、`aria-current="location"`，`a`、`span` 淡色 |
| 3 | 焦点在检查器上（点选后自动挪过来）按 `Shift+↑`；再按一次 `Enter` | 选中变成 `ul`，屏上选中框的标签写 `ul · <qid>`；`Enter` 不换层，仍是 `ul` |
| 4 | 按三次 `Shift+↓`，再按一次 | 依次回到 `li`、`a`、`span`；第四次停在 `span` 不变 |
| 5 | 点路径上的 `main`，再按 `Shift+↓` | 先选中 `main`、路径不变（仍到 `span`）；`Shift+↓` 回到 `ul` |
| 6 | 指针悬停路径上的 `div`，再移开 | 屏上悬停框框住屏根；移开后撤掉 |
| 7 | 焦点在检查器上按 `Tab`，再在文案框里按 `Shift+↑` | `Tab` 直接进文案框（路径按钮不进 Tab 序）；文案框里按 `Shift+↑` 选中不变（留给文本框扩选文字） |
| 8 | 焦点给预览 iframe（不点屏里的元素）按 `Shift+↑` | 由运行时就地处理：选中上移一级 |
| 9 | `Esc` 退出这一屏（选择元素态仍开着），双击组件卡 `Box` 聚焦它，点它里面的 `span`，焦点在检查器上按两次 `Shift+↑` | 选中依次变成 `p`、`div`，路径 `section › div › p › span` |

后置：删项目。

#### `TC-EDIT-032` 撤销不了的删除先确认 — 对应 `REQ-EDIT-001`、`REQ-EDIT-003`、`REQ-EDIT-006`（设计文档 `PAGE-CANVAS` 检查器「删组件里的元素先确认」，v1.03）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Confirm --device mobile --screens 2 --no-shot`；从 `/s1` 的顶栏建组件 `AppBar` 并同步到能同步的屏（`usedBy` 记为 N），组件卡挪到屏的右侧；视口 1440×1000。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 双击组件卡、`⌘E`、点它里面的 `h1`，焦点在检查器上按 `Delete`；点「取消」 | 弹确认框「删除组件「AppBar」里的这个元素？」「会同步到用它的 N 屏，撤销不了。」；取消后组件 HTML 里 `h1` 还在 |
| 2 | 点「删除元素」，在确认框点「删除」 | 同样先确认；确认后 toast「已删除组件「AppBar」里的元素，同步 N 屏」，组件 HTML 里没有 `h1` |
| 3 | 经 API 写一条约定，`⌥D` 打开设计系统面板点它的「删除」，先「取消」、再删一次并确认 | 弹「删除这条约定？」；取消后约定还在；确认后 toast「已删除这条约定」、约定为空 |

后置：删项目。

#### `TC-EDIT-033` 计划的修订全部落库后到点，按成功收尾 — 对应 `REQ-EDIT-002`、`REQ-CORE-008`（设计文档 §11 迁移表「超时」，v1.03）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`，要 `QUILT_E2E_RESTART`）

前置：以 `QUILT_JOB_TIMEOUT_TOTAL_MS=5000` 重启 API；`pnpm seed:project --name Landed --device mobile --screens 1 --no-shot`；MCP 建一张截图要约 20 s 的慢屏 `Slow`（同 `TC-EDIT-023`：一张永远等不到的图）。
跑完按原环境重启。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 对 `Slow` 的标题建 `regenerate_subtree`（桩立刻回，修订 1 s 内落库，5 s 时截图还没拍完），等作业结束 | 作业 `succeeded`；`current` 前移到新修订；作业用时超过 5 s（时限确实在截图途中到点） |

后置：删项目，按原环境重启 API。

#### `TC-EDIT-034` 提示条：错误多留、悬停不走、直改与排列带撤销 — 对应 `REQ-EDIT-001`、`REQ-CORE-018`（设计文档 `PAGE-CANVAS`「提示条」，v1.04）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Toasts --device mobile --screens 2 --no-shot`；视口 1440×1000。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `⌘E` 点 `/s1` 的 `#toggle`，文案改成「立即登录」点保存；点提示条上的「撤销（⌘Z）」 | 提示「已更新，截图稍后刷新」带「撤销（⌘Z）」；点了出「已撤销修改元素」，`current` 的 HTML 里不再有「立即登录」 |
| 2 | 重开、`⌘E` 点 `/s1` 的 `h1`，点「删除元素」；指针停在提示条上 5 s（提示条随输入框高度挪位时跟上），再移开 | 提示「已删除元素」带撤销；悬停 5 s 时还在；移开后 4.5 s 内消失 |
| 3 | 拦下改元素的请求（让它失败），重开选 `#toggle` 改文案点保存；等 5 s，点提示条的关闭键 | 提示「保存失败」（`data-kind=error`）5 s 时还在；点「关闭提示」后收起 |
| 4 | 经 API 把两屏摆到 (0,0) 与 (700,150)，重开、`⌘A`、点排列条「上对齐」；点提示条上的撤销 | 提示「已对齐 2 屏」带撤销，第二屏 `y` 变成 0；点撤销后回到 150 |

后置：删项目。

#### `TC-EDIT-035` 作业进行中时的面板只挡真冲突 — 对应 `REQ-CORE-020`、`REQ-EDIT-001`、`REQ-EDIT-003`（设计文档 `PAGE-CANVAS`「作业进行中时的面板」，v1.04）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name BusyPanels --device mobile --screens 2 --no-shot`；经 API 写一条约定「按钮一律用主色」；再对 `/s1` 建一个 `edit_screens`（提示词带 `[stub-hold:60000]`，stub 通道），它在跑期间做下面几步。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开项目、`⌥D` 打开设计系统面板；在「用一句话改设计系统」里填一句 | 「回刷所有屏」不可点，下方写「有作业进行中：改「Screen 1」，等它结束再回刷」；约定的「删除」、说明框、「提炼并预览」都可用 |
| 2 | 关掉面板，`⌘E` 点 `/s1` 的 `h1`；按 `⌘S` | 检查器写「这一屏正在改，等这一轮完事」；按 `⌘S` 弹出同样的提示 |

后置：取消那个停顿的作业，删项目。

#### `TC-EDIT-036` 改屏走补丁，对不上退回整屏 — 对应 `REQ-CORE-006`（设计文档 `ADR-007` / `ADR-012` v1.05 修订）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Patch --device mobile --screens 2 --no-shot`；起一个 OpenAI 兼容桩：收到补丁提示词（含 `<<<<<<< FIND`）时回一块把 CURRENT HTML 第一个 `<h1>` 的文字换成「补丁标题」的补丁，指令里有 `MISS` 时回一块找不到的补丁；收到整屏提示词时回一个标题为「整屏重写」的根元素。
建一条指向它的通道并验证通过；经 `PATCH /v1/projects/<id>` 把 `/s1` 设为样板屏。
改屏都经 `POST …/jobs` 建、`runner` 指这条通道。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 只改 `/s1`（样板屏）：「标题改一下」 | 作业 `succeeded`，桩只收到 1 次调用、是补丁提示词，系统提示里没有 `exemplar screen`；新修订标题是「补丁标题」，`data-qid` 集合与改之前完全相同 |
| 2 | `/s1`、`/s2` 一起改：「标题都改一下」 | 作业 `succeeded`，2 次调用，两次的系统提示里都有 `exemplar screen` |
| 3 | 只改 `/s2`：「MISS 改标题」 | 作业 `succeeded`，2 次调用：先补丁提示词、再整屏提示词；`/s2` 新修订标题是「整屏重写」；作业 `output.tokensOut` = 14（两次各 7） |

后置：关桩，删项目。

#### `TC-EDIT-037` 改屏补丁与思考深度回放（真实模型） — 对应 `REQ-CORE-006`、`REQ-CORE-003`（设计文档 `ADR-007` / `ADR-012` v1.05 修订）· 级别: 提示词轮 · 执行者: AI（本机 Claude 订阅）

前置：只在 §5「提示词轮」列的改动时跑。
本机 Claude 订阅已登录；开发库与对象存储在（只读：快照一步只用只读会话读库）；不起 API、不写任何库。
回放用例清单在仓库外（引用开发库里的真实项目），格式 `[{ id, project, route, instruction, revisionId? }]`：历史改屏取它当时的基线修订（`revisionId`），其余在真实屏上写典型改法，`instruction` 写 `LINK_REPAIR_PROMPT` 即「接上跳转」。
产物在 `docs/test-runs/edit-bench`、`docs/test-runs/craft-bench`（已 gitignore）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `EDIT_BENCH_DB=<开发库> npx tsx bench/edit/replay.mts snapshot <清单>`（在 `tests/` 下） | 每条打出 body 与系统提示的字数；只改样板屏的那几条标出「样板屏就是目标屏」 |
| 2 | `npx tsx bench/edit/replay.mts run patch`；挑 3 条 `run rewrite <id…>` 做整屏对照；`shots patch`、`shots rewrite`；`report patch rewrite` | 通过标准（v1.05 登记）：≥ 9/10 一次套上、不需要退回整屏；补丁用时的中位数 ≤ 整屏对照的 1/3；逐张看渲染，补丁结果做到了指令、其余部分不变 |
| 3 | `EDIT_BENCH_EFFORT=medium EDIT_BENCH_LABEL=patch-medium npx tsx bench/edit/replay.mts run patch` | 一次套上的条数不少于缺省档；抽 2 条渲染核对 |
| 4 | `npx tsx bench/craft/harness.mts plantime default`、`AES_EFFORT=low … plantime low` | 两档每条都规划出屏、屏数相同；`low` 不慢于缺省档 |
| 5 | `AES_LABEL=eff-default … gen base sonnet <2 条需求>`、`AES_EFFORT=medium AES_LABEL=eff-medium …`，并排看截图 | 记下用时、输出 token 与内容差别；出屏要不要降档看这一步（v1.05 结论：不降，`medium` 内容少一截） |

后置：无（产物留在 gitignore 目录里供核对）。


#### `TC-EDIT-038` 检查器没存的文案与说明按元素暂存 — 对应 `REQ-EDIT-001`、`REQ-EDIT-002`（v1.23）· 级别: 回归 · 执行者: AI

从 `TC-EDIT-014` 第 6 步拆出（那一条随批注废弃）。
前置：`pnpm seed:project --name Drafts --device mobile --screens 1`；打开项目，按 `⌘E` 进选择元素并点进 `/s1`。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-038`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点选 `#toggle`，文案改成「改过但还没保存的文案」、「用 AI 重生成这块」写「改成横向卡片」；点选标题 `h1`；再点回 `#toggle` | 换到 `h1` 时文案是它自己的（`Screen 1 …`）、说明为空；点回 `#toggle` 时没存的文案与说明都还在 |

后置：无。

#### `TC-EDIT-039` 批注已撤下：界面、接口与 MCP 都没有了 — 对应 `REQ-EDIT-004`、`REQ-AGENT-002`（`API-EDIT-003`，v1.23）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name NoNotes --device mobile --screens 1 --no-shot`（项目 P、屏 S）；草稿本里用 stub 出组件草稿 D。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-039`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开 P 的画布，看右侧工具栏；按 `⌥N`；再以 `/p/<P>?panel=annotate` 打开 | 工具栏没有「批注」；按 `⌥N` 后地址里没有 `panel=annotate`、没有待命提示；带 `panel=annotate` 打开时不开任何面板 |
| 2 | 打开 `/sketch?d=<D>`，看草稿工具条；按 `⌥N` | 没有「批注」开关（`draft-annotate` 为 0）；按 `⌥N` 后看板不变 |
| 3 | `GET /v1/screens/<S>/annotations`、`POST /v1/screens/<S>/annotations`、`PATCH /v1/annotations/<随机 uuid>`、`POST /v1/projects/<P>/annotations/send` | 都是 `404 /errors/not-found` |
| 4 | MCP 列出工具；`quilt.get_project { projectId: P }` | 没有名字里带 `annotation` 的工具；项目结果里没有 `annotations` 字段 |

后置：无。

#### `TC-EDIT-040` 逐级选不被焦点控件的默认动作吃掉 — 对应 `REQ-EDIT-001`（设计文档 `PAGE-CANVAS`「逐级选」，v1.25，v1.28 改键）· 级别: 回归 · 执行者: AI · 源自缺陷 2026-10-22 选择元素时 Shift+Enter / Enter 很容易被浏览器自带的按键动作干扰

前置：`pnpm seed:project --name Climb2 --device mobile --screens 1 --no-shot`；画布 `⌘E` 进选择元素态、点 `/s1` 进聚焦；第 1 个列表项的结构同 `TC-EDIT-031`（`div` › `main` › `ul` › `li` › `a` › `span`）。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-040`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点第 1 个列表项的文字，再用鼠标点检查器路径上的 `li` | 选中 `li`（焦点可以停在路径按钮上，下一步照样换层） |
| 2 | 紧接着按 `Shift+↓`，再按两次 `Shift+↑` | 依次选中 `a`、`li`、`ul` |
| 3 | 用鼠标点检查器的「保存」（没有改动），提示消失后按 `Shift+↓` | 选中回到 `li`；没有再出一次「没有改动」 |
| 4 | 焦点放进文案框，按 `Tab` 直到焦点落在「保存」上，按 `Enter` | 出现「没有改动」（键盘走到的按钮照旧按下）；选中仍是 `li` |
| 5 | 在屏里点第 1 个列表项的链接左缘，再按 `Shift+↑` | 选中上移一级；没有打开新窗口，聚焦的仍是 /s1 |

后置：无。

#### `TC-EDIT-041` 草稿本里按住 Shift 选几块、一次改完 — 对应 `REQ-EDIT-002`（`PAGE-SKETCH`「选元素」、`API-CORE-006` 的 `qids`，v1.26）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：草稿本里出一张组件草稿（stub 的播放器卡片：标题、副标题、三个按钮）；打开它，打开「选元素」。
脚本 `tests/e2e/sketch.ts`（`ONLY=TC-EDIT-041`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点标题文字 | 一枚胶囊，动词行「改这一块」 |
| 2 | 按住 `Shift` 点暂停按钮 | 两枚胶囊，动词行「改这 2 块」；草稿里两处都有选中框 |
| 3 | 按住 `Shift` 再点标题 | 标题那枚胶囊去掉，剩一枚 |
| 4 | 按住 `Shift` 点副标题，再按两次 `Shift+↑`（副标题 → 标题与副标题那一块 → 连按钮在内的整行）；输入框是空的，这两下由它转给草稿走层级 | 第一次后两枚胶囊（按钮、标题与副标题那一块）；第二次整行包住了按钮：提示「已合并到外层」，只剩整行一枚 |
| 5 | 按 `Esc` 清空，点标题，按住 `Shift` 点暂停按钮，写「都改成红色」发送 | 建一个 `regenerate_subtree` 作业，`input.qids` 是这两块；stub 只收到一次调用、提示词里有两块的原 HTML；草稿多一版，这两块换成 stub 回的内容，副标题原样；胶囊清空 |
| 6 | 再选两块，带 `[stub-blocks-miss]` 发送（stub 每次都少回一块） | stub 收到两次调用（补问一轮）；作业失败，草稿的版本数不变 |
| 7 | 经接口建 `regenerate_subtree`：`qids` 9 个；`qids` 里一块包住另一块；`qids` 不含 `qid` | 都是 `400 /errors/validation` |

后置：无。

#### `TC-EDIT-042` 画布选择元素按住 Shift 多选，检查器一起改 — 对应 `REQ-EDIT-002`、`REQ-EDIT-001`（`PAGE-CANVAS`「多选」，v1.26）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Multi --device mobile --screens 1 --no-shot`；画布 `⌘E` 进选择元素态、点 `/s1` 进聚焦；列表结构同 `TC-EDIT-031`。
脚本 `tests/e2e/edit.ts`（`ONLY=TC-EDIT-042`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点「Item 1 of screen 1」，按住 `Shift` 点「Item 2 of screen 1」 | 检查器标题「已选 2 个元素」，下面两行；屏里两处都有选中框；没有文案框、类名框与「删除元素」 |
| 2 | 点其中一行的 × | 回到单选：检查器显示剩下那一块的直改表单 |
| 3 | 按住 `Shift` 再点「Item 2 of screen 1」，按 `Shift+↑` | 最后点中的那块上移到 `a`，另一块仍是 `span` |
| 4 | 在「用 AI 重生成这几块」写一句发送 | 一个 `regenerate_subtree` 作业，`input.qids` 两个；屏多一版，这两块换了、第 3 项原样 |
| 5 | 按 `Esc` 退出聚焦，再进 `/s1` | 多选已清空，检查器是空态 |
| 6 | MCP 调 `quilt.regenerate_subtree` 带 3 个 `qids` | 作业成功，屏多一版 |

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
| 4 | 打开 `/p/<id>?settings=models` | 「让本机 agent 接入 Quilt（MCP）」给出的命令是 `claude mcp add --transport http quilt http://localhost:3100/mcp` |

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

#### `TC-AGENT-004` 违规 HTML 照常写入并带偏离报告 — 对应 `REQ-AGENT-002`（v0.43 起契约是透镜不是闸门）· 级别: 回归 · 执行者: 皆可

前置：同 `TC-AGENT-003` 项目；含裸色值 `#123456` 的 HTML。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `quilt.create_screen` 传入该 HTML | **写入成功**（v0.43），返回体带 `lintReport.violations`（含裸色值、内联 style 等条目）与 `screenId`；项目详情里该屏 `deviations` 等于条数 |
| 2 | curl `GET /v1/projects/<id>` | 屏数 +1，新屏的 `deviations` 等于 `lintReport.violations` 条数 |

后置：无。

#### `TC-AGENT-009` 本机 agent 作为执行者：会话列表 / 会话下拉 / 投递 / 屏锁 / 取消 / 收口 / 记忆与失效 — 对应 `REQ-AGENT-003`（`ADR-015` v0.34、`ADR-016`）· 级别: 回归 · 执行者: AI

前置：API 与脚本都以 `QUILT_CLAUDE_SESSIONS_DIR=/tmp/quilt-e2e-sessions` 运行（§3），本机 `claude` 在 PATH 上；脚本起两个假会话——「Stub 会话」（`nameSource=user`）与 `quilt-ab`（`nameSource=derived`、`status=busy`、活跃时间早 1 分钟、登记版本 `0.0.0`），登记格式同 Claude Code 2.1.287（`<pid>.json` 带 `peerFeatures` 三项，另有一份 0600 的 `<pid>.<hex>.key`，v1.06）；`pnpm seed:project --name AgentJob --device mobile --screens 2 --no-shot`。
未设该变量或 `claude` 不可用时登记「跳过」。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `GET /v1/agent/sessions` | 两个假会话都在：「Stub 会话」`named=true`；派生名的 `named=false`、`status=busy`、`unverifiedVersion=0.0.0`；按最近活跃排序（Stub 会话在前） |
| 2 | 打开项目，通道下拉选「交给本机 Claude Code」，打开旁边出现的会话下拉（`session-select`） | 屏数 / 版数档位（`count-group` / `versions-group`）不再显示，动词行写「…交给本机会话」；起过名的项显示「Stub 会话」，派生名的项显示其会话 UUID，各带目录名与 空闲 / 忙 小标；派生名那项另标「此版本未验证 · 0.0.0」；选「Stub 会话」后触发器 `data-value` 为其 sessionId |
| 3 | 点选 s1 卡片，输入框发「HANG 把首页改成分组列表」 | 画布切到 agent 面板；假会话收到一行 JSON 用户消息，提示词含 `(job <id>)`、`expectedRevisionId=<s1 current>`、`quilt.finish_job`、`claude mcp add`；作业 `running`、`output.delivery.name=Stub 会话`；助手回执含「已投递到本机 Claude Code 会话「Stub 会话」」；`GET /v1/me/usage` 的 token 与 `inflight.screens` 不变；输入框未禁用；**面板开着且 agent 作业在跑时页面活跃 `EventSource` 仍为 1**（v0.38：面板轮询 `API-CORE-029`，不再按作业各开一条 `API-CORE-008`——5 个 agent 作业同时跑就占满同源 6 条额度），且后台标签页（`document.hidden`）不发轮询请求 |
| 4 | 对 s1 直改（`API-EDIT-001`）；同屏再派一次（带同一 sessionId） | 都返回 409 `/errors/screen-busy`（作业持锁） |
| 5 | 面板首条卡（`agent-job`）：状态 running、`agent-line` 等到含「已投递」（v0.38 面板靠 1.5 s 轮询推进，投递窗口内先显示「正在投递…」，所以这一条要等、不能一次性断言）、`agent-session` 为「Stub 会话」；点「取消」 | 作业 `cancelled`（不杀任何进程）；随后对 s1 直改返回 201（锁已释放）；用 MCP 对该作业调 `quilt.finish_job` → 409 `/errors/job-finished` |
| 6 | 再派一条含 `FAIL`（假会话直接 `finish_job status=failed summary="simulated failure"`） | 作业 `failed`、`output.errorClass=agent`、`output.summary=simulated failure` |
| 7 | 再派一条含 `STALE`（假会话用假 `expectedRevisionId` 调 `quilt.update_screen` 后报失败） | 作业 `failed`、`output.summary` 含 `revision-conflict`；s1 的 current 不变 |
| 8 | 先双击 s1 进交互（画布不开任何面板），再派一条普通指令（假会话按提示词基线回写，再 `finish_job summary="rewrote Screen 1 as asked"`） | **不做任何操作**，15 s 内聚焦屏原地换成假会话写的内容（h1 含 `by fake session`，项目级事件 → 热更新，`API-CORE-030`）；作业 `succeeded`、`output.screenIds=[s1]`、`output.summary` 为该摘要；current 变化；助手回执「本机 agent 已完成…rewrote Screen 1…」且 `affectedScreenIds=[s1]`；面板列 4 条，完成那条写「回写了 1 屏 · rewrote Screen 1 as asked」 |
| 9 | 刷新页面；关掉「Stub 会话」；打开会话下拉；在输入框键字；直接 `POST` 带旧 sessionId | 刷新后会话下拉仍选中「Stub 会话」（跨会话记忆）；关掉后打开下拉重取，触发器回到「选择会话」、发送钮 `aria-disabled`（提示「先选要投递的会话」）；直接 POST 返回 400 `/errors/validation` |

后置：脚本关闭假会话并删掉登记文件与 socket。

#### `TC-AGENT-010` 投递到真实 Claude Code 会话 — 对应 `REQ-AGENT-003` · 级别: 回归 · 执行者: 人工

前置：本机 `claude` 已登录；在任意目录开一个交互式会话并 `/rename 设计稿`，在该会话里执行设置页给的 `claude mcp add --transport http quilt http://127.0.0.1:3100/mcp` 并 `/mcp` 确认连上；`pnpm seed:project --name RealAgent --device mobile --screens 1 --no-shot`；记录 `GET /v1/me/usage` 与那个终端里 `claude --version` 的版本。
AI 轮次登记「待人工」——投递进真实会话要在那个终端里确认接收。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 画布通道选「交给本机 Claude Code」，会话下拉选「设计稿」，点选 s1 发「Change the h1 heading text to "Hello from Claude Code" and keep everything else the same.」 | 画布切到 agent 面板：运行中 · 已投递到「设计稿」；那个终端里出现投递来的消息（可能先要确认接收） |
| 2 | 在终端看会话干活，等它调 `quilt.finish_job` | 作业 `succeeded`、`output.screenIds=[s1]`、`output.summary` 是它的一句话；s1 新修订含 `Hello from Claude Code`；`GET /v1/me/usage` 与前置相同（会话用自己的登录态，不记 Quilt 台账）；面板该条为「完成」并显示摘要 |
| 3 | 再发一条并在终端里不处理，等 30 分钟 | 作业 `failed errorClass=timeout`，面板写「投递后 30 分钟没有收口」 |

后置：第 1、2 步通过时，把记下的版本加进 `apps/api/src/lib/claudeSessions.ts` 的 `VERIFIED_CLAUDE_VERSIONS`，并在 §7「投递到真实 Claude Code 会话没有通过记录」一条写上版本与轮次（v1.06）；之后这个版本的会话在下拉里不再标「此版本未验证」。

后置：无。

#### `TC-AGENT-012` 交给本机 Codex（假 Codex）：线程列表 / 会话下拉 / queue 投递 / 深链接打开 / 拒绝 / 记忆 / Codex 订阅通道 — 对应 `REQ-AGENT-003`、`REQ-CORE-013`（`ADR-020` v0.68）· 级别: 回归 · 执行者: AI

前置：按 §3 以 `QUILT_CODEX_HOME` / `QUILT_CODEX_BIN` / `QUILT_CODEX_OPENER` 启动 API 与脚本；脚本自建假线程库，五个线程——桌面版「设计稿」（写锁被脚本占着 = 已打开）、VS Code 未起名线程（标题「帮我看看首页」，锁文件在但没人占 = 残留）、无头 exec 线程、终端「坏线程」（id 以 `ffff` 结尾，桩对它的 `queue` 报错）、终端「终端线程」（id 以 `eeee` 结尾，桩打不开它的深链接，模拟本机没装 Codex 桌面版，v0.79）；`pnpm seed:project --name CodexJob --device mobile --screens 2 --no-shot`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `GET /v1/agent/sessions?tool=codex` | 只有「设计稿」「帮我看看首页」「坏线程」「终端线程」四条（exec 不列），按最近活跃排序；「设计稿」`named=true`、`open=true`、`app=desktop`；未起名的 `named=false`、`name` 为标题、`open=false`（残留的锁文件不算打开）、`app=vscode` |
| 2 | `GET /v1/runners` | `agent:codex` 可用，`hint` 为桩的版本号，`setupHint` 含 `codex mcp add quilt --url` |
| 3 | 画布通道下拉选「交给本机 Codex」，打开会话下拉 | 组标题「本机 Codex 线程…」；「设计稿」一项带「桌面版」「已打开」，「帮我看看首页」一项带「VS Code」「未打开」；选「设计稿」后触发器 `data-value` 为其线程 id |
| 4 | 点选 s1，输入框发「把首页改成分组列表」 | 桩记下一次 `queue --thread <设计稿>`，消息含 `(job <id>)`、`expectedRevisionId=<s1 current>`、`quilt.finish_job`、`codex mcp add quilt --url`（不含 `claude mcp add`）；没有深链接调用；作业 `running`、`output.delivery = { tool: codex, name: 设计稿, opened: false }`；回执「已投递到本机 Codex 线程「设计稿」」；agent 面板这条标 Codex。脚本扮演的窗口取走消息回写并收口 → 作业 `succeeded`、`screenIds=[s1]` |
| 5 | 直接 `POST` 投给「帮我看看首页」 | 202；桩先记 `queue` 再记打开 `codex://threads/<id>`；`delivery.opened=true`；脚本在看到深链接后占住该线程的锁、取走执行 → `succeeded` |
| 6 | 分别投给 exec 线程、不存在的线程、「坏线程」 | 前两个 400 `/errors/validation`；「坏线程」建作业 202，随后 `failed`、`errorClass=agent`、`message` 以「投递失败」开头 |
| 6a | 直接 `POST` 投给「终端线程」；读作业、消息，打开 `?panel=agent`；之后脚本占住它的锁（用户在 Codex 里打开了这个线程）并扮演窗口取走消息（v0.79） | 202；桩先记 `queue`、再记打开失败（`open-failed`）；作业仍 `running`、`delivery.opened=false`、`delivery.openError` 为 `open` 的报错；助手消息与面板那一行都提示「在 Codex 里打开这个线程」（面板那行是警示色，报错原文在悬停提示里）；线程取走后经 MCP 回写并收口 → `succeeded`（此前打开失败即标「投递失败」，之后排队的消息照样执行、回写与收口全被 `409 job-finished` 挡掉） |
| 7 | 刷新页面；再把通道切到「交给本机 Claude Code」 | 刷新后会话下拉仍选中「设计稿」；切到 Claude Code 后触发器不带 Codex 的线程 id（记忆按工具分开） |
| 8 | 打开 `?settings=models`，「添加模型」选「本机 Codex 订阅」，填显示名与模型 `gpt-stub`，点「保存并验证」（桩让验证拖 18 s）；再用它发一条改 s1 的消息 | 面板没有 Key / 端点字段；等过 18 s 后面板关闭、不出现「保存失败」（v0.69：前端验证请求等 100 s，此前共用 15 s 上限），通道 `apiKeyHint=null`、`status=verified`；桩记下的 `exec` 参数含 `--json`、`--ephemeral`、`--skip-git-repo-check`、`--ignore-user-config`、`--ignore-rules`（v0.70）、`-s read-only`、`-m gpt-stub`，输入开头是「Answer directly … Do not run shell commands …」，环境里没有 API Key，工作目录不在仓库里；改屏作业成功、s1 新修订含桩的标记 `(by codex stub)`；`GET /v1/me/usage` 的 `tokensIn` 增加 ≥ 20000 |

后置：脚本关掉占着的锁文件句柄、删除通道；假 Codex 目录下次运行前清空。

#### `TC-AGENT-013` 真实 Codex：订阅通道生成、投给终端会话、深链接让桌面版打开线程 — 对应 `REQ-AGENT-003`、`REQ-CORE-013`（`ADR-020` v0.68）· 级别: 回归 · 执行者: AI

前置：按 §3 准备真实 Codex（ChatGPT 登录、桌面版开着、`quilt` MCP 临时指测试 API 并预先放行）；测试 API 不设任何 `QUILT_CODEX_*`；`pnpm seed:project --name CodexLive --device mobile --screens 1 --no-shot`；记下 `~/.codex/sessions/<今天>/` 的文件数。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 建 `kind=codex` 通道（模型取 Codex 配置里的，如 `gpt-6-astra`）并探测 | 探测 `ok=true`，耗时 < 90 s |
| 2 | 用该通道改 s1（「标题改成『Codex 订阅生成』，列表改三张带缩略图的卡片」） | 作业 `succeeded`；新修订含新标题；台账出现 `driver=codex` 的一行；`~/.codex/sessions/<今天>/` 文件数不变（`--ephemeral`） |
| 3 | 在伪终端里起 Codex TUI（工作目录为临时目录），等它回完第一句 | `GET /v1/agent/sessions?tool=codex` 里这个线程 `app=cli`、`open=true` |
| 4 | 投一条「把页面标题改成『来自终端 Codex』」给这个线程 | TUI 取走消息、经 MCP 回写并 `quilt.finish_job` → 作业 `succeeded`、`delivery.opened=false`，s1 标题已改 |
| 5 | 关掉 TUI（锁文件会留下），再看列表 | 该线程 `open=false`（残留的锁没人占） |
| 6 | 再投一条「改成『来自桌面版 Codex』」给这个线程 | Quilt 先排队再打开 `codex://threads/<id>`，桌面版打开该线程并执行 → 作业 `succeeded`、`delivery.opened=true`；桌面版进程持有该线程的写锁 |

后置：把 Codex 的 `quilt` MCP 改回 `http://127.0.0.1:3100/mcp`；删除本用例在 Codex 里留下的测试线程（在桌面版里开着的要先切走才能删）；删除临时目录与通道。

#### `TC-AGENT-011` MCP 与画布同面：删 / 修订 / 候选 / 摆放 / 直改 / 全部作业 / 素材 / 预设 / 项目 — 对应 `REQ-AGENT-002`（v0.51）· 级别: 回归 · 执行者: AI

前置：API 以 `LLM_DRIVER=stub` 启动（作业类步骤只验作业输入与终态，模型行为由 `TC-CORE-005` / `TC-EDIT-004` / `TC-EDIT-009` / `TC-EDIT-012` / `TC-PROTO-005` 各自覆盖）；`pnpm seed`；`pnpm seed:project --name Parity --device mobile --screens 3 --no-shot`；经 `POST /v1/projects/{id}/components` 建共享组件 `Footer`；脚本在 `$TMPDIR` 现造一张 1×1 PNG（结束即删）。
执行与独立端口的起法见 §3。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `--list`；`quilt.list_runners` | 53 个工具（v0.51 新增 32 个、v0.60 合并两对、v0.64 增 `patch_screen` / `append_upload`、v1.13 增 `get_sketchbook` / `copy_draft`、v1.23 删 4 个批注工具），名字里都没有 `annotation`；7 类资源；通道目录 `{ items, default }`，响应文本不含 `apiKey` |
| 2 | `validate_screen` OK_HTML → `create_screen /agent` → `get_screen` → `get_screenshot`（20 s 内）；违规 HTML `create_screen /bad` → `delete_screen` | 无违规；注入 qid + prelude；返回 image；违规屏照常写入且 `lintReport.violations` 非空；删后项目 4 屏、`/bad` 不在 |
| 3 | `update_screen` 只传 `html` + `expectedRevisionId`；`get_revision` 取第 1 版；`restore_revision`（expectedRevisionId = 当前）；再用第 1 版 id 作 expectedRevisionId 回溯 | name / route 沿用、current 推进；返回第 1 版 HTML 文本（`seq=1`、无 v2）；产生 `sourceKind=restore` 修订并成为 current；`409 /errors/revision-conflict` |
| 4 | `edit_screens` 对 `/agent` `versions=2` → `list_candidates` → `adopt_candidate { jobId, index=1, screenId=/agent }` → `adopt_candidate { jobId, index=3 }`（不带 screenId）→ `adopt_candidate` 的 `screenId` 给一个该作业没出过候选的 id | 作业 succeeded；1 屏 × 2 版未结清；`adopted=[/agent]`、`skipped=[]` 且 current 指向第 2 版、该批结清；`adopted=[]`、`skipped=[{ /agent, /errors/not-found }]`；`404 /errors/not-found` |
| 5 | `move_screens`：s1 (100, 200)、s2 (600, 200)、`Footer` (−300, 0)、一个假组件 id | `moved.screens` 2、`moved.components` 1、`failed=[{ 假 id, /errors/not-found }]`；详情里位置落库、`Footer.version` 不变 |
| 6 | `edit_element` q1 `text`；再用旧 expectedRevisionId 直改 | `sourceKind=manual`、`get_screen` 含新文案；`409 /errors/revision-conflict` |
| 7 | `create_upload_url`（不带 mediaType）；`create_upload_url mediaType=image/png` 不带 `bytes`；`create_upload_url mediaType=image/png bytes` → PUT PNG；`create_asset`（本机 PNG 绝对路径）→ `list_assets` / 设计契约 `assets[]` / 预览域 GET；`create_asset` 相对路径、不存在的文件、`/dev/zero`、一个目录、一个 6 MB 的文件（v1.06）；`delete_asset` | `mediaType=text/html` 且 `putUrl` 含 `/v1/uploads/{uploadId}`；`400 /errors/validation`；`putUrl` 绝对地址、PUT 204；素材 `image/png`、URL 为 `/a/{pid}/{id}`，三处都能看到、预览域 200 `image/png`；`400 /errors/validation`、`404 /errors/not-found`、后三种都是 `400 /errors/validation`（读之前就拒，不打开）；删后列表不含 |
| 7b | 对 `/agent` `patch_screen`：`find=Edited by MCP` 换成 `Patched by MCP`；再发两条 edit（第 2 条 `find` 不存在）；`find=px-4` 不带 `all`；`find=px-4 all=true`；用旧 `expectedRevisionId` 再 patch；`create_upload_url` → `append_upload` 三段（`offset` 依次为 0 与上次返回的 `chars`）→ `create_screen uploadId`；`append_upload uploadId=../etc` | `get_screen` 含新文案、current 推进；`422 /errors/validation` 且 `errors[0].path=edits.1.find`；`422` 且 `errors[0].matches > 1`；两次失败后 current 与内容都没变；body 里 `px-4` 全变 `px-5`；`409 /errors/revision-conflict`；累计 `chars` 等于原文长度、新屏内容正确；非法 `uploadId` 报错 |
| 8 | `generate_screens count=2 anchor=(5000,0) attachmentIds componentIds`；`generate_screens route=/settings name=Settings fromScreenId=s1`；`regenerate_subtree s1 q1`；`propose_design_system`；`edit_component` 带 `runner.kind=agent`、再不带；`export_prototype` → `get_export`；`get_export` 对非导出作业；`list_jobs`；`get_job_events`（含 `after`）；`seed:job running` → `cancel_job` ×2；`edit_screens` 带不属于自己的 `channelId` | 作业输入落 `anchor` / `imageKeys`（1 张）/ `componentIds`；succeeded 且有一屏中心落在锚点（左上角 `(5000 − 195, 0 − 422)`，与画布双击放锚点同一语义）；懒生成 `/settings` 屏出现；子树作业 succeeded、s1 最新修订 `subtree`；提炼作业建成（stub 下终态记入明细）；`400 /errors/validation`、作业 `edit_component` 建成；导出 succeeded、下载 200 且正文含全部屏；`409 /errors/job-not-finished`；列表含各作业；事件 seq 递增、末条 `succeeded`、`after=末尾` 为空；`cancelled`、再取消 `409 /errors/job-finished`；`404 /errors/not-found` |
| 9 | `create_design_preset Brand` → `list_design_presets` → `create_project FromPreset presetId` → `apply_design_preset expectedVersion applyToScreens=true` → 过期版本再套 → `delete_design_preset` | 预设在列；新项目种子色 = 预设；`version+1`、回刷作业 succeeded；`409 /errors/version-conflict`；删后不在列 |
| 10 | `update_project exemplarScreenId=s2` → 读 `golden` 资源 → `exemplarScreenId=null` → 空 patch；`update_design_system conventions=[…]`；REST 发一条消息（`count=2`）→ `list_messages` | 样板屏落库、golden 是 s2 正文、能回落；`400 /errors/validation`；DESIGN.md 出现 `## 约定` 与两条、`version+1`；列表含该轮 user 与 assistant（带 jobId） |
| 11 | `delete_component Footer`；`seed:job running` → `delete_project` → `cancel_job` → `delete_project`；再删 `FromPreset`；`list_projects`、`get_project` | 详情无组件；`409 /errors/project-busy`；取消后删除成功；两个项目都不在列表、详情 `404 /errors/not-found` |

后置：脚本删掉临时 PNG；证据为 `docs/test-runs/run-<RUN>-tc-agent-011.txt`（无浏览器，无截图）。

#### `TC-AGENT-018` MCP 写工具的校验、原子性与截图 — 对应 `REQ-AGENT-002`（v0.77）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：`pnpm seed:project --name Mcp18 --device mobile --screens 3 --no-shot`。
脚本 `tests/e2e/mcp.ts`（`ONLY=TC-AGENT-018`），失败项攒齐一起报。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | `update_screen` 对 `/s2` 传 `route:"Not A Route!"`（带原 body） | 调用失败（协议层参数错误）；`/s2` 的路由仍是 `/s2` |
| 2 | `create_screen /shot`（整屏）等截图就绪 = rev1；`update_screen` 出 rev2；`PATCH` 把它改成叠层；`restore_revision` 回到 rev1（`expectedRevisionId` = rev2） | 回溯出的修订 20 s 内有截图，且截图地址里是它自己的修订 id、按叠层拍（`<新修订 id>.overlay.webp`，v1.03 起键带呈现方式，v1.27 起是 WebP），不是 rev1 的 |
| 3 | `append_upload` 用没签发过的 `uploadId`；`create_upload_url` 后对它并发 5 段 `offset:0`（内容各带 `chunk-0`…`chunk-4`）；`create_screen uploadId` 读回；再对这个已用掉的 `uploadId` 追加 | 没签发过的 `404 /errors/not-found`；5 段里 1 段成功、4 段 `409 /errors/upload-offset`；建出的屏里恰好有成功那一段的标记；用掉的 `404 /errors/not-found` |
| 4 | `list_messages` 带 `cursor:"abc"` | 调用失败，但不是 `/errors/internal` |

后置：证据随套件的 `docs/test-runs/run-<RUN>-tc-agent-011.txt`。

#### `TC-AGENT-022` 上传位闲置回收 — 对应 `REQ-AGENT-002`（`API-AGENT-003`、MCP `append_upload`、设计文档 §17 `upload.gc`，v0.82）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：被测 API 用 fs 存储、数据目录在本机（`/v1/config` 的 `home`）；`pnpm seed:project --name Uploads --device mobile --screens 1 --no-shot`。
脚本 `tests/e2e/mcp.ts`（`ONLY=TC-AGENT-022`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | MCP `create_upload_url` 签三个 HTML 上传位 A / B / C，REST `POST …/uploads` 签 D；B 追加一段后丢下，C 追加一段（正在写） | 四个上传位的文件都在 `<home>/objects/uploads/` |
| 2 | 把 A / B / D 文件的修改时间拨回 11 分钟，等至多 75 s | A / B / D 被删（每分钟一轮的 `upload.gc`）；C 还在（修复前 A / B / D 永久留下） |
| 3 | 往 A 追加一段 | `404 /errors/not-found` |
| 4 | C 按 `offset` 续写一段，再 `create_screen` 带 `uploadId: C` | 建屏成功，C 被用掉（文件删除） |

后置：无。

#### `TC-AGENT-023` 投递给本机会话的提示词带目标屏的历史 — 对应 `REQ-AGENT-003`、`REQ-EDIT-002`（`ADR-012` v0.87 修订）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：同 `TC-AGENT-009` 的假会话环境（API 与脚本以同一个 `QUILT_CLAUDE_SESSIONS_DIR` 运行，本机 `claude` 可用；未满足时登记「跳过」）；`pnpm seed:project --name AgentHistory --device mobile --screens 1 --no-shot`；起一个假会话。
模型轮次显式带 `runner:{kind:"model",driver:"stub",model:"stub"}`；建作业遇 `429` 等 5 s 再发。
脚本 `tests/e2e/agent.ts`（`ONLY=TC-AGENT-023`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 对 Screen 1 依次发 `A1 卡片改成两列`、`A2 加一个筛选栏`（模型轮次），各自等结束 | 都 `succeeded` |
| 2 | 交给假会话发 `HANG A3 换成深色`（`runner:{kind:"agent", tool:"claude-code", sessionId}`） | 假会话收到的提示词里有 `EARLIER INSTRUCTIONS ALREADY APPLIED TO SCREEN "Screen 1" (/s1)` 一块，依次 `1. A2 加一个筛选栏`、`2. A1 卡片改成两列`；之后取消这个作业 |
| 3 | 交给假会话对 Screen 1 的 `<h1>` 建 `regenerate_subtree`：`HANG A4 标题加粗` | 提示词里有同一块、同样两条，没有 `A3`；之后取消 |
| 4 | 打开本机 agent 面板（`?panel=agent`），看最新一条 | 目标行写「重生成「Screen 1」的一块」，不写「造新屏」 |

后置：关假会话。

#### `TC-AGENT-024` 改组件交给本机会话 — 对应 `REQ-EDIT-006`、`REQ-AGENT-003`（v0.99）· 级别: 回归 · 执行者: AI（`LLM_DRIVER=stub`）

前置：同 `TC-AGENT-023` 的假会话环境（未满足时登记「跳过」）；`pnpm seed:project --name AgentComponent --device mobile --screens 1 --no-shot`；经 `POST /v1/projects/<id>/components` 建组件 `Footer`（`<footer class="p-4"><p>v1</p></footer>`），经 MCP `quilt.create_screen` 建一屏 `Uses`（`/uses`），屏里放 `<footer data-component="Footer"></footer>`；模型通道（`runner:{kind:"model",driver:"stub",model:"stub"}`）对 `Footer` 发一轮 `C1 加上版权年份`，等它结束。
下文「以会话身份」= 脚本经 MCP 客户端调工具。
脚本 `tests/e2e/agent.ts`（`ONLY=TC-AGENT-024`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 只选 `Footer`、交给假会话发 `HANG C2 文字改成 v2`（`POST messages` 带 `targetComponentIds:[Footer]`、`runner:{kind:"agent", tool:"claude-code", sessionId}`） | `202`，作业 `kind=edit_component`、`runner=agent`；假会话收到的提示词写明 `componentId`、当前 `expectedVersion`、`placed on 1 screen: Uses (/uses)`、`quilt.update_component` 与本作业的 `jobId`，有 `EARLIER INSTRUCTIONS ALREADY APPLIED TO COMPONENT "Footer"` 一块（`1. C1 加上版权年份`），没有 `Target screens` |
| 2 | 作业在跑时取项目详情 | `activeJobs` 里有它（画布据此把 `Footer` 当成「正在改」，挡住检查器直改与再发一轮） |
| 3 | 以会话身份调 `quilt.update_component`：先带一个别的组件与本 `jobId`，再带 `Footer`、本 `jobId` 与过期的 `expectedVersion` | 前者 `400 /errors/validation`（`path: jobId`），后者 `409 /errors/version-conflict`；两次之后两个组件的 `version` 都没变 |
| 4 | 以会话身份带 `Footer`、本 `jobId`、正确版本写 `<footer class="p-4"><p>v2</p></footer>` | 返回的 `applied` 含 `Uses`；`Uses` 最新修订 `sourceKind=component`、HTML 含 `v2` |
| 5 | 以会话身份 `quilt.finish_job { jobId, summary: "文字改成 v2" }`；之后再带这个 `jobId` 调一次 `update_component` | 作业 `succeeded`，`output.screenIds = [Uses]`、`output.component = "Footer"`；助手消息「本机 agent 已更新组件「Footer」，同步 1 屏（Uses）：文字改成 v2」；作业结束后的那次调用 `409 /errors/job-finished` |
| 6 | 再交给假会话发 `HANG C3 背景改成深色`，会话不写组件、直接 `finish_job`；接着交给假会话发 `HANG C4 字号加大`，读提示词后取消 | C3 的助手消息「本机 agent 已完成（没有改组件）」；C4 提示词的历史块依次是 `HANG C2 文字改成 v2`、`C1 加上版权年份`，没有 C3 |
| 7 | 打开本机 agent 面板（`?panel=agent`） | C2 那条目标行写「改组件「Footer」」、完成行「改了组件，同步 1 屏」；C3 那条完成行「没有改组件」 |
| 8 | 对 C2 那一轮发重试（`POST messages/<id>/retry`，带同一个本机会话） | `202`，新作业 `edit_component`、`runner=agent`；取消 |

后置：关假会话，删项目。

#### `TC-AGENT-025` 无状态 MCP 不开 GET 流 — 对应 `REQ-AGENT-001`（`API-AGENT-002`，v1.35）· 级别: 回归 · 执行者: AI · 源自缺陷 2026-10-22 连着 Quilt 的 MCP 客户端每秒重连一次 GET /mcp

前置：无（MCP 套件开头的 `pnpm seed`）。
脚本 `tests/e2e/mcp.ts`（`ONLY=TC-AGENT-025`）。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 不带凭据 `GET /mcp`、`DELETE /mcp`（`Accept: text/event-stream`） | 都是 `405`，响应头 `Allow: POST`（修复前 GET 回 `200` 的 SSE 流、随即关掉） |
| 2 | 用 MCP SDK 的 Streamable HTTP 客户端连上、列工具，之后闲置 10 s，数它发出的 GET | 工具列得出来；10 s 里 GET 至多 1 次（修复前 9 次，约每秒一次） |

后置：无。

## 5. 回归策略

冒烟级 = `TC-CORE-003`、`TC-CORE-005`、`TC-CORE-010`、`TC-CORE-012`、`TC-CORE-018`、`TC-CORE-031`、`TC-PROTO-001`、`TC-AGENT-001`——建项目 → 生成 → 聚焦 → 对话改屏 → 恢复 → 一键安装冷启动，加播放与 MCP 各一条主链路。

- **单测轮**（`pnpm test`，v0.60）：每次改动都跑，在 typecheck 之后、e2e 之前；typecheck 含 `tests/` 自己（`pnpm --filter @quilt/tests typecheck`，v1.06）与前端的 hooks 检查（`pnpm --filter @quilt/web lint`，v1.07）。
  改到界面视觉（`brand/`、`apps/web/src/styles.css` 或组件的类名，v1.08）时，构建前端后再按 `brand/DESIGN.md`「重新生成与检查」对构建出的样式表跑一次 `check-tokens --lint`：渐变、文字阴影、背景模糊 0 命中。
  改到纯函数（注入 / 组件展开 / 大纲 / lint / token / 约定 / 排列算位 / 作业文案 / 历史指令 / 类名说明与换档 / 素材瓦片取色 / 连线几何与过滤 / 作业对账 / 镜头与框选的几何 / iframe 消息的按键与选中）或预览运行时先补或改对应单测再改实现，e2e 只留给要起库、起浏览器才能验的路径。
- **全量轮**（全部用例）：首次成稿、每个里程碑出口、跨功能域改动、地基变更（环境 / 数据模型 / prelude 与 lint 规则 / 运行形态）。
- **局部轮**（受影响用例 + 冒烟级）：单一功能改动。受影响用例 = 本次设计文档改动触及的 `REQ-*` 所对应的 TC（如只改回溯逻辑 → `REQ-CORE-007` → `TC-CORE-014`、`TC-CORE-015`）；无 REQ 变更的改动按功能域圈定；影响面不确定时升级为全量轮。
- **提示词轮**（`TC-CORE-084`，v0.91；`TC-EDIT-037`，v1.05）：改动出屏系统提示词的文字（`craftRules`、`screenSystemPrompt` 的输出规则、默认 DESIGN.md）时跑 `TC-CORE-084`；改动改屏提示词（`editPatchUserPrompt` / `editUserPrompt`）、补丁的套用规则或各类调用的思考深度时跑 `TC-EDIT-037`。
  各按事先登记的通过标准判定；不改这些的改动不跑——它们要真实模型，不进全量轮。
  stub 驱动的 e2e 测不出提示词好坏。
- **草稿本**（v1.13）：`tests/e2e/sketch.ts`（`pnpm --filter @quilt/tests e2e:sketch`，`TC-CORE-098`~`111`）进全量轮，排在 `chat` 之后，它的走查 `TC-CORE-111` 自带复位。
  局部轮里改到 `REQ-CORE-040` / `REQ-CORE-041`，或改到草稿本借用的公共分支点（项目列表与入口落点、建作业校验、出屏 / 改屏提示词与本机会话投递、截图尺寸、项目详情、MCP 工具面，见设计文档 `ADR-030`）时整套跑，另加 `TC-AGENT-011`（MCP 工具数）。
- **界面语言**（v1.20）：`tests/e2e/i18n.ts`（`pnpm --filter @quilt/tests e2e:i18n`，`TC-CORE-130`~`136`）进全量轮，排在 `sketch` 之后。
  其余套件的浏览器一律按 `zh-CN` 开（`tests/e2e/lib.ts` 的 `zhCN`），英文界面只由这一套验。
- **设置、用量与使用记录**（v1.24 / v1.22）：`tests/e2e/settings.ts`（`e2e:settings`，`TC-CORE-140`~`143`）与 `tests/e2e/record.ts`（`e2e:record`，`TC-CORE-144`~`149`）进全量轮，排在 `i18n` 之后、先 `settings` 后 `record`。
  局部轮里改到 `REQ-CORE-008`（台账、`API-CORE-017` / `052`、设置「用量」）跑整套 `settings`，改到 `REQ-CORE-047`（开关、事件批、浏览器采集、模型调用、MCP 包装层、删除与 `storage.gc`）跑整套 `record`。
- **协作显示与作业完成**（v1.32 / v1.33）：`tests/e2e/collab.ts`（`e2e:collab`，`TC-CORE-153`~`157`、`159`）进全量轮，排在 `record` 之后。
  局部轮里改到 `REQ-CORE-048`（身份、协作通道、画布与草稿本的协作层、预览运行时的 `quilt:pointer` / `quilt:peers`）或作业 chip 时整套跑。
- **复测轮**（上轮失败用例 + 冒烟级）：修复失败项之后。
- **人工收口轮**（仅上轮「待人工」用例：`TC-CORE-020`）：AI 轮之后由人工补测收口。

## 6. 执行记录

本节只留最近 10 轮；更早的轮次（RUN-001～RUN-299）原样移到 `docs/TEST-RUNS.md`（v1.07 归档，行序不变），按轮次号 grep 即可定位。

轮次汇总：

| 轮次 | 日期 | 被测版本 | 执行者 | 范围 | 结果 |
| --- | --- | --- | --- | --- | --- |
| RUN-300 | 2026-10-22 | 未提交工作树（设计文档 v1.32 协作显示、v1.33 作业完成 chip） | AI(Claude Code) | 全量至 TC-CORE-157、TC-PROTO-014、TC-EDIT-042、TC-AGENT-024 | 通过 187/204 · 失败 8 · 待人工 2 · 阻塞 1 · 跳过 6 |
| RUN-301 | 2026-10-22 | 未提交工作树（修复前：选元素被全透明的遮罩挡住） | AI(Claude Code) | 局部(TC-CORE-158) | 通过 0/1 · 失败 1 |
| RUN-302 | 2026-10-22 | 未提交工作树（设计文档 v1.32～v1.34：代码审查的 10 处修改、链式跟随与互相跟随、选元素跳过全透明的遮罩） | AI(Claude Code) | 复测(RUN-300:TC-CORE-010、TC-CORE-040、TC-CORE-100、TC-CORE-105、TC-EDIT-041、TC-CORE-130、TC-CORE-142、TC-CORE-039 + RUN-301:TC-CORE-158 + 整套 COLLAB、LOAD、CANVAS、I18N、SETTINGS + 冒烟级至 TC-CORE-159、TC-PROTO-014、TC-EDIT-042、TC-AGENT-024) | 通过 50/54 · 失败 2 · 跳过 2 |
| RUN-303 | 2026-10-22 | 未提交工作树（修复前：`GET /mcp` 回 200 的 SSE 流随即关掉） | AI(Claude Code) | 局部(TC-AGENT-025) | 通过 0/1 · 失败 1 |
| RUN-304 | 2026-10-22 | 未提交工作树（设计文档 v1.35：MCP 的 GET 与 DELETE 回 405，请求日志汇总带各路由的数） | AI(Claude Code) | 局部(整套 MCP、整套 AGENT) | 通过 11/12 · 待人工 1 |
| RUN-305 | 2026-10-22 | 未提交工作树（修复前：选元素时滚动，悬停框停在原处） | AI(Claude Code) | 局部(TC-CORE-160) | 通过 0/1 · 失败 1 |
| RUN-306 | 2026-10-22 | 未提交工作树（设计文档 v1.35～v1.37：MCP 回 405、完成的 chip 收窄、悬停框跟着滚动） | AI(Claude Code) | 局部(整套 EDIT、SKETCH、CANVAS、COLLAB + 冒烟级至 TC-CORE-160、TC-PROTO-014、TC-EDIT-042、TC-AGENT-025) | 通过 82/88 · 失败 3 · 跳过 3 |
| RUN-307 | 2026-10-22 | 未提交工作树（设计文档 v1.38：草稿本选元素一块没选时 Esc 关掉选元素） | AI(Claude Code) | 复测(RUN-306:TC-CORE-119、TC-EDIT-001、TC-EDIT-032) + 局部(TC-CORE-122) | 通过 1/4 · 失败 3 |
| RUN-308 | 2026-10-22 | 未提交工作树（设计文档 v1.39：选元素时没有指针位置的点击按落点元素取） | AI(Claude Code) | 复测(RUN-307:TC-CORE-119、TC-EDIT-001、TC-EDIT-032 + 整套 EDIT、SKETCH、CANVAS + 冒烟级至 TC-CORE-160、TC-PROTO-014、TC-EDIT-042、TC-AGENT-025) | 通过 74/82 · 失败 5 · 跳过 3 |
| RUN-309 | 2026-10-22 | 同 RUN-308 的构建 | AI(Claude Code) | 复测(RUN-308:TC-EDIT-028、TC-EDIT-033、TC-CORE-100、TC-CORE-010、TC-CORE-018 + TC-CORE-003、TC-CORE-031) | 通过 7/7 |

RUN-300 证据：v1.32 协作显示与 v1.33 作业完成 chip 的全量轮。改到项目事件流（有事件就写，presence 走进程内广播）、预览运行时与 e2e 共用的 `tests/e2e/lib.ts`（每个浏览器上下文预置协作者身份），按 §5 跑全量。构建前端，单测 238/238，四个包类型检查、web lint、`gen:runtime --check` 通过。十四套分三条隔离栈并行跑（16:14～17:03，负载均值 30～45）：l1 跑 CORE、LOAD，l2 跑 CANVAS、PROTO、EDIT、COMPONENTS，l3 跑 AGENT、MCP、CHAT、SKETCH、I18N、SETTINGS、RECORD、COLLAB；install 放到 RUN-302。新用例 `TC-CORE-153`～`157` 全部通过：另一个上下文的光标 2 s 内出现，拖卡松手后两边与库里位置一致，跟随中乙关页时甲收到「乙 已离开」；完成的作业 chip 悬停 11 s 不淡出，移开后按剩余时间淡出。8 条失败分三类：`TC-CORE-130`、`142` 是本轮带出来的（presence 上报没带语言头；设置多了「协作」组、用例没跟着改）；`TC-CORE-100`、`105`、`TC-EDIT-041` 在 l3 上单独重跑都通过，与 RUN-289、293 同类，是多栈满载下的超时；`TC-CORE-010`、`040` 在本轮之前的版本上同样失败（见 RUN-302 证据与 §7）；另有 `TC-CORE-023` 是 §7 登记的预期失败。CHAT 套件开头的种子删对象目录时撞上 API 还在写截图（`ENOTEMPTY`），`TC-CORE-039` 没跑成。

RUN-301 证据：用户反映草稿本里 moneynote 选元素只能选中最大的一块。从开发库只读取这张草稿的 HTML，放进 l2 测试库的草稿本复现：选元素态的穿透规则（v0.57，把带 qid 的元素一律设成可点）把收起的底部抽屉里那层全屏、全透明的遮罩也变成可点，它盖在最上面，点哪都选中它。新增源自缺陷用例 `TC-CORE-158`（草稿桩回一张带同样抽屉的账单页），在修复前的运行时上第 1 步失败，选中的是 `div · q6`（遮罩）。

RUN-302 证据：RUN-300、RUN-301 之后的复测轮。两轮之间改了三块：代码审查的 10 处（presence 带语言头、事件流重连宽限 2 s、按 `F`／双击卡片／小地图／找屏也停止跟随、标签页转到后台发 `left`、跟随按人算、新来的人光标立即显示、跨标签页同步身份、名字为空时不提示已保存、事件流队列里同一标签页的 presence 只留最新一条）；v1.34 选元素从指针下自上而下跳过看不见的、以及本来不可点又不画东西的层；链式跟随与互相跟随（状态里带 `following { id, since }`，跟随链看领头人的视野，连成一圈时最后开始跟随的人留下）。单测 243/243，四个包类型检查、web lint、`gen:runtime --check` 通过；构建前端后三条隔离栈并行（17:12～17:28，COLLAB 在这之前单独在 l3 跑；l3 那一路的截图带 `run-302b-` 前缀），停栈后跑 install。`TC-CORE-158` 修复后通过，同一份 moneynote HTML 放进测试库复测，四个点选中了指针下的不同元素。新用例 `TC-CORE-159` 通过：链式跟随时甲、乙的世界层完全一致；乙改跟甲后甲停下并收到提示，之后 2 s 内两边镜头不动；同时互点只留一个在跟随。`TC-CORE-010`、`040` 仍失败，查明都是本轮之前就有的问题：在临时 worktree 里检出 HEAD（v1.31）起 l4 栈，`TC-CORE-040` 单独跑同样失败，检出 v1.29（7ad78fc）也失败；`TC-CORE-010` 拆成每步带 20 s 超时的脚本、三栈并发各跑 3 次，本轮代码卡 1 次、HEAD 卡 3 次。临时 worktree 与调试截图已删。install `TC-CORE-031` 通过：包 970 KB，冷启动 7579 ms、二次 2531 ms。

RUN-303 证据：`/prod-tune` 体检时看开发实例的请求日志：慢请求里 `GET /mcp` 有 264 条，API 每 5 分钟稳定 870 个请求。读 MCP SDK 1.30.0 的客户端源码确认：GET 流正常结束时它按重试次数 0 安排重连，而 Quilt 无状态，每个 GET 都回 `200` 的 SSE 流再立刻关掉，于是每个连着的客户端每秒重连一次、服务端每次现建一个 MCP server。在 l1 测试库上量：一个 SDK 客户端闲置 10 s 发了 9 次 GET。新增源自缺陷用例 `TC-AGENT-025`，修复前第 1 步失败。

RUN-304 证据：v1.35 修复后的局部轮：`GET` / `DELETE /mcp` 不建 server、直接回 `405` 带 `Allow: POST`；请求日志的 5 分钟汇总加上请求最多的 5 个路由与 4xx 最多的 3 组（单测改了断言）。同一个 SDK 客户端闲置 10 s 只发 1 次 GET（拿到 405 即停）。整套 MCP 与 AGENT 在 l1 上通过，`TC-AGENT-010` 待人工。重启开发实例后，API 每 5 分钟的请求从约 870 降到 66，`GET /mcp` 只出现过 3 次 `405`（同期局域网里的人是否离开没核实，这部分降幅分不开）。

RUN-305 证据：用户反映选元素时只悬停不点、滚动页面后悬停框停在原处。运行时滚动时重排了修改标记、选中框与协作者的框，唯独没管悬停框，而指针不动时浏览器不发 mousemove。新增源自缺陷用例 `TC-CORE-160`（草稿桩回一张 30 行的长列表），修复前第 2 步失败。第一次写的滚动量 137 px 恰好约等于 3 行，悬停框与新的一行几乎重合，改成 160 px 后差距明显。

RUN-306 证据：v1.35～v1.37 的局部轮：v1.36 完成的作业 chip 收窄到正好包住对勾与文字（转态时量出在跑时的宽度，用 brand 的 `motion.duration.slow` 与 `motion.easing.emphasized` 过渡；× 平时不占位、悬停或获焦时槽位从 0fr 展开），v1.37 选元素时滚动按上次的指针位置重新取目标、悬停框不带过渡跟上。构建前端，单测 244/244，四个包类型检查、web lint、`gen:runtime --check` 通过，三条隔离栈并行。`TC-CORE-160` 修复后通过；`TC-CORE-157` 新加的宽度断言通过；另在 l3 上逐帧记下转态时的宽度：0 ms 480 px、50 ms 343、100 ms 235、200 ms 201、约 320 ms 停在 195，单调、不回弹。三条失败在 RUN-307 查明是 v1.34 带出的回归。

RUN-307 证据：v1.38 草稿本 Esc 的改动（选元素开着、一块没选时 Esc 关掉选元素）加上 RUN-306 三条失败的单栈复测。`TC-CORE-122` 新加的第二下 Esc 通过；三条失败在单栈、低负载下照样失败，排除负载。原因：v1.34 把选元素的取目标改成按指针坐标逐层找，脚本 `click()` 与键盘在聚焦元素上触发的点击没有指针位置、坐标是 0, 0，于是选成了页面左上角的根。这三条在 RUN-302 里没有跑到，回归随 `f08c44f` 推上去了。

RUN-308 证据：v1.39 修复后的复测轮：`click` 事件的 `detail` 为 0（没有指针位置）时按事件目标取，真实的指针点击与悬停仍按坐标逐层跳过透明层；运行时单测加一条，修复前失败、修复后通过，`TC-CORE-158` 的单测改用带坐标的真实点击。单测 245/245。先在 l2 单独跑 `TC-CORE-119`、`122`、`158`、`160`、`TC-EDIT-001`、`032`，6 条通过；再三条隔离栈并行整套 EDIT、SKETCH、CANVAS 加冒烟级。五条失败都发生在负载均值 111～172 的时段（我这边三条栈，加上机器上别的进程），与选元素无关，RUN-309 单独复测全过。

RUN-309 证据：RUN-308 之后的复测轮，同一构建，只开 l1 一条隔离栈，停栈后跑 install。五条失败全部通过：`TC-EDIT-028` 改元素后的截图 2295 / 2471 / 2850 ms，`TC-EDIT-033` 时限 5 s、截图约 21 s 后作业 succeeded；install `TC-CORE-031` 通过，包 971 KB，冷启动 8086 ms、二次 2020 ms。

明细（仅登非「通过」项）：

| 轮次 | 用例 | 结果 | 现象 / 证据 | 跟进 |
| --- | --- | --- | --- | --- |
| RUN-300 | TC-CORE-010 | 失败 | 单步超过 10 min：第二次在 iframe 里按 `⌘E` 退出交互后脚本不再返回，页面停在退出后的状态（证据：`docs/test-runs/run-300-tc-core-010-fail.png`、`.e2e/l1/run-300.log`，本机） | 既有问题，HEAD 上同现，见 §7 |
| RUN-300 | TC-CORE-040 | 失败 | 第 3c 步双击 /s1 超时：3a 点小地图右侧空白后 /s1 移出视口（证据：`docs/test-runs/run-300-tc-core-040-fail.png`） | 既有问题，v1.29、v1.31 上同现，见 §7 |
| RUN-300 | TC-CORE-100 | 失败 | 「记录栏应多出这一张」：三栈并行满载（证据：`.e2e/l3/run-300.log`，本机） | 单独重跑通过；RUN-302 复测通过 |
| RUN-300 | TC-CORE-105 | 失败 | 「看板应为 empty，实际 generating」：三栈并行满载（证据：`.e2e/l3/run-300.log`，本机） | 单独重跑通过；RUN-302 复测通过 |
| RUN-300 | TC-EDIT-041 | 失败 | 第 4 步 Shift+↑ 后层级不对、取框超时：三栈并行满载（证据：`.e2e/l3/run-300.log`，本机） | 单独重跑通过；RUN-302 复测通过 |
| RUN-300 | TC-CORE-130 | 失败 | 「/v1 请求应都带 X-Quilt-Locale」：协作上报 `POST …/presence` 没带语言头（证据：`.e2e/l3/run-300.log`，本机） | 修复：上报与 `left` 都带语言头；RUN-302 通过 |
| RUN-300 | TC-CORE-142 | 失败 | 「三组小标题应依次是 外观 / 语言 / 使用记录」：v1.32 多了「协作」组，用例没跟着改 | 设计文档 §13 与用例改成四组；RUN-302 通过 |
| RUN-300 | TC-CORE-039 | 阻塞 | CHAT 套件开头 `pnpm seed` 删对象目录时撞上 API 还在写截图（`ENOTEMPTY`），整套没跑（证据：`.e2e/l3/run-300.log`，本机） | RUN-302 通过 |
| RUN-300 | TC-CORE-023 | 失败 | 预期失败（§7 登记项）：让位过度，输入框右缘与面板之间空出 84.5px | §7 跟进 |
| RUN-300 | TC-CORE-020 | 待人工 | 对标 Stitch 盲评 | 待人工 |
| RUN-300 | TC-AGENT-010 | 待人工 | 投递到真实 Claude Code 会话要在终端确认接收 | 待人工 |
| RUN-300 | TC-CORE-005 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-300 | TC-CORE-006 | 跳过 | 需 `LLM_STUB=503` 重启 worker，由 `core-stub.ts` 单独执行 | 基线 |
| RUN-300 | TC-CORE-012 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-300 | TC-EDIT-003 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-300 | TC-PROTO-004 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-300 | TC-PROTO-009 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-301 | TC-CORE-158 | 失败 | 第 1 步「应选中标题 h1 · q2」，实际选中 `div · q6`（全透明的遮罩），与用户在 moneynote 上看到的一致（证据：`docs/test-runs/run-301-tc-core-158-fail.png`） | 修复后 RUN-302 通过 |
| RUN-302 | TC-CORE-010 | 失败 | 同 RUN-300：单步超过 10 min（证据：`.e2e/l1/run-302.log`，本机） | 既有问题，见 §7 |
| RUN-302 | TC-CORE-040 | 失败 | 同 RUN-300：第 3c 步双击 /s1 超时（证据：`.e2e/l1/run-302.log`，本机） | 既有问题，见 §7 |
| RUN-302 | TC-CORE-005 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-302 | TC-CORE-012 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-303 | TC-AGENT-025 | 失败 | 第 1 步「GET /mcp 应 405 且 Allow: POST，实际 200 null」，与开发实例上看到的重连一致 | 修复后 RUN-304 通过 |
| RUN-304 | TC-AGENT-010 | 待人工 | 投递到真实 Claude Code 会话要在终端确认接收 | 待人工 |
| RUN-305 | TC-CORE-160 | 失败 | 第 2 步「滚动后悬停框应跟到指针下那一行」：悬停框上沿停在 144，指针下的第 7 笔在 166（证据：`docs/test-runs/run-305-tc-core-160-fail.png`） | 修复后 RUN-306 通过 |
| RUN-306 | TC-CORE-119 | 失败 | 第 3 步检查器里带一块建的草稿不是组件画框（证据：`docs/test-runs/run-306-tc-core-119-fail.png`、`.e2e/l2/run-306.log`，本机） | v1.34 带出的回归：脚本 `click()` 的坐标是 0, 0，选成了页面根；v1.39 修复，RUN-308 通过 |
| RUN-306 | TC-EDIT-001 | 失败 | 等直改后的角标 8 s 超时（证据：`docs/test-runs/run-306-tc-edit-001-fail.png`） | 同上 |
| RUN-306 | TC-EDIT-032 | 失败 | 等组件里的元素选中 15 s 超时（证据：`docs/test-runs/run-306-tc-edit-032-fail.png`） | 同上 |
| RUN-306 | TC-CORE-005 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-306 | TC-CORE-012 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-306 | TC-EDIT-003 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-307 | TC-CORE-119 | 失败 | 同 RUN-306；单栈、低负载下照样失败，排除负载（证据：`docs/test-runs/run-307-tc-core-119-fail.png`） | v1.39 修复，RUN-308 通过 |
| RUN-307 | TC-EDIT-001 | 失败 | 同 RUN-306（证据：`docs/test-runs/run-307-tc-edit-001-fail.png`） | 同上 |
| RUN-307 | TC-EDIT-032 | 失败 | 同 RUN-306（证据：`docs/test-runs/run-307-tc-edit-032-fail.png`） | 同上 |
| RUN-308 | TC-EDIT-028 | 失败 | ② 改元素后的截图 4040 / 3593 / 3262 ms，超过 3 s；三栈并行、负载均值 111～172（证据：`docs/test-runs/run-308-tc-edit-028-fail.png`） | RUN-309 单独复测通过（2295 / 2471 / 2850 ms） |
| RUN-308 | TC-EDIT-033 | 失败 | 「重启命令退出码 1」：同一满载时段（证据：`.e2e/l1/run-308.log`，本机） | RUN-309 单独复测通过 |
| RUN-308 | TC-CORE-100 | 失败 | 「记录栏应多出这一张」：同一满载时段（证据：`.e2e/l2/run-308.log`，本机） | RUN-309 单独复测通过 |
| RUN-308 | TC-CORE-010 | 失败 | 单步超过 10 min，§7 登记的既有问题（证据：`docs/test-runs/run-308-tc-core-010-fail.png`） | RUN-309 单独复测通过；仍见 §7 |
| RUN-308 | TC-CORE-018 | 失败 | 等待 30 s 超时，排在 `TC-CORE-010` 挂满 10 min、换页之后（证据：`docs/test-runs/run-308-tc-core-018-fail.png`） | RUN-309 单独复测通过 |
| RUN-308 | TC-CORE-005 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-308 | TC-CORE-012 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |
| RUN-308 | TC-EDIT-003 | 跳过 | `LIVE_LLM=0`，需真实模型 | 基线 |

## 7. 遗留问题

- **`TC-CORE-010` 焦点在 iframe 里按键让 iframe 卸载时，脚本偶尔不再返回**（RUN-300、RUN-302，HEAD 同现）：第二次在聚焦屏的 iframe 里按 `⌘E` 退出交互（或按 `Esc`），页面照常退出、停在退出后的状态，但 Playwright 的按键调用一直不返回，单步 10 min 超时。
  拆成每步带 20 s 超时的脚本、三栈并发各跑 3 次：本轮代码卡 1 次，HEAD（v1.31）卡 3 次，都卡在这一下；单独跑不卡。推测是按键回执要等的那个 iframe 已经拆掉，负载高时更容易撞上，未证实。真实用户按键不受影响。
  修法方向：脚本里这两次按键加超时，超时后换一个新页面接着跑后面的用例。
- **`TC-CORE-040` 第 3c 步双击 /s1 够不着**（RUN-300、RUN-302；v1.29 与 v1.31 上单独跑同样失败，RUN-293 时通过）：第 3a 步按小地图视口框的位置决定点左侧还是右侧空白，点在右侧时镜头右移、/s1 出了视口，第 3c 步的双击随即超时。
  点哪一侧取决于上一步屏列表面板收起、镜头动画有没有走完；脚本假设 3c 时 /s1 还在视口里，这个假设不稳。
  修法方向：3c 双击前先用 `⌘K` 把 /s1 摆回可用区中央。
- **`TC-CORE-058` 第 8 步小地图松手后视口框跳到一半的位置**（RUN-284、RUN-290，时过时不过；v1.23 的构建上就出现过）：缩放 0.1 下拖小地图的视口框，松手前 `data-view` 是 `22.4 16.0 153.6 96.0`，松手后变成 `11.2 8.0 153.6 96.0`，两次数值相同。
  推测是组件卡量完尺寸后小地图的外接框重算，正好撞在拖动途中（拖动时外接框冻结，松手才用新框），未证实、没有修。
- **`TC-CORE-023` 在打包形态的隔离栈上失败**（RUN-112 / 114 / 115，HEAD 同现）：失败点在「刷新 / 叫回后输入框位置或焦点未复原」之间漂移，开发实例（3100 + Vite）上 RUN-111 通过。
  需在开发实例上复测定性。
  RUN-186～189 在输入框选中桩通道后（第 7 步「让位过度」随之消失）7 次单跑与整套仍全部失败，失败点在「叫回后安全区底部没复原」「重新展开后输入框没回到原位」之间漂移，RUN-189 还出现一次「Esc 未退出聚焦」（第 6d 步）。
  RUN-278 第 8b～8d 步通过、停在第 9b 步「让位过度」：脚本没先清掉 8d 留下的选中，输入框在改态（30rem）碰不到面板，按 clamp 规则本就不让位；RUN-279 起 9b 前先按 `Esc` 回到造态。RUN-279 又停在 8b「叫回后安全区底部没复原」，改过的 9b 还没有跑到过。
- **聊天回合经 `quilt.edit_element` 改的屏不记在聊天作业名下**（RUN-125，`TC-CORE-039` 第 3 步）：`edit_element` 不收 `jobId`，修订记为 `manual`，聊天回执与 `affectedScreenIds` 漏掉这一屏（画布经项目事件流照常刷新）。
  修法方向：`edit_element` 与 `patch_screen` 一样接受 `jobId` 并记 `agent_ingest`，或聊天系统提示里要求改屏一律带 `jobId` 的工具。

- **输入框切聊天再切回后，本机通道记忆被清空**（RUN-236，`TC-CORE-046` 第 1 步，HEAD 的前端包上同现）：选了 Stub 通道、切到聊天、再切回造 / 改，选择器显示的仍是 Stub 通道，但 `localStorage['quilt:runner']` 变成空，刷新后记忆丢失。
  v0.74 修过同一现象，此后何时回归未查，没有修。
- **`⌘K` 找屏连按 `↓` 到底后选中行跳回**（RUN-212 / 213，`TC-CORE-047` 第 2 步，改动前的代码同现）：14 屏、先开过修订面板并加选 / 单选过屏之后打开 `⌘K`、输入 `/s`，连按 `↓`，选中行走到第 14 行后又跳回第 6～7 行；直接打开 `⌘K` 不跳。
  RUN-200 在另一套隔离栈上通过，原因未查，没有修。
- **对话记录折叠横条的进度未修**（v0.38 查出，实现与设计文档 §13 不符）：`Canvas.tsx` 给 ChatDock 的 `status` 在「恰好一个作业在跑且它还没有进度文案」时是 `null`，横条于是退回「对话 · N 条」。
  在跑作业行已按 v0.38 兜底写「排队中…」，横条那一路的兜底要在 Canvas 侧收敛（把「空进度说什么」收成一个出处），暂无用例覆盖。
- **整组造屏的入口屏仍可能撞修订冲突**（设计文档 §16 真值表缺口行）：规划器返回的 `entryFrom` 在作业跑起来之后才知道，前端的覆盖屏集与后端的 `target_screen_id` 都看不见它；现无自动用例，触发后表现为改屏作业 `failed（revision conflict）` 或入口屏的跳转静默没接上。
- 本机 agent 的投递通道（Claude Code 会话登记处 + inbox socket）未文档化：`TC-AGENT-009` 用假会话验的是 Quilt 这一侧的读法与写法，真实会话只有 `TC-AGENT-010`（人工）能证明；Claude Code 升级后若该用例失败，先查登记文件格式与 `peerProtocol`（设计文档 §28 风险）。
  Codex 未接入（v0.34 推迟，`codex queue --thread` 是文档化的投递命令）。
- **投递到真实 Claude Code 会话没有通过记录**（v1.06 审查 TEST-3）：v0.34 改成写会话 inbox socket 之后，`TC-AGENT-010` 每轮都是「待人工」；唯一一次真实会话通过是 RUN-085，走的还是之前的 `claude -p`。
  本机现在的 Claude Code 2.1.287 每个会话在登记处多一份 0600 的 `.key`、登记里多了 `peerFeatures`，Quilt 不读 key，投递按「写入成功即已投递」判定。
  已验证版本：无——`VERIFIED_CLAUDE_VERSIONS` 为空，会话下拉里所有 Claude Code 会话都标「此版本未验证」。
  待人工跑 `TC-AGENT-010` 并按它的后置登记版本；若收件方开始校验 key，按设计文档 §28 的后备方案（`claude -p --resume <id> --fork-session`）评估。
- **390 宽时英文输入框的动词行与通道下拉被截**（RUN-278 的英文界面核对，截图在仓库外 `Quilt-wt/fix-tools/scratch/i18n/en-60-canvas-390.png`、`en-66-sketch-390.png`）：画布上动词行「Generate screens · Hand to local session」只露出 140 / 231 px；草稿本里通道下拉「Hand to local Claude Code」只露 39 px（「Han…」），中文露 82 px、动词行不截。
  改短文案装不下（动词行可用宽只有 140 px），要动窄屏下输入框的排法：通道名由服务端按语言给（`channels.ts`），本机 agent 面板按「Hand to local 」前缀剥名字，改名时两处一起改。没有修。
- **画布页 console 每次聚焦报一条 CSP 错误**（v1.06 浏览器核对时看到，改动前同现）：`The Content-Security-Policy directive 'frame-ancestors' does not support the source expression 'http://[::1]:3410'`。
  `apps/api/src/lib/origin.ts` 的回环地址展开成 `localhost` / `127.0.0.1` / `[::1]` 三种写法，来源校验用它没问题，`preview.ts` 拿同一份名单写 `frame-ancestors`，而 CSP 的来源表达式写不了 IPv6 字面量，浏览器丢掉这一项并报错；其余两项照常生效，聚焦不受影响。
  修法方向：写 `frame-ancestors` 时滤掉带方括号的主机。
