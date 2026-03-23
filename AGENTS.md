# opensessions — AI Agent Instructions

You are working on **opensessions**, an agent-agnostic, mux-agnostic terminal session manager.

## Project Structure

```
opensessions/
├── packages/
│   ├── core/          # @opensessions/core — server, contracts, mux providers, agent tracker
│   │   ├── src/
│   │   │   ├── contracts/   # AgentEvent, AgentStatus, MuxProvider, MuxSessionInfo
│   │   │   ├── agents/      # AgentTracker (state management for agent events)
│   │   │   ├── mux/         # MuxProvider implementations (tmux, detect)
│   │   │   ├── server/      # WebSocket server, launcher, startup
│   │   │   ├── shared.ts    # Shared types, constants, palette
│   │   │   └── index.ts     # Barrel export
│   │   └── test/            # Tests (bun:test)
│   └── tui/           # @opensessions/tui — OpenTUI terminal sidebar (Solid)
│       ├── src/
│       │   └── index.tsx    # Main TUI app
│       ├── build.ts         # Bun build with Solid plugin
│       └── bunfig.toml      # Required: preload for Solid JSX transform
├── CONTRACTS.md       # Agent integration guide (Amp, Claude Code, OpenCode, Aider)
├── turbo.json         # Turborepo config
└── package.json       # Bun workspace root
```

## Key Architecture Decisions

1. **Monorepo**: Turborepo + Bun workspaces. Two packages: `@opensessions/core` and `@opensessions/tui`
2. **Agent-agnostic**: Any agent POSTs to `http://127.0.0.1:7391/event` with `{agent, session, status, ts}`. No agent-specific code in core.
3. **Mux-agnostic**: `MuxProvider` interface abstracts all mux operations. `TmuxProvider` is the reference implementation.
4. **MuxProvider is SYNC**: All methods use `Bun.spawnSync` — matches the existing pattern and keeps the server simple.
5. **Auto-detect mux**: `detectMux()` checks `$TMUX`, `$ZELLIJ_SESSION_NAME` env vars. Config file override planned.
6. **TDD**: All contracts and tracker logic have tests. Use `bun test` in `packages/core/`.

## Contracts

### AgentEvent (POST /event)
```typescript
{ agent: string, session: string, status: AgentStatus, ts: number }
```
`AgentStatus = "running" | "idle" | "done" | "error" | "waiting" | "interrupted"`

### MuxProvider Interface
```typescript
interface MuxProvider {
  name: string;
  listSessions(): MuxSessionInfo[];        // {name, createdAt, dir, windows}[]
  switchSession(name, clientTty?): void;
  getCurrentSession(): string | null;
  getSessionDir(name): string;
  getPaneCount(name): number;
  getClientTty(): string;
  setupHooks(host, port): void;
  cleanupHooks(): void;
}
```

## Stack

- **Runtime**: Bun (not Node)
- **Language**: TypeScript (strict)
- **TUI**: OpenTUI with Solid reconciler (`@opentui/solid`, `@opentui/core`, `solid-js`)
- **Tests**: `bun:test` — run with `bun test` in `packages/core/`
- **Build**: `@opentui/solid/bun-plugin` for TUI builds

## Development Guidelines

- **TDD**: Red-green-refactor, vertical slices, one test at a time. Tests verify behavior through public interfaces.
- **Sync mux calls**: MuxProvider methods are synchronous. Don't make them async.
- **Preserve optimizations**: Batched tmux calls, 5s git cache with HEAD watchers, lightweight focus-only broadcasts.
- **No agent-specific code in core**: The `/event` endpoint is the universal integration point. Agent-specific mapping lives in plugins/hooks outside this repo.
- **OpenTUI Solid**: JSX needs `bunfig.toml` preload and `jsxImportSource: "@opentui/solid"` in tsconfig. Build needs `solidPlugin`.
- **Never call `process.exit()` directly in TUI**: Use `renderer.destroy()`.

## Common Commands

```bash
bun install                          # Install all workspace deps
bun test                             # Run all tests (from root via turbo)
cd packages/core && bun test         # Run core tests directly
cd packages/tui && bun run start     # Start TUI (requires tmux)
cd packages/tui && bun run build     # Build TUI for distribution
```

## Adding a New Mux Provider

1. Create `packages/core/src/mux/your-mux.ts`
2. Implement the `MuxProvider` interface
3. Add detection logic in `packages/core/src/mux/detect.ts`
4. Add tests in `packages/core/test/`
5. Export from `packages/core/src/index.ts`

## Adding Agent Support

No code changes needed. See `CONTRACTS.md` for integration examples. Agents just POST to the server.
