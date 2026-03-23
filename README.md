# opensessions

**bring your own multiplexer**

Terminal session manager with live agent status, git branches, unseen notifications, and instant switching.

Runs inside your terminal. Works with your existing shortcuts. No new app to learn.

> 🚧 **Alpha** — the core contracts and TUI are functional. Star to follow progress.

## What it does

- **Agent status** — see which AI agents are running, done, or need input across sessions
- **Git branches** — current branch for every session at a glance
- **Unseen badges** — know when an agent finishes in another session without checking
- **Instant switching** — jump to any session by index, no fuzzy finder needed
- **Zero config** — works out of the box with tmux + any terminal
- **Agent-agnostic** — Amp, Claude Code, OpenCode, Aider, or any agent that can POST JSON
- **Mux-agnostic** — tmux today, zellij and others via the `MuxProvider` interface

## Quick Start

```bash
# Clone and install
git clone https://github.com/Ataraxy-Labs/opensessions.git
cd opensessions
bun install

# Run tests
bun run test

# Start the TUI (requires tmux)
cd packages/tui && bun run start
```

## Packages

| Package | Description |
|---------|-------------|
| [`@opensessions/core`](./packages/core) | Server, contracts, mux providers, agent tracker |
| [`@opensessions/tui`](./packages/tui) | OpenTUI terminal sidebar (Solid) |

## Architecture

```
┌─────────────────┐     POST /event     ┌─────────────────┐
│  Coding Agent   │ ──────────────────→  │   Server        │
│  (Amp, Claude,  │                      │  (WebSocket)    │
│   OpenCode...)  │                      │                 │
└─────────────────┘                      │  AgentTracker   │
                                         │  MuxProvider    │
┌─────────────────┐     WebSocket        │  GitCache       │
│  TUI Client     │ ←──────────────────  │                 │
│  (OpenTUI)      │                      └─────────────────┘
└─────────────────┘           ↕
                         ┌─────────────────┐
                         │  Mux Provider   │
                         │  (tmux/zellij)  │
                         └─────────────────┘
```

## Agent Integration

Any agent can report status by POSTing to the server — no code changes required.

```bash
curl -X POST http://127.0.0.1:7391/event \
  -H 'Content-Type: application/json' \
  -d '{"agent":"my-agent","session":"my-session","status":"running","ts":'$(date +%s000)'}'
```

Ready-to-use examples for **Amp**, **Claude Code**, **OpenCode**, and **Aider** in [CONTRACTS.md](./CONTRACTS.md).

## Adding a Mux Provider

Implement the `MuxProvider` interface from `@opensessions/core`:

```typescript
interface MuxProvider {
  name: string;
  listSessions(): MuxSessionInfo[];
  switchSession(name: string, clientTty?: string): void;
  getCurrentSession(): string | null;
  getSessionDir(name: string): string;
  getPaneCount(name: string): number;
  getClientTty(): string;
  setupHooks(serverHost: string, serverPort: number): void;
  cleanupHooks(): void;
}
```

See [CONTRACTS.md](./CONTRACTS.md#muxprovider-interface) for the full guide.

## Built with

[Solid-js TUI](https://github.com/anomalyco/opentui) · [Bun](https://bun.sh) · WebSockets · [Catppuccin](https://catppuccin.com)

## License

MIT · [Ataraxy Labs](https://github.com/Ataraxy-Labs)
