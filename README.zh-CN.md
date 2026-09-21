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
  <a href="README.md">English</a> · 中文
</p>

---

Quilt 整个跑在你自己的机器上：一个进程，无账号，无云端后台，数据在 `~/.quilt`。生成走你选的通道：本机 Claude 订阅（`claude` CLI 的登录态）、Anthropic / Gemini / OpenAI 兼容端点的 API Key，或者你已经开着的一个 Claude Code 会话。

## 能做什么

- **造**。输入 APP 是什么。规划器排出 4–6 屏的主流程（或你指定的 1–4 屏），每屏按项目设计系统生成为自包含 HTML，经 lint、截图后落到画布。每屏可要 1–4 版候选，看中哪版采用哪版。
- **改**。选中屏、说改动。元素级直改零 token（文案、样式、跳转目标）；选一个子树让 AI 重生成；给元素挂批注、攒够一起发。
- **聊天**。带项目记忆的对话模式。助手通过 Quilt 自己的 MCP 看项目、自己定范围，回写的修订记在这一轮聊天名下。
- **无限画布**。截图平铺、平移缩放、拖动摆放、多选对齐与等距，位置持久化。双击一屏进入聚焦态，它变成活 iframe，可滚动、可输入、可点击。
- **原型播放**。链接、表单提交、`data-href` 按钮在聚焦 iframe 内跳屏，状态保留、可后退。应用地图从 HTML 派生，断链标红、一键接上，缺失路由可懒生成。整套导出为单文件 HTML，离线可开。
- **设计系统**。种子色派生 Material 3 token、`DESIGN.md` 与组件配方；可挂显式品牌色板（亮 / 暗各一套）、上传 logo 与素材、整套存成预设给下个项目用。改 token 后确定性回刷全部屏。
- **共享组件**。把导航栏、顶栏、侧栏记为项目级组件，和屏并排放在画布上。屏引用它、不复制代码：每次写入时 Quilt 填入正式 HTML，并按路由标出激活项。改组件一次（手改、输入框、或经 MCP），所有用它的屏零模型调用同步。
- **修订树**。每次生成、编辑、agent 写入都是一条带父修订的修订。可回溯任意一版，候选分支保留，随时采用。
- **通道**。设置页管理生成通道：Anthropic、Gemini（AI Studio 或 Vertex）、OpenAI 兼容端点、本机 Claude 订阅、运行中的 Claude Code 会话。密钥加密落库，用量台账按作业记 token。
- **MCP 双向**。编码 agent 连 `http://127.0.0.1:3100/mcp`，拿到 20 个工具与 7 个资源：读设计契约、取屏与截图、建屏改屏、连线、改设计系统。反过来 Quilt 也能把作业派给一个运行中的 Claude Code 会话并等它收口。

## 怎么运转

```
浏览器（React 19 画布）──REST / SSE──▶ quilt 进程（Hono，127.0.0.1:3100）
                      ◀─iframe────────  预览域（127.0.0.1:3101，只读 HTML）
                                        ├─ 进程内队列 + Worker（LLM 调用、lint、注入、截图）
                                        ├─ MCP server（Streamable HTTP，与 REST 共用服务层）
                                        ├─ 聊天回路（Claude Agent SDK 子进程，走同一个 MCP）
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
node apps/cli/bin/quilt.js       # 包发布到 npm 后等价于 npx quilt-canvas
```

首次运行在 `~/.quilt` 建库（内置 PGlite）、对象目录与 `config.env`（自动生成密钥），跑迁移，打开 `http://127.0.0.1:3100`。同一目录再跑一次即恢复全部项目。

参数：`--home <dir>` 换数据目录；`--port` / `--preview-port` 换端口（默认 3100 / 3101）；`--no-open` 不自动开浏览器。

改 `~/.quilt/config.env` 切默认通道：

```
LLM_DRIVER=agent-sdk      # agent-sdk（本机 Claude 订阅）| anthropic | gemini
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

### 从源码跑（开发）

```sh
pnpm install
cp .env.example .env             # DATABASE_URL 留空即用内置 PGlite
docker compose up -d             # 可选：保留 DATABASE_URL 时起 127.0.0.1:5439 的 Postgres
pnpm dev                         # API + Worker + 预览域在 3100/3101，Vite 在 5173
```

打开 `http://localhost:5173`。迁移在 API 启动时自动执行。`.env.example` 每个键都带说明。

## 接入编码 agent

```sh
claude mcp add --transport http quilt http://127.0.0.1:3100/mcp
```

服务只绑回环地址，所以免鉴权。工具：`quilt.list_projects`、`create_project`、`get_project`、`get_outline`、`get_screen`、`get_screenshot`、`get_design_contract`、`validate_screen`、`create_screen`、`update_screen`、`link_screens`、`get_app_map`、`generate_screens`、`edit_screens`、`list_revisions`、`get_job`、`finish_job`、`update_design_system`、`update_project`、`create_component`、`update_component`、`create_upload_url`。资源：`design-md`、`tokens`、`app-map`、`golden`、`screen-html`、`screen-screenshot`、`attachment`。

建议 agent 先 `get_outline`（每屏一份紧凑的结构摘要）再 `get_screen`（整屏 HTML）。写入都带 `expectedRevisionId`，基线过期返回 409，两个写入方不会互相覆盖。

反方向：输入框通道选「交给本机 Claude Code」，再选一个运行中的会话。Quilt 把提示词投递进那个会话，会话经同一个 MCP 回写并收口作业。

## 仓库结构

```
apps/api        Hono 服务：REST、MCP、SSE、预览域、进程内 Worker、Drizzle schema 与迁移
apps/web        Vite + React 19 + Tailwind 4 画布
apps/cli        用 esbuild 把 api + core + web 捆成 npm 包 quilt-canvas
packages/core   共享层：zod schema、提示词契约、lint 规则、运行时注入、导出、token、大纲
tests/e2e       按 docs/TEST.md 用例执行的 Playwright 脚本
docs/DESIGN.md  设计文档（需求、数据模型、接口契约、状态机、ADR）
docs/TEST.md    用例库（带 REQ 追溯）与执行记录
CLAUDE.md       编码 agent 参与本仓库时的工作纪律
```

## 开发

```sh
pnpm typecheck                   # core / api / web 三处 tsc
pnpm build                       # 前端 + CLI 包
pnpm seed                        # 清空 DATABASE_URL 指向的库并建两个示例项目
pnpm mcp:call <tool> '<json>'    # 对运行中的服务调一个 MCP 工具
```

e2e 套件在 `tests/e2e`（`core`、`proto`、`edit`、`agent`、`install`、`chat`）。它们会清空所指向的库，所以 `DATABASE_URL` 不指向 `quilt_test` 就拒绝运行。`LIVE_LLM=0` 跳过真实模型调用。环境细节见 `docs/TEST.md` §3。

改动纪律：先改 `docs/DESIGN.md`，再改代码，再同步 `docs/TEST.md` 受影响的用例，执行并登记一轮。

## 状态

v0.45，本地单用户版。只做手机与桌面两种形态。推迟而非放弃：多用户 SaaS（登录、配额、远程派活）。不在范围内：多人实时协作、生成生产级 React 工程代码、原生端渲染。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
