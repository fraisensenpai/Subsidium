# Contributing to Subsidium

Thanks for taking a look. Subsidium is in **Phase 1** — the workspace layer and
the agent loop work, but the project is still moving quickly.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 18+ (20 recommended) | frontend toolchain |
| [Rust](https://rustup.rs/) | stable | via `rustup` |
| Platform build tools | — | see below |

**Windows** — Microsoft C++ Build Tools (Desktop development with C++) and
WebView2 (already present on Windows 11).

**macOS** — Xcode Command Line Tools (`xcode-select --install`).

**Linux** — `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`,
`libgtk-3-dev`, `libxdo-dev`, `patchelf`.

## Getting started

```bash
npm install
npm run tauri dev        # run the desktop app with hot reload
```

Useful scripts:

```bash
npm run typecheck                 # tsc --noEmit
npm run build                     # typecheck + vite build
npm run tauri build               # produce installers (src-tauri/target/release/bundle)
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## Project layout

```text
assets/                  screenshot, and app-icon.svg — the icon source
src/                     React + TypeScript frontend
  components/            one file per panel (Agent, Terminal, Editor, …)
  providerPresets.ts     the AI provider brand catalog
  types.ts               shared types — keep in sync with the Rust structs
src-tauri/src/           Rust backend
  commands.rs            every #[tauri::command] the frontend can call
  agent/                 the agent loop and its tool definitions
  providers/             one module per provider family
  indexing/              SQLite index (schema.sql + queries)
  retrieval/             symbol / file / full-text search
  terminal.rs            PTY-backed terminal
  workspace/             file discovery, scanning, path safety
  settings.rs            app settings (token budget, auto-reset, …)
src-tauri/capabilities/  Tauri permission grants
```

## Making a change

1. Keep changes consistent with the surrounding code — the existing style,
   naming and comment density.
2. If you touch a struct that crosses the Tauri boundary, mirror it in
   `src/types.ts`. Command *arguments* are camelCased by Tauri, but nested
   struct fields are not — add `#[serde(rename_all = "camelCase")]` when the
   frontend will read them.
3. Run `npm run typecheck` and
   `cargo test --manifest-path src-tauri/Cargo.toml --lib` before opening a PR.
4. Any action that modifies a user's files or runs a command must go through the
   approval flow — reading and writing are intentionally different.

## Reporting a bug

Include your OS, the steps to reproduce, and what you expected instead. If it
happened while the agent was working, the conversation title and the tool calls
involved are the most useful detail.
