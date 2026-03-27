# opensessions

tmux is all you need. make tmux great again :) 

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/21d46849-e79f-4db0-92b6-fabf95efa403" />

`opensessions` is a sidebar for `tmux` when your sessions, agents, and localhost tabs start multiplying.

It lives inside your existing tmux workflow instead of replacing it: one small pane for session switching, agent state, repo breadcrumbs, and quick jumps back into the right terminal.

tmux is the only supported mux today. There is older zellij integration code in the repo, but it is not stable enough to document as supported; we are looking for maintainers who want to help bring it back to that bar.

## Today

- Live agent state across sessions for Amp, Claude Code, Codex, and OpenCode.
- Per-thread unseen markers for `done`, `error`, and `interrupted` states.
- Session context in the UI: branch in the list, working directory in the detail panel, thread names, and detected localhost ports.
- Fast switching with `j`/`k`, arrows, `Tab`, `1`-`9`, session reordering, hide/restore, creation, and kill actions.
- A tmux command table on `prefix o`, optional no-prefix shortcuts, in-app theme switching, and plugin hooks for more mux providers or watchers.
- Bun workspace, source-first execution, and a local server on `127.0.0.1:7391`.

## Quick Start

Smoke test from a local clone:

```bash
git clone https://github.com/Ataraxy-Labs/opensessions.git
cd opensessions
bun install
bun test
cd packages/tui && bun run start
```

That starts the sidebar client and auto-launches the server if needed.

For the full tmux workflow with keybindings and automatic pane management, wire in `opensessions.tmux` and follow the guide below.

## Docs

- [Get started in tmux](./docs/tutorials/get-started-in-tmux.md)
- [Configuration reference](./docs/reference/configuration.md)
- [Features and keybindings reference](./docs/reference/features-and-keybindings.md)
- [Architecture explanation](./docs/explanation/architecture.md)
- [Contracts and extension interfaces](./CONTRACTS.md)
- [Plugin authoring guide](./PLUGINS.md)

## A Few Concrete Bits

- Session ordering is persisted in `~/.config/opensessions/session-order.json`.
- Amp watcher reads `~/.local/share/amp/threads/*.json` and clears unseen state from Amp's `session.json` when a thread becomes seen there.
- Claude Code watcher reads JSONL transcripts in `~/.claude/projects/`.
- Codex watcher reads transcript JSONL files in `~/.codex/sessions/` or `$CODEX_HOME/sessions/` and resolves sessions from `turn_context.cwd`.
- OpenCode watcher polls the SQLite database in `~/.local/share/opencode/opencode.db`.
- Hidden sidebars are stashed in a tmux session named `_os_stash`, so they can come back without restarting the sidebar process.
- Clicking a detected port opens `http://localhost:<port>`.

## Repo Layout

- `packages/core` — server, watcher logic, config, themes, ordering, plugins
- `packages/tui` — OpenTUI sidebar client built with Solid
- `packages/mux` — mux contracts and type guards
- `packages/mux-tmux` — tmux provider
- `packages/tmux-sdk` — lower-level typed tmux bindings
- `tmux-plugin` — tmux-facing scripts and plugin entrypoint

Experimental zellij work still exists under `packages/mux-zellij` and `integrations/zellij`, but it is outside the supported setup today.

## Current Caveats

- The app is effectively pinned to `127.0.0.1:7391` today.
- `theme`, `sidebarWidth`, `sidebarPosition`, `plugins`, and `mux` are wired through the runtime; other typed config fields are not all live yet.
- Inline theme objects exist in core, but the running server persists and broadcasts theme names.

## License

MIT
