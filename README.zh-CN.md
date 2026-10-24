<p align="center">
  <img src="apps/web/public/brand/symbol-graphite.svg" width="88" alt="Quilt" />
</p>

<h1 align="center">Quilt</h1>

<p align="center">
  AI 原生的无限画布设计工具。<br/>
  一句话描述 APP，得到风格一致的多屏 HTML 设计稿，在无限画布上浏览、改稿、串成可点击原型；<br/>
  本机的编码 agent 经 MCP 读写画布。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Bearisbug/Quilt?color=blue" alt="许可证：Apache-2.0" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white" alt="Node.js 22 或更新" /></a>
  <a href="https://github.com/Bearisbug/Quilt/stargazers"><img src="https://img.shields.io/github/stars/Bearisbug/Quilt?style=flat&logo=github" alt="GitHub Stars" /></a>
  <br/>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white" alt="Hono" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS 4" />
  <img src="https://img.shields.io/badge/PGlite-embedded_Postgres-336791?logo=postgresql&logoColor=white" alt="PGlite" />
  <img src="https://img.shields.io/badge/MCP-Streamable_HTTP-6E56CF" alt="MCP（Streamable HTTP）" />
</p>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/d080a7f0-f4ec-4027-a4e7-62a14f0cf7a2" width="900" alt="在输入框里写一句话，画布上落下一整套多屏设计稿" />
</p>

---

Quilt 跑在你自己的机器上：一个进程，不要账号，没有云端后台，数据在 `~/.quilt`。生成走你选的通道：本机 Claude 订阅（`claude` CLI 的登录态）、Anthropic / Gemini / OpenAI 兼容端点的 API Key，或者你已经开着的 Claude Code 会话。

## 能做什么

- **造**：写一句 APP 是什么。Quilt 排出 4–6 屏的主流程（或你指定的 1–4 屏），每屏按项目的设计系统生成为自包含 HTML，过 lint、截图后摆上画布。每屏最多要 4 版候选，挑一版采用。
- **改**：选中屏，说要怎么改。在聚焦的屏里按 `⌘E` 点选任意元素：文案、类名、跳转目标直接改，不花 token；或者让 AI 只重生成这一块。
- **草稿本**：项目之外的一整页画板，出单个组件或页面。一句话出稿，点选元素细调，在各版之间切换，满意了放进项目：落成新屏、覆盖一屏，或只换掉其中一块。
- **画布**：平移、缩放、拖动、对齐与等距；`⌘K` 跳到任意一屏，小地图和可筛选的屏列表管住大项目。双击一屏直接在里面操作。
- **原型**：链接、表单提交、`data-href` 按钮在屏之间跳转，状态保留、可后退。叠层屏（底部弹层、对话框）压在当前屏上打开；状态变体（空态、出错、未登录）共用一个路由。断链标红，一键接上。整套原型导出成一个离线 HTML 文件。
- **设计系统**：种子色或显式品牌色板（亮 / 暗各一套）派生 token、`DESIGN.md` 与组件配方；可上传素材、存成预设，改 token 后全部屏跟着回刷。
- **共享组件**：导航栏、顶栏、侧栏作为组件放在画布上，改一次，用到它的屏全部跟上，不调模型。
- **修订**：每次生成、改稿、agent 写入都是一版修订，可以回到任意一版。
- **一起看**：同一局域网里打开同一个项目的人，互相看到光标、选中和视野，可以跟随对方。
- **设置**：生成通道（密钥加密存储）、按天 / 模型 / 项目 / 任务类型展开的用量看板、可选的本机使用记录（界面操作与模型调用），界面可切中文或英文。
- **MCP 双向**：编码 agent 连 `http://127.0.0.1:3100/mcp`，拿到 53 个工具和 7 个资源；Quilt 也能把作业交给一个运行中的 Claude Code 会话。

<p align="center">
  <img src="https://github.com/user-attachments/assets/b48a0371-2a3e-4319-b205-431a3243380a" width="900" alt="在聚焦的屏里点选一个元素，就地改它" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/39bf3d63-f301-40b5-9839-0324ea671732" width="900" alt="在草稿本里一句话出一页草稿" />
</p>

## 怎么运转

```
浏览器（React 19 画布）──REST / SSE──▶ quilt 进程（Hono，127.0.0.1:3100）
                      ◀─iframe────────  预览域（127.0.0.1:3101，只读 HTML）
                                        ├─ 进程内队列 + Worker（LLM 调用、lint、注入、截图）
                                        ├─ MCP server（Streamable HTTP，与 REST 共用服务层）
                                        ├─ 接口上的聊天作业（Claude Agent SDK 子进程，走同一个 MCP）
                                        └─ agentDelivery（把作业投递给本机 Claude Code 会话）
                                        ~/.quilt：PGlite 数据库 · objects/ · config.env
```

屏是带 Tailwind class 和项目 token 的普通 HTML，元素带稳定 id，改稿能精确到一块。预览跑在另一个 origin 上，生成的脚本碰不到 Quilt 自己的存储。

`docs/DESIGN.md` 是单一事实源：需求、数据模型、接口契约、状态机与 ADR。`docs/TEST.md` 是用例库，也记着每一轮测试的结果。

## 快速开始

前置：

- Node.js 22 或更新，pnpm 11
- 本机装有 Chrome 或 Edge（截图用）；都没有就跑一次 `npx playwright install chromium`
- 一条生成通道：`claude` CLI 已登录（默认，`LLM_DRIVER=agent-sdk`），或 Anthropic / Gemini 的 API Key，或在设置里添加 OpenAI 兼容端点

### 跑打包版

```sh
pnpm install
pnpm build                       # 构建前端与 apps/cli/dist
node apps/cli/bin/quilt.js       # 包发布后也可以 npx quilt-canvas
```

首次运行建 `~/.quilt`（内嵌 PGlite 数据库、对象存储、带生成密钥的 `config.env`），跑迁移，打开 `http://127.0.0.1:3100`。之后在同一个目录再跑，项目都还在。

参数：`--home <dir>`，`--port` / `--preview-port`（缺省 3100 / 3101），`--no-open`。缺省通道在 `~/.quilt/config.env` 里改：

```
LLM_DRIVER=agent-sdk      # agent-sdk（本机 Claude 订阅）| anthropic | gemini
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

### 从源码跑

```sh
pnpm install
cp .env.example .env             # DATABASE_URL 留空即用内嵌 PGlite
docker compose up -d             # 可选：设了 DATABASE_URL 时起 127.0.0.1:5439 的 Postgres
pnpm dev                         # API + Worker + 预览域在 3100/3101，Vite 在 6688
```

打开 `http://localhost:6688`。API 启动时自动跑迁移；`.env.example` 里每个键都写了说明。

## 接入编码 agent

```sh
claude mcp add --transport http quilt http://127.0.0.1:3100/mcp
```

服务只监听回环地址，所以不鉴权。画布和草稿本能做的事都有对应的工具，只有 API Key 留在设置页。

先用 `get_outline`（每屏一份紧凑摘要）再 `get_screen`。写入要小：改一部分用 `patch_screen`，超过约 8 KB 的屏用 `create_upload_url` 加几次 `append_upload` 分块写，一个很长的工具参数会让模型的流式响应中途断掉。写入带 `expectedRevisionId`，基线过期返回 409，两个写入方不会互相覆盖。

反方向：在输入框把通道选成「交给本机 Claude Code」，再选一个运行中的会话。Quilt 把提示词投递进去，会话经同一个 MCP 回写并收口作业。

<details>
<summary>全部 53 个工具与 7 个资源</summary>

- 项目：`quilt.list_projects`、`create_project`、`get_project`、`update_project`、`delete_project`
- 读取：`get_outline`、`get_screen`、`get_screenshot`、`get_revision`、`list_revisions`、`list_candidates`、`get_design_contract`、`get_app_map`、`list_assets`、`list_messages`、`list_jobs`、`get_job`、`get_job_events`、`list_runners`、`list_design_presets`
- 写屏：`validate_screen`、`create_screen`、`update_screen`、`patch_screen`、`create_upload_url`、`append_upload`、`link_screens`、`move_screens`、`edit_element`、`restore_revision`、`adopt_candidate`、`delete_screen`
- 草稿本：`get_sketchbook`、`create_draft`、`copy_draft`
- 共享组件：`create_component`、`update_component`、`delete_component`
- 设计系统：`update_design_system`、`create_design_preset`、`apply_design_preset`、`delete_design_preset`、`create_asset`、`delete_asset`
- 模型作业：`generate_screens`、`edit_screens`、`regenerate_subtree`、`edit_component`、`propose_design_system`、`export_prototype`、`get_export`、`cancel_job`、`finish_job`
- 资源：`design-md`、`tokens`、`app-map`、`golden`、`screen-html`、`screen-screenshot`、`attachment`

</details>

## 仓库结构

```
apps/api        Hono 服务：REST、MCP、SSE、预览域、进程内 Worker、Drizzle schema 与迁移
apps/web        Vite + React 19 + Tailwind 4 画布与草稿本
apps/cli        用 esbuild 把 api + core + web 捆成 npm 包 quilt-canvas
packages/core   共享层：zod schema、提示词契约、lint 规则、运行时注入、导出、token、大纲
tests/unit      core 与画布里纯函数的 node:test 单测（pnpm test）
tests/e2e       按 docs/TEST.md 用例执行的 Playwright 脚本
docs/CHANGELOG.md 从 DESIGN.md / TEST.md 移出来的较早变更记录
docs/DESIGN.md  设计文档（需求、数据模型、接口契约、状态机、ADR）
docs/TEST.md    用例库（带 REQ 追溯）与执行记录
CLAUDE.md       编码 agent 参与本仓库时的工作纪律
```

## 开发

```sh
pnpm typecheck                   # core / api / web 三处 tsc
pnpm test                        # 单测（node:test，约 1.5 s，不需要数据库与浏览器）
pnpm build                       # 前端 + CLI 包
pnpm seed                        # 清空 DATABASE_URL 指向的库并建两个示例项目
pnpm mcp:call <tool> '<json>'    # 对运行中的服务调一个 MCP 工具
```

`tests/e2e` 里的端到端套件跑在隔离栈上（`scripts/e2e-stack.sh` 起栈，`scripts/e2e-all.sh` 按顺序全跑）。它们会清空所指向的库，库名不以 `_test` 结尾就拒绝开跑。`LIVE_LLM=0` 跳过需要真实模型的步骤；环境细节见 `docs/TEST.md` §3。

每次改动都按同一个顺序：先改 `docs/DESIGN.md`，再改代码，再同步 `docs/TEST.md` 受影响的用例，执行并登记一轮。

## 状态

v1.42，本地版：装在一台机器上，同一局域网里的人可以一起打开。手机与桌面两种屏，外加草稿本里不限形态的草稿。推迟而非放弃：多用户 SaaS（登录、配额、远程派活）。不在范围内：生成生产级 React 工程代码、原生端渲染。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
