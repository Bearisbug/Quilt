<p align="center">
  <img src="apps/web/public/brand/symbol-graphite.svg" width="88" alt="Quilt" />
</p>

<h1 align="center">Quilt</h1>

<p align="center">
  AI-native infinite-canvas design tool.<br/>
  Describe an app, get a set of consistent multi-screen HTML designs on an infinite canvas,<br/>
  click through them as a working prototype, and let your local coding agent read and write the canvas over MCP.
</p>

<p align="center">
  English · <a href="README.zh-CN.md">中文</a>
</p>

---

Quilt runs entirely on your machine: one process, no accounts, no cloud backend. Data lives in `~/.quilt`. Generation goes through whichever channel you choose: your local Claude subscription (the `claude` CLI), an Anthropic / Gemini / OpenAI-compatible API key, or a Claude Code session you already have open.

## What it does

- **Generate** ("造"). Type what the app is. The planner lays out a 4–6 screen main flow (or exactly the number you pick, 1–4), each screen is generated as self-contained HTML against the project's design system, linted, screenshotted and placed on the canvas. Ask for up to 4 candidate versions per screen and adopt the one you like.
- **Edit** ("改"). Select screens and describe the change. Edit at element level with zero tokens (text, style, link target), regenerate one subtree with AI, or pin annotations on elements and send them in a batch.
- **Chat** ("聊天"). A conversational mode with per-project memory. The assistant looks at the project through Quilt's own MCP, decides its own scope, and writes back revisions attributed to the chat turn.
- **Infinite canvas.** Screenshots tiled on a pan/zoom canvas, drag to arrange, multi-select alignment, positions persisted. Double-click a screen to focus it as a live iframe you can scroll, type into and click.
- **Prototype playback.** Links, form actions and `data-href` buttons navigate between screens inside the focused iframe with state kept and a back stack. The app map is derived from the HTML; broken links are flagged and can be fixed in one click; missing routes can be generated lazily. Export the whole thing as a single offline HTML file.
- **Design system.** A seed color derives a Material 3 token set plus a `DESIGN.md` and component recipes. Override with an explicit brand palette (light and dark), upload logos and assets, save the whole thing as a preset for the next project. Change tokens and re-flow every screen deterministically.
- **Revision tree.** Every generation, edit and agent write is a revision with a parent. Roll back to any version, keep candidate branches, adopt later.
- **Channels.** Manage generation channels in the settings panel: Anthropic, Gemini (AI Studio or Vertex), OpenAI-compatible endpoints, the local Claude subscription, or a running Claude Code session. Keys are encrypted at rest. A usage ledger records tokens per job.
- **MCP, both directions.** Your coding agent connects to `http://127.0.0.1:3100/mcp` and gets 20 tools and 7 resources to read the design contract, fetch screens and screenshots, create and update screens, link them and change the design system. Quilt can also dispatch a job to a running Claude Code session and wait for it to finish.

## How it works

```
Browser (React 19 canvas) ──REST / SSE──▶ quilt process (Hono, 127.0.0.1:3100)
                          ◀─iframe──────  preview origin (127.0.0.1:3101, read-only HTML)
                                          ├─ in-process job queue + worker (LLM, lint, inject, screenshot)
                                          ├─ MCP server (Streamable HTTP, same service layer as REST)
                                          ├─ chat loop (Claude Agent SDK subprocess, talks to the same MCP)
                                          └─ agent delivery (hands jobs to a local Claude Code session)
                                          ~/.quilt: PGlite database · objects/ · config.env
```

Generated screens are plain HTML with Tailwind classes and the project's tokens; they carry stable element ids so edits and annotations can target a subtree. The preview origin is a different origin from the canvas, so generated scripts cannot reach the tool's own storage.

`docs/DESIGN.md` is the single source of truth for requirements, data model, API contract, state machines and ADRs. `docs/TEST.md` is the acceptance ledger every change is verified against.

## Quick start

Requirements:

- Node.js 22 or newer, pnpm 11
- Chrome or Edge installed (used for screenshots). Otherwise run `npx playwright install chromium` once.
- A generation channel: either the `claude` CLI logged in (default, `LLM_DRIVER=agent-sdk`), or an API key for Anthropic / Gemini, or an OpenAI-compatible endpoint added in the settings panel.

### Run the packaged app

```sh
pnpm install
pnpm build                       # builds the web bundle and apps/cli/dist
node apps/cli/bin/quilt.js       # or: npx quilt-canvas, once the package is published
```

First run creates `~/.quilt` (embedded PGlite database, object store, `config.env` with generated secrets), runs migrations and opens the canvas at `http://127.0.0.1:3100`. Run it again in the same home to get all projects back.

Flags: `--home <dir>` for another data directory, `--port` / `--preview-port` (defaults 3100 / 3101), `--no-open`.

Edit `~/.quilt/config.env` to switch the default channel:

```
LLM_DRIVER=agent-sdk      # agent-sdk (local Claude subscription) | anthropic | gemini
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

### Run from source (development)

```sh
pnpm install
cp .env.example .env             # leave DATABASE_URL empty to use embedded PGlite
docker compose up -d             # optional: Postgres on 127.0.0.1:5439 if you keep DATABASE_URL
pnpm dev                         # API + worker + preview on 3100/3101, Vite on 5173
```

Open `http://localhost:5173`. Migrations run automatically at API startup. Every key in `.env.example` is documented inline.

## Connect your coding agent

```sh
claude mcp add --transport http quilt http://127.0.0.1:3100/mcp
```

The server binds to loopback only, so there is no authentication. Tools: `quilt.list_projects`, `create_project`, `get_project`, `get_outline`, `get_screen`, `get_screenshot`, `get_design_contract`, `validate_screen`, `create_screen`, `update_screen`, `link_screens`, `get_app_map`, `generate_screens`, `edit_screens`, `list_revisions`, `get_job`, `finish_job`, `update_design_system`, `update_project`, `create_upload_url`. Resources: `design-md`, `tokens`, `app-map`, `golden`, `screen-html`, `screen-screenshot`, `attachment`.

The recommended reading order for an agent is `get_outline` (a compact structural summary of every screen) before `get_screen` (full HTML). Writes take an `expectedRevisionId` and return 409 on a stale base, so two writers cannot clobber each other.

To go the other way, pick "hand to local Claude Code" as the channel in the composer and choose one of your running sessions. Quilt delivers the prompt into that session, the session writes back through the same MCP and closes the job.

## Repository layout

```
apps/api        Hono server: REST, MCP, SSE, preview origin, in-process worker, Drizzle schema + migrations
apps/web        Vite + React 19 + Tailwind 4 canvas
apps/cli        esbuild bundle of api + core + web → the `quilt-canvas` npm package
packages/core   shared: zod schemas, prompt contract, lint rules, runtime injection, export, tokens, outline
tests/e2e       Playwright scripts that execute the cases in docs/TEST.md
docs/DESIGN.md  design document (requirements, data model, API contract, state machines, ADRs)
docs/TEST.md    test cases with REQ traceability and the execution log
CLAUDE.md       working discipline for coding agents contributing to this repo
```

## Development

```sh
pnpm typecheck                   # tsc across core / api / web
pnpm build                       # web bundle + CLI package
pnpm seed                        # wipe the database DATABASE_URL points at, create two demo projects
pnpm mcp:call <tool> '<json>'    # call an MCP tool against the running server
```

End-to-end suites live in `tests/e2e` (`core`, `proto`, `edit`, `agent`, `install`, `chat`). They wipe the database they point at, so they refuse to run unless `DATABASE_URL` targets `quilt_test`. Set `LIVE_LLM=0` to skip the turns that call a real model. Environment details are in `docs/TEST.md` §3.

The change discipline is: update `docs/DESIGN.md` first, then the code, then the affected cases in `docs/TEST.md`, then run and log a round.

## Status

v0.45, local single-user edition. Mobile and desktop screens only. Deferred, not dropped: multi-user SaaS (login, quotas, remote dispatch). Out of scope: real-time collaboration, production React code generation, native rendering.

## License

Apache-2.0. See [LICENSE](LICENSE).
