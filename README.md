<p align="center">
  <img src="apps/web/public/brand/symbol-graphite.svg" width="88" alt="Quilt" />
</p>

<h1 align="center">Quilt</h1>

<p align="center">
  AI-native infinite-canvas design tool.<br/>
  Describe an app, get consistent multi-screen HTML designs on an infinite canvas,<br/>
  click through them as a prototype, and let your coding agent read and write the canvas over MCP.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Bearisbug/Quilt?color=blue" alt="License: Apache-2.0" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white" alt="Node.js 22 or newer" /></a>
  <a href="https://github.com/Bearisbug/Quilt/stargazers"><img src="https://img.shields.io/github/stars/Bearisbug/Quilt?style=flat&logo=github" alt="GitHub stars" /></a>
  <br/>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white" alt="Hono" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS 4" />
  <img src="https://img.shields.io/badge/PGlite-embedded_Postgres-336791?logo=postgresql&logoColor=white" alt="PGlite" />
  <img src="https://img.shields.io/badge/MCP-Streamable_HTTP-6E56CF" alt="MCP over Streamable HTTP" />
</p>

<p align="center">
  English · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/c8d29478-a238-48f9-b17d-779866cca9af" width="900" alt="One sentence in the composer becomes a multi-screen app on the canvas" />
</p>

---

Quilt runs on your machine: one process, no account, no cloud backend, data in `~/.quilt`. Generation goes through the channel you pick: your Claude subscription (the `claude` CLI), an Anthropic, Gemini or OpenAI-compatible API key, or a Claude Code session you already have open.

## What it does

- **Generate.** Describe the app. Quilt plans a 4–6 screen main flow (or the 1–4 screens you ask for), generates each screen as self-contained HTML in the project's design system, lints and screenshots it, and lays it out on the canvas. Ask for up to 4 candidates per screen and adopt one.
- **Edit.** Select screens and describe the change. In a focused screen, `⌘E` picks any element: change its text, classes or link with zero tokens, or have AI regenerate just that block.
- **Sketchbook.** A full-page board for one-off components and pages outside any project. Describe one, refine it by picking elements, step through versions, then put it into a project as a new screen, over a screen, or in place of one block.
- **Canvas.** Pan, zoom, drag, align and distribute. `⌘K` jumps to any screen; a minimap and a filterable screen list keep large projects navigable. Double-click a screen to use it live.
- **Prototype.** Links, forms and `data-href` buttons move between screens with state kept and a back stack. Overlay screens (sheets, dialogs) open on top of the current one; state variants (empty, error, signed out) share a route. Broken links are flagged and fixed in one click. Export the whole prototype as one offline HTML file.
- **Design system.** A seed colour or an explicit brand palette (light and dark) yields tokens, a `DESIGN.md` and component recipes. Upload assets, save presets, and re-flow every screen when tokens change.
- **Shared components.** Tab bars, app bars and sidebars live on the canvas as components; edit one and every screen using it updates without a model call.
- **History.** Every generation, edit and agent write is a revision you can roll back to.
- **Together.** People on your network who open the same project see each other's cursors, selections and views, and can follow one another.
- **Settings.** Generation channels (keys encrypted at rest), a usage dashboard by day, model, project and task, an optional local record of UI actions and model calls, and a Chinese or English interface.
- **MCP, both ways.** Your coding agent gets 53 tools and 7 resources at `http://127.0.0.1:3100/mcp`. Quilt can also hand a job to a running Claude Code session.

<p align="center">
  <img src="https://github.com/user-attachments/assets/e6b776b4-c8b8-4900-91bc-9d9c906f5da6" width="900" alt="Picking an element inside a focused screen and editing it in place" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/4a7ad855-c19f-4b17-ac79-e1a58320c6bb" width="900" alt="Drafting a page in the sketchbook from one sentence" />
</p>

## How it works

```
Browser (React 19 canvas) ──REST / SSE──▶ quilt process (Hono, 127.0.0.1:3100)
                          ◀─iframe──────  preview origin (127.0.0.1:3101, read-only HTML)
                                          ├─ in-process job queue + worker (LLM, lint, inject, screenshot)
                                          ├─ MCP server (Streamable HTTP, same service layer as REST)
                                          ├─ chat jobs over the API (Claude Agent SDK subprocess, talks to the same MCP)
                                          └─ agent delivery (hands jobs to a local Claude Code session)
                                          ~/.quilt: PGlite database · objects/ · config.env
```

Screens are plain HTML with Tailwind classes and the project's tokens; stable element ids let an edit target one block. The preview runs on a separate origin, so generated scripts cannot reach Quilt's own storage.

`docs/DESIGN.md` is the single source of truth: requirements, data model, API contract, state machines and ADRs. `docs/TEST.md` holds the test cases and the log of every test round.

## Quick start

Requirements:

- Node.js 22 or newer, pnpm 11
- Chrome or Edge for screenshots (otherwise run `npx playwright install chromium` once)
- A generation channel: the `claude` CLI logged in (the default, `LLM_DRIVER=agent-sdk`), an Anthropic or Gemini API key, or an OpenAI-compatible endpoint added in settings

### Run the packaged app

```sh
pnpm install
pnpm build                       # builds the web bundle and apps/cli/dist
node apps/cli/bin/quilt.js       # or: npx quilt-canvas, once the package is published
```

The first run creates `~/.quilt` (embedded PGlite database, object store, `config.env` with generated secrets), runs migrations and opens `http://127.0.0.1:3100`. Run it again with the same home and your projects are there.

Flags: `--home <dir>`, `--port` / `--preview-port` (default 3100 / 3101), `--no-open`. The default channel is set in `~/.quilt/config.env`:

```
LLM_DRIVER=agent-sdk      # agent-sdk (local Claude subscription) | anthropic | gemini
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

### Run from source

```sh
pnpm install
cp .env.example .env             # leave DATABASE_URL empty to use embedded PGlite
docker compose up -d             # optional: Postgres on 127.0.0.1:5439 if you set DATABASE_URL
pnpm dev                         # API + worker + preview on 3100/3101, Vite on 6688
```

Open `http://localhost:6688`. Migrations run at API startup; every key in `.env.example` is documented inline.

## Connect your coding agent

```sh
claude mcp add --transport http quilt http://127.0.0.1:3100/mcp
```

The server listens on loopback only, so there is no authentication. Everything the canvas and the sketchbook do is available as a tool; only API keys stay in the settings panel.

Read with `get_outline` (a compact summary of every screen) before `get_screen`. Keep writes small: `patch_screen` for a partial change, `create_upload_url` plus several `append_upload` chunks for a screen over ~8 KB, because one very long tool argument can cut a streamed model response short. Writes carry `expectedRevisionId` and return 409 on a stale base, so two writers cannot overwrite each other.

The other direction: choose "hand to local Claude Code" as the channel in the composer and pick a running session. Quilt delivers the prompt there; the session writes back over the same MCP and closes the job.

<details>
<summary>All 53 tools and 7 resources</summary>

- Projects: `quilt.list_projects`, `create_project`, `get_project`, `update_project`, `delete_project`
- Reading: `get_outline`, `get_screen`, `get_screenshot`, `get_revision`, `list_revisions`, `list_candidates`, `get_design_contract`, `get_app_map`, `list_assets`, `list_messages`, `list_jobs`, `get_job`, `get_job_events`, `list_runners`, `list_design_presets`
- Writing screens: `validate_screen`, `create_screen`, `update_screen`, `patch_screen`, `create_upload_url`, `append_upload`, `link_screens`, `move_screens`, `edit_element`, `restore_revision`, `adopt_candidate`, `delete_screen`
- Sketchbook: `get_sketchbook`, `create_draft`, `copy_draft`
- Shared components: `create_component`, `update_component`, `delete_component`
- Design system: `update_design_system`, `create_design_preset`, `apply_design_preset`, `delete_design_preset`, `create_asset`, `delete_asset`
- Model jobs: `generate_screens`, `edit_screens`, `regenerate_subtree`, `edit_component`, `propose_design_system`, `export_prototype`, `get_export`, `cancel_job`, `finish_job`
- Resources: `design-md`, `tokens`, `app-map`, `golden`, `screen-html`, `screen-screenshot`, `attachment`

</details>

## Repository layout

```
apps/api        Hono server: REST, MCP, SSE, preview origin, in-process worker, Drizzle schema + migrations
apps/web        Vite + React 19 + Tailwind 4 canvas and sketchbook
apps/cli        esbuild bundle of api + core + web → the `quilt-canvas` npm package
packages/core   shared: zod schemas, prompt contract, lint rules, runtime injection, export, tokens, outline
tests/unit      node:test unit tests for the pure functions in core and the canvas (pnpm test)
tests/e2e       Playwright scripts that execute the cases in docs/TEST.md
docs/CHANGELOG.md older change-log rows moved out of DESIGN.md / TEST.md
docs/DESIGN.md  design document (requirements, data model, API contract, state machines, ADRs)
docs/TEST.md    test cases with REQ traceability and the execution log
CLAUDE.md       working discipline for coding agents contributing to this repo
```

## Development

```sh
pnpm typecheck                   # tsc across core / api / web
pnpm test                        # unit tests (node:test, ~1.5 s, no database or browser)
pnpm build                       # web bundle + CLI package
pnpm seed                        # wipe the database DATABASE_URL points at, create two demo projects
pnpm mcp:call <tool> '<json>'    # call an MCP tool against the running server
```

The end-to-end suites in `tests/e2e` run against an isolated stack (`scripts/e2e-stack.sh`; `scripts/e2e-all.sh` runs them in order). They wipe the database they point at, so they refuse to start unless its name ends in `_test`. `LIVE_LLM=0` skips the turns that need a real model; environment details are in `docs/TEST.md` §3.

Every change goes the same way: update `docs/DESIGN.md`, then the code, then the affected cases in `docs/TEST.md`, then run and log a round.

## Status

v1.42, local edition: it runs on one machine, and people on the same network can open it together. Mobile and desktop screens, plus free-form drafts in the sketchbook. Deferred, not dropped: multi-user SaaS (login, quotas, remote dispatch). Out of scope: production React code generation, native rendering.

## License

Apache-2.0. See [LICENSE](LICENSE).
