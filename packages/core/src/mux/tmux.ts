import type { MuxProvider, MuxSessionInfo } from "../contracts/mux";

function run(cmd: string[]): string {
  try {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return result.stdout.toString().trim();
  } catch {
    return "";
  }
}

export class TmuxProvider implements MuxProvider {
  readonly name = "tmux";

  listSessions(): MuxSessionInfo[] {
    const raw = run([
      "tmux", "list-sessions", "-F",
      "#{session_name}\t#{session_created}\t#{session_windows}\t#{pane_current_path}",
    ]);
    if (!raw) return [];

    return raw.split("\n").map((line) => {
      const [name, created, wins, dir] = line.split("\t");
      return {
        name: name!,
        createdAt: parseInt(created ?? "0", 10),
        dir: dir ?? "",
        windows: parseInt(wins ?? "1", 10),
      };
    });
  }

  switchSession(name: string, clientTty?: string): void {
    if (clientTty) {
      Bun.spawnSync(["tmux", "switch-client", "-c", clientTty, "-t", name]);
    } else {
      Bun.spawnSync(["tmux", "switch-client", "-t", name]);
    }
  }

  getCurrentSession(): string | null {
    const out = run(["tmux", "list-clients", "-F", "#{client_session}"]);
    if (!out) return null;
    const first = out.split("\n")[0]?.trim();
    return first || null;
  }

  getSessionDir(name: string): string {
    return run([
      "tmux", "display-message", "-t", name, "-p", "#{pane_current_path}",
    ]);
  }

  getPaneCount(name: string): number {
    const out = run(["tmux", "list-panes", "-t", name, "-F", "#{pane_id}"]);
    if (!out) return 0;
    return out.split("\n").filter((l) => l.trim()).length;
  }

  getClientTty(): string {
    return run(["tmux", "display-message", "-p", "#{client_tty}"]);
  }

  setupHooks(serverHost: string, serverPort: number): void {
    const focusCmd = `run-shell -b "curl -s -o /dev/null -X POST http://${serverHost}:${serverPort}/focus -d $(tmux display-message -p '#{client_session}')"`;
    const refreshCmd = `run-shell -b "curl -s -o /dev/null -X POST http://${serverHost}:${serverPort}/refresh"`;

    Bun.spawnSync(["tmux", "set-hook", "-g", "client-session-changed", focusCmd], {
      stdout: "pipe", stderr: "pipe",
    });
    Bun.spawnSync(["tmux", "set-hook", "-g", "session-created", refreshCmd], {
      stdout: "pipe", stderr: "pipe",
    });
    Bun.spawnSync(["tmux", "set-hook", "-g", "session-closed", refreshCmd], {
      stdout: "pipe", stderr: "pipe",
    });
  }

  cleanupHooks(): void {
    Bun.spawnSync(["tmux", "set-hook", "-gu", "client-session-changed"], {
      stdout: "pipe", stderr: "pipe",
    });
    Bun.spawnSync(["tmux", "set-hook", "-gu", "session-created"], {
      stdout: "pipe", stderr: "pipe",
    });
    Bun.spawnSync(["tmux", "set-hook", "-gu", "session-closed"], {
      stdout: "pipe", stderr: "pipe",
    });
  }

  /**
   * Batch pane count retrieval for all sessions at once.
   * Returns a map of session name → pane count.
   * Used by the server for efficient state computation.
   */
  getAllPaneCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const raw = run(["tmux", "list-panes", "-a", "-F", "#{session_name}"]);
    if (!raw) return counts;
    for (const name of raw.split("\n")) {
      const n = name.trim();
      if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return counts;
  }
}
