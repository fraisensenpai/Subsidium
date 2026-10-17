<div align="center">

<img src="assets/app-icon.svg" alt="Subsidium" width="104" height="104">

<h1>Subsidium</h1>

<p>
  A local workspace-intelligence coding agent for your projects.
</p>

<p>
  <a href="https://github.com/fraisensenpai/Subsidium/releases/latest"><img alt="Download" src="https://img.shields.io/github/v/release/fraisensenpai/Subsidium?label=download&style=flat-square&color=174A3A&labelColor=11140F"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-174A3A?style=flat-square&labelColor=11140F"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-174A3A?style=flat-square&labelColor=11140F">
  <img alt="Built with" src="https://img.shields.io/badge/Tauri%202%20%C2%B7%20Rust%20%C2%B7%20React%20%C2%B7%20TypeScript-52B482?style=flat-square&labelColor=11140F">
</p>

<p>
  <img src="assets/crescendo.png" alt="Crescendo Technologies" width="16" height="16">
  &nbsp;Made by <b>Crescendo Technologies</b>
</p>

</div>

<br>

## Contents

- [What it is](#what-it-is)
- [Download](#download)
- [At a glance](#at-a-glance)
- [The agent](#the-agent)
- [Workspace index](#workspace-index)
- [Where your data lives](#where-your-data-lives)
- [Providers](#providers)
- [Settings](#settings)
- [Build from source](#build-from-source)
- [Project status](#project-status)
- [Philosophy](#philosophy)
- [Roadmap](#roadmap)

---

## What it is

Subsidium is a desktop coding environment built around your workspace — not
another chat window with an editor bolted on.

The explorer, editor, terminal, search, Git information and an agent live in one
window and share the same project index. The agent can inspect your code, search
it and read it freely; **changing a file or running a command always needs your
approval first.**

Everything runs on your machine except the requests you send to the model
provider you configure.

---

## Download

Installers are attached to every [release](https://github.com/fraisensenpai/Subsidium/releases/latest):

| Platform | Installer | Notes |
| :--- | :--- | :--- |
| **Windows** | `…_x64_en-US.msi` | standard installer |
| | `…_x64-setup.exe` | NSIS setup |
| **macOS** | `…_aarch64.dmg` | Apple Silicon (M-series) |
| | `…_x64.dmg` | Intel |
| **Linux** | `…_amd64.deb` | Debian, Ubuntu |
| | `…-1.x86_64.rpm` | Fedora, RHEL |
| | `…_amd64.AppImage` | any distro, no install |

> **Phase 1 preview.** The builds come from CI and are not code-signed, so
> Windows SmartScreen or macOS Gatekeeper may ask you to confirm on first
> launch. [Building from source](#build-from-source) avoids that entirely.

On first launch, pick a workspace folder and configure a provider — an API key
from any of the [supported providers](#providers), or a local model through
Ollama. The workspace is indexed immediately, and you can start working.

---

## At a glance

| Panel | What it does |
| :--- | :--- |
| **Explorer** | A familiar file tree over the current workspace. It respects `.gitignore`, so build output and dependencies stay out of the way, and it refreshes as the agent creates files. |
| **Editor** | CodeMirror with syntax highlighting for JavaScript, TypeScript, Python, Rust, CSS, HTML, JSON and Markdown. Saving writes to disk and updates the workspace index. |
| **Terminal** | A real PTY-backed shell rooted in the workspace — `cmd.exe` on Windows, your `$SHELL` (`sh` as a fallback) on macOS and Linux. Live output, long-running dev servers, process termination, and the commands the agent runs. |
| **Agent** | Talks to the provider you choose and works through tools rather than guessing, with an explicit approval step before anything is written or executed. |
| **Search** | File names, symbols and full-text matches across the workspace, from the same index the agent uses. |
| **Intel** | File count, language breakdown and index information for the project. |
| **Git** | Working tree status and diffs, plus the `git_status` and `git_diff` tools for the agent. |

---

## The agent

The model never receives your whole repository. It explores the project the way
a person would — through tools — and each privileged tool is gated behind your
approval.

| Tool | What it does | Approval |
| :--- | :--- | :---: |
| `search_code` | search the workspace index for code and symbols | — |
| `read_file` | read a file's contents | — |
| `git_status` | show the working tree status | — |
| `git_diff` | show changes against HEAD | — |
| `write_file` | write a file | **required** |
| `run_command` | run a shell command in the workspace | **required** |

A typical turn looks like this:

```text
              You
               │
               ▼
             Agent ────────────────► Provider
               │                        ▲
               │  tool call             │  transcript
               ▼                        │
      ┌─────────────────┐               │
      │  search_code    │               │
      │  read_file      │  read-only    │
      │  git_diff       │               │
      └─────────────────┘               │
               │                        │
               ▼                        │
      ┌─────────────────┐               │
      │  write_file     │  needs        │
      │  run_command    │  approval ────┘
      └─────────────────┘
               │
               ▼
           Workspace
```

Approvals can be granted or denied per action, a running turn can be stopped at
any point, and a command the agent leaves running is terminated when you switch
or reset the conversation.

---

## Workspace index

Opening a folder builds a small index of the project. It is what makes search
and the agent's tools instant rather than a filesystem walk on every question.

```text
Workspace
   │
   ├── File discovery
   │      └── .gitignore rules
   │
   ├── Source parsing
   │      └── Tree-sitter
   │
   ├── Metadata
   │
   └── SQLite index
          └── .subsidium/index.db
```

Supported source files are parsed structurally — functions, classes, methods,
types — rather than being treated as plain text, which is the foundation the
retrieval layer builds on in a later phase.

---

## Where your data lives

Subsidium is local-first, so it is worth being explicit about what is written
where.

| What | Where |
| :--- | :--- |
| Workspace index (files, symbols) | `<workspace>/.subsidium/index.db` |
| Conversation history | the same file — conversations are stored per workspace |
| App settings (token budget, reset interval, theme) | `subsidium/settings.json` in your OS config directory — `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux |
| Provider configuration (provider, model, base URL) | `subsidium/providers.json` in the same directory — **no keys** |
| API keys | your operating system's credential store, never a plain file |

`.subsidium/` is created the first time a workspace is opened and is excluded
from discovery, so it never appears in the file tree or in search results.
Deleting the folder drops that workspace's index and conversations.

---

## Providers

Bring a key for the provider you already use, or point Subsidium at a local
model.

| Family | Providers |
| :--- | :--- |
| **Direct** | Anthropic · Google Gemini · OpenAI |
| **Aggregators & hosts** | OpenRouter · Together · Fireworks · Cerebras · SambaNova · Nebius · Hyperbolic · GitHub Models |
| **Fast inference** | Groq · DeepSeek · xAI (Grok) · Mistral · Perplexity |
| **Local / self-hosted** | Ollama · LM Studio · vLLM · LocalAI |
| **Anything else** | any custom OpenAI-compatible endpoint |

Each brand comes with a curated model list, so switching providers does not mean
typing model IDs from memory. Keys are stored in the operating system's keyring,
never in a config file.

---

## Settings

| Area | What you can change |
| :--- | :--- |
| **Providers** | provider, API key (kept in your OS keyring), model, base URL where applicable, and which account is active |
| **Budget** | a token budget with a usage counter that resets automatically on an interval you choose — hourly, daily, weekly … |
| **Appearance** | dark and light themes |

---

## Build from source

### Prerequisites

| Requirement | Notes |
| :--- | :--- |
| [Node.js](https://nodejs.org/) 18+ | 20 recommended |
| [Rust](https://rustup.rs/) (stable) | install through `rustup` |
| Platform build tools | see below |

| Platform | Needs |
| :--- | :--- |
| **Windows** | Microsoft C++ Build Tools (*Desktop development with C++*) and WebView2 (already present on Windows 11) |
| **macOS** | Xcode Command Line Tools — `xcode-select --install` |
| **Linux** | `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `libgtk-3-dev`, `libxdo-dev`, `patchelf` |

### Run

```bash
git clone https://github.com/fraisensenpai/Subsidium.git
cd Subsidium
npm install
npm run tauri dev
```

### Installers

```bash
npm run tauri build
```

Bundles land in `src-tauri/target/release/bundle/` — `.msi` / `.exe` on Windows,
`.dmg` on macOS, `.deb` / `.rpm` / `.AppImage` on Linux.

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds all three platforms and publishes them as a downloadable release.

### App icon

The icon is generated from [`assets/app-icon.svg`](assets/app-icon.svg) — the
same mark Subsidium draws in its own header. Edit the SVG, then regenerate every
platform size and commit the result:

```bash
npm run tauri icon assets/app-icon.svg
```

### Checks

```bash
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

---

## Project status

Subsidium is in **Phase 1**: the desktop environment and the agent loop work,
and the project is under active development.

| Working | Planned |
| :--- | :--- |
| Workspace selection, explorer, editor | Background file watching |
| Syntax highlighting, Tree-sitter parsing | Re-indexing after external file changes |
| SQLite index and workspace search | Project summaries |
| Re-indexing after agent writes | Improved diff review |
| Interactive terminal | Persistent agent memory |
| Agent chat and read-only tools | Multiple workspaces |
| Privileged tool approval, file diffs | More Tree-sitter languages |
| Git status and diff | Deeper code intelligence |
| Conversation history | Improved agent workflows |
| Multiple providers, secure key storage | |
| Dark and light themes | |
| Cross-platform installers via CI | |

---

## Philosophy

**The workspace comes first.** The agent should understand the project it is
working in instead of treating every request as an isolated prompt.

**Actions should be visible.** Reading a project and changing a project are
different things. Changes and commands should not happen silently.

**Local-first.** The application, the index, your conversations and the terminal
live on your machine. The model provider is configurable.

**Build the environment, not just the chat.** The goal is not another chat
window with a code editor attached to it, but a single environment where the
project, the tools and the agent work together.

---

## Roadmap

```text
Phase 1   Workspace + Editor + Terminal + Agent
   │
   ▼
Phase 2   Deeper workspace intelligence
   │
   ▼
Phase 3   Context & retrieval
   │
   ▼
Phase 4   Agent improvements
   │
   ▼
Phase 5   Production hardening
```

The architecture is being built so that later capabilities can be added without
replacing the core workspace layer.

---

## Contributing

Contributions and bug reports are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Include your OS, the steps to reproduce and what you expected.

---

## License

MIT — see [LICENSE](LICENSE).

<br>

<div align="center">

<img src="assets/crescendo.png" alt="Crescendo Technologies" width="28" height="28">

**Subsidium**

Made by **Crescendo Technologies**

Built with Rust, React and a lot of iteration.

</div>
