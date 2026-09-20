# quilt-canvas

Quilt：AI 原生的无限画布设计工具——用自然语言生成 APP 多屏 HTML 设计稿，在画布上浏览、交互、迭代、串成可点击原型；本机的 Claude Code / Codex 可以经 MCP 双向接入。

```sh
npx quilt-canvas
```

首次运行会在 `~/.quilt` 初始化数据库（内置 PGlite，不需要 Docker）、对象目录与 `config.env`，然后打开浏览器。再次运行同一目录即恢复全部项目。

- `--home <dir>` 换数据目录；`--port` / `--preview-port` 换端口（默认 3100 / 3101）；`--no-open` 不自动开浏览器。
- 生成通道在 `~/.quilt/config.env` 里配：默认 `LLM_DRIVER=agent-sdk`（复用本机 `claude` 的登录态），也可填 `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`。
- 截图用本机已装的 Chrome / Edge；都没有时运行 `npx playwright install chromium`。
- 让本机 agent 接入：`claude mcp add --transport http quilt http://127.0.0.1:3100/mcp`。

服务只绑 `127.0.0.1`，没有账号与登录。
