<p align="center">
  <img src="apps/web/public/brand/symbol-graphite.svg" width="88" alt="Quilt" />
</p>

<h1 align="center">Quilt</h1>

<p align="center">
  AI 原生的无限画布设计工具。<br/>
  一句话描述 APP，得到风格一致的多屏 HTML 设计稿，摆在无限画布上浏览、交互、迭代、串成可点击原型；<br/>
  本机的编码 agent 通过 MCP 双向读写画布。
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
  <img src="https://github.com/user-attachments/assets/1ea5205f-6e0c-42e3-bb31-c4633aa4a9ec" width="900" alt="在输入框里写一句话，画布上落下一整套多屏设计稿" />
</p>

---

Quilt 整个跑在你自己的机器上：一个进程，无账号，无云端后台，数据在 `~/.quilt`。生成走你选的通道：本机 Claude 订阅（`claude` CLI 的登录态）、Anthropic / Gemini / OpenAI 兼容端点的 API Key，或者你已经开着的一个 Claude Code 会话。

## 能做什么

- **造**。输入 APP 是什么。规划器排出 4–6 屏的主流程（或你指定的 1–4 屏），每屏按项目设计系统生成为自包含 HTML，经 lint、截图后落到画布。每屏可要 1–4 版候选，看中哪版采用哪版。在跑的作业是输入框上方的一枚枚 chip；失败的留在那里写明原因，能原样重试的带「重试」。
- **改**。选中屏、说改动。在聚焦的屏里按 `⌘E` 点选任意元素：文案、类名、跳转目标直改零 token；只让 AI 重生成这一块；或者给元素挂批注、攒够一起发。新的一版在活屏里原地换上。
- **草稿本**。项目之外的一整页画板，专门出单个组件或页面。一句话出稿，用点选改一块或批注细调，在各版之间来回切，满意了写回项目：落成新屏、覆盖一整屏，或者只换掉其中一块。
- **无限画布**。截图平铺、平移缩放、拖动摆放、多选对齐与等距（一键排成一行 / 一列），位置持久化。`⌘K` 按名字、路由或用途跳到一屏；屏列表面板按断链 / 待采用候选 / 偏离 / 进行中筛选；小地图显示全部卡片与视口。双击一屏进入聚焦态，它变成活 iframe，可滚动、可输入、可点击。输入框能停在左、右、下三条边，也能收成一枚贴边胶囊。
- **原型播放**。链接、表单提交、`data-href` 按钮在聚焦 iframe 内跳屏，状态保留、可后退。把屏标成「叠层」（底部弹层、对话框），它就压在打开它的那一屏上面，而不是替换掉。给屏加「状态变体」（空态、出错、未登录……），同路由同版式，播放时可切换。应用地图从 HTML 派生，断链标红、一键接上，缺失路由可懒生成。整套导出为单文件 HTML，离线可开。
- **设计系统**。种子色派生 Material 3 token、`DESIGN.md` 与组件配方；可挂显式品牌色板（亮 / 暗各一套）、上传 logo 与素材、整套存成预设给下个项目用。改 token 后确定性回刷全部屏。
- **共享组件**。把导航栏、顶栏、侧栏记为项目级组件，和屏并排放在画布上。屏引用它、不复制代码：每次写入时 Quilt 填入正式 HTML，并按路由标出激活项。改组件一次（手改、输入框、或经 MCP），所有用它的屏零模型调用同步。
- **修订树**。每次生成、编辑、agent 写入都是一条带父修订的修订。可回溯任意一版，候选分支保留，随时采用。
- **通道**。设置页管理生成通道：Anthropic、Gemini（AI Studio 或 Vertex）、OpenAI 兼容端点、本机 Claude 订阅、运行中的 Claude Code 会话。密钥加密落库，用量台账按作业记 token。
- **MCP 双向**。编码 agent 连 `http://127.0.0.1:3100/mcp`，拿到 57 个工具与 7 个资源，画布与草稿本能做的事都能经它做。反过来 Quilt 也能把作业派给一个运行中的 Claude Code 会话并等它收口。

<p align="center">
  <img src="https://github.com/user-attachments/assets/5b94045a-2802-41d7-bb20-36443b906bec" width="760" alt="在聚焦的屏里点选一个元素，就地改它" />
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

生成的屏是带 Tailwind class 与项目 token 的普通 HTML，元素带稳定 id，编辑与批注能精确定位到子树。预览域与画布不同 origin，生成的脚本拿不到工具自己的存储。

`docs/DESIGN.md` 是需求、数据模型、接口契约、状态机与 ADR 的单一事实源；`docs/TEST.md` 是每次改动都要过的验收台账。

## 快速开始

前置：

- Node.js 22 或更新，pnpm 11
- 本机装有 Chrome 或 Edge（截图用）；都没有就跑一次 `npx playwright install chromium`
- 一条生成通道：`claude` CLI 已登录（默认 `LLM_DRIVER=agent-sdk`），或 Anthropic / Gemini 的 API Key，或在设置页添加 OpenAI 兼容端点

### 跑打包版

```sh
pnpm install
pnpm build                       # 构建前端与 apps/cli/dist
node apps/cli/bin/quilt.js       # 包发布后也可以 npx quilt-canvas
```

首次运行建 `~/.quilt`（内嵌 PGlite 数据库、对象存储、带生成密钥的 `config.env`），跑迁移，打开 `http://127.0.0.1:3100`。之后在同一个目录再跑，所有项目都在。

参数：`--home <dir>` 换数据目录，`--port` / `--preview-port`（缺省 3100 / 3101），`--no-open`。

改 `~/.quilt/config.env` 换缺省通道：

```
LLM_DRIVER=agent-sdk      # agent-sdk（本机 Claude 订阅）| anthropic | gemini
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

### 从源码跑（开发）

```sh
pnpm install
cp .env.example .env             # DATABASE_URL 留空即用内嵌 PGlite
docker compose up -d             # 可选：保留 DATABASE_URL 时起 127.0.0.1:5439 的 Postgres
pnpm dev                         # API + Worker + 预览域在 3100/3101，Vite 在 6688
```

打开 `http://localhost:6688`。API 启动时自动跑迁移。`.env.example` 里每个键都写了说明。

## 接入编码 agent

```sh
claude mcp add --transport http quilt http://127.0.0.1:3100/mcp
```

服务只绑回环地址，所以免鉴权。57 个工具覆盖画布能做的一切：项目（`quilt.list_projects`、`create_project`、`get_project`、`update_project`、`delete_project`）；读取（`get_outline`、`get_screen`、`get_screenshot`、`get_revision`、`list_revisions`、`list_candidates`、`get_design_contract`、`get_app_map`、`list_assets`、`list_annotations`、`list_messages`、`list_jobs`、`get_job`、`get_job_events`、`list_runners`、`list_design_presets`）；写屏（`validate_screen`、`create_screen`、`update_screen`、`patch_screen`、`create_upload_url`、`append_upload`、`link_screens`、`move_screens`、`edit_element`、`restore_revision`、`adopt_candidate`、`delete_screen`）；草稿本（`get_sketchbook`、`create_draft`、`copy_draft`）；共享组件（`create_component`、`update_component`、`delete_component`）；设计系统（`update_design_system`、`create_design_preset`、`apply_design_preset`、`delete_design_preset`、`create_asset`、`delete_asset`）；模型作业（`generate_screens`、`edit_screens`、`regenerate_subtree`、`edit_component`、`propose_design_system`、`export_prototype`、`get_export`、`cancel_job`、`finish_job`）；批注（`update_annotation`、`delete_annotation`、`send_annotations`）。只有通道设置（API Key）留在设置页。资源：`design-md`、`tokens`、`app-map`、`golden`、`screen-html`、`screen-screenshot`、`attachment`。

建议 agent 先 `get_outline`（每屏一份紧凑的结构摘要）再 `get_screen`（整屏 HTML）。写入要小：改一部分用 `patch_screen`（在正文上查找替换），超过约 8 KB 的屏用 `create_upload_url` 加几次 `append_upload` 分块写——一个很长的工具参数会让流式响应中途断开（「Connection lost mid-response」）。写入都带 `expectedRevisionId`，基线过期返回 409，两个写入方不会互相覆盖。

反方向：输入框通道选「交给本机 Claude Code」，再选一个运行中的会话。Quilt 把提示词投递进那个会话，会话经同一个 MCP 回写并收口作业。

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

e2e 套件在 `tests/e2e`（`core`、`load`、`canvas`、`proto`、`edit`、`components`、`agent`、`mcp`、`chat`、`sketch`、`install`）；`scripts/e2e-all.sh` 按顺序把它们跑在 `scripts/e2e-stack.sh` 起的隔离栈上。它们会清空所指向的库，所以 API 连的库名不以 `_test` 结尾就拒绝运行。`LIVE_LLM=0` 跳过真实模型调用。环境细节见 `docs/TEST.md` §3。

改动纪律：先改 `docs/DESIGN.md`，再改代码，再同步 `docs/TEST.md` 受影响的用例，执行并登记一轮。

## 状态

v1.19，本地单用户版。手机与桌面两种形态的屏，外加草稿本里不限形态的组件与页面草稿。推迟而非放弃：多用户 SaaS（登录、配额、远程派活）。不在范围内：多人实时协作、生成生产级 React 工程代码、原生端渲染。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
