import { existsSync, readFileSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import type { MuxProvider } from "../contracts/mux";
import type { AgentEvent } from "../contracts/agent";
import { AgentTracker } from "../agents/tracker";
import {
  type ServerState,
  type SessionData,
  type ClientCommand,
  type FocusUpdate,
  SERVER_PORT,
  SERVER_HOST,
  PID_FILE,
  SERVER_IDLE_TIMEOUT_MS,
  STUCK_RUNNING_TIMEOUT_MS,
  EVENTS_FILE,
} from "../shared";

// --- Shell helper ---

function run(cmd: string[]): string {
  try {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return result.stdout.toString().trim();
  } catch {
    return "";
  }
}

// --- Git helpers ---

interface GitInfo {
  branch: string;
  dirty: boolean;
  isWorktree: boolean;
}

const gitInfoCache = new Map<string, { info: GitInfo; ts: number }>();
const GIT_CACHE_TTL_MS = 5000;

function getGitInfo(dir: string): GitInfo {
  if (!dir) return { branch: "", dirty: false, isWorktree: false };

  const cached = gitInfoCache.get(dir);
  if (cached && Date.now() - cached.ts < GIT_CACHE_TTL_MS) return cached.info;

  const out = run([
    "sh", "-c",
    `cd "${dir}" 2>/dev/null && git rev-parse --abbrev-ref HEAD --git-dir 2>/dev/null && echo "---" && git status --porcelain 2>/dev/null`,
  ]);
  if (!out) return { branch: "", dirty: false, isWorktree: false };
  const sepIdx = out.indexOf("---");
  const headerPart = sepIdx >= 0 ? out.slice(0, sepIdx).trim() : out.trim();
  const statusPart = sepIdx >= 0 ? out.slice(sepIdx + 3).trim() : "";
  const lines = headerPart.split("\n");
  const branch = lines[0] ?? "";
  const gitDir = lines[1] ?? "";
  const info: GitInfo = {
    branch,
    dirty: statusPart.length > 0,
    isWorktree: gitDir.includes("/worktrees/"),
  };
  gitInfoCache.set(dir, { info, ts: Date.now() });
  return info;
}

function invalidateGitCache(dir?: string) {
  if (dir) gitInfoCache.delete(dir);
  else gitInfoCache.clear();
}

// --- Git HEAD file watchers ---

const gitHeadWatchers = new Map<string, FSWatcher>();

function resolveGitHeadPath(dir: string): string | null {
  if (!dir) return null;
  const gitDir = run(["git", "-C", dir, "rev-parse", "--git-dir"]);
  if (!gitDir) return null;
  const absGitDir = gitDir.startsWith("/") ? gitDir : join(dir, gitDir);
  const headPath = join(absGitDir, "HEAD");
  return existsSync(headPath) ? headPath : null;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onGitHeadChange(broadcastFn: () => void) {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    invalidateGitCache();
    broadcastFn();
  }, 200);
}

function syncGitWatchers(sessions: SessionData[], broadcastFn: () => void) {
  const currentDirs = new Set<string>();
  for (const s of sessions) {
    if (s.dir) currentDirs.add(s.dir);
  }

  for (const [dir, watcher] of gitHeadWatchers) {
    if (!currentDirs.has(dir)) {
      watcher.close();
      gitHeadWatchers.delete(dir);
    }
  }

  for (const dir of currentDirs) {
    if (gitHeadWatchers.has(dir)) continue;
    const headPath = resolveGitHeadPath(dir);
    if (!headPath) continue;
    try {
      const watcher = watch(headPath, () => onGitHeadChange(broadcastFn));
      gitHeadWatchers.set(dir, watcher);
    } catch { /* ignore */ }
  }
}

// --- Events file fallback ---

let eventsFileSize = 0;

function readEventsFileFallback(tracker: AgentTracker): void {
  try {
    if (!existsSync(EVENTS_FILE)) return;
    const content = readFileSync(EVENTS_FILE, "utf-8");
    if (content.length <= eventsFileSize) return;
    const newContent = content.slice(eventsFileSize);
    eventsFileSize = content.length;
    for (const line of newContent.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as AgentEvent;
        if (event.session && event.status) tracker.applyEvent(event);
      } catch {}
    }
  } catch {}
}

// --- Server startup ---

export function startServer(mux: MuxProvider): void {
  const tracker = new AgentTracker();

  // Bootstrap active sessions
  const currentSession = mux.getCurrentSession();
  if (currentSession) {
    tracker.setActiveSessions([currentSession]);
  }

  let focusedSession: string | null = null;
  let lastState: ServerState | null = null;
  let clientCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clientTtys = new WeakMap<object, string>();

  function getCurrentSession(): string | null {
    return mux.getCurrentSession();
  }

  function computeState(): ServerState {
    const muxSessions = mux.listSessions();
    muxSessions.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.name.localeCompare(b.name);
    });

    // Batch pane counts if the provider supports it
    let paneCountMap: Map<string, number> | null = null;
    if ("getAllPaneCounts" in mux && typeof (mux as any).getAllPaneCounts === "function") {
      paneCountMap = (mux as any).getAllPaneCounts();
    }

    const sessions: SessionData[] = muxSessions.map(({ name, createdAt, windows, dir }) => {
      const git = getGitInfo(dir);
      const panes = paneCountMap?.get(name) ?? mux.getPaneCount(name);

      let uptime = "";
      const diff = Math.floor(Date.now() / 1000) - createdAt;
      if (!isNaN(diff) && diff >= 0) {
        const days = Math.floor(diff / 86400);
        const hours = Math.floor((diff % 86400) / 3600);
        const mins = Math.floor((diff % 3600) / 60);
        if (days > 0) uptime = `${days}d${hours}h`;
        else if (hours > 0) uptime = `${hours}h${mins}m`;
        else uptime = `${mins}m`;
      }

      return {
        name,
        createdAt,
        dir,
        branch: git.branch,
        dirty: git.dirty,
        isWorktree: git.isWorktree,
        unseen: tracker.isUnseen(name),
        panes,
        windows,
        uptime,
        agentState: tracker.getState(name),
      };
    });

    if (sessions.length === 0) {
      focusedSession = null;
    } else if (!focusedSession || !sessions.some((s) => s.name === focusedSession)) {
      focusedSession = sessions[0]!.name;
    }

    return { type: "state", sessions, focusedSession, currentSession: getCurrentSession(), ts: Date.now() };
  }

  function broadcastState() {
    readEventsFileFallback(tracker);
    tracker.pruneStuck(STUCK_RUNNING_TIMEOUT_MS);
    lastState = computeState();
    syncGitWatchers(lastState.sessions, broadcastState);
    const msg = JSON.stringify(lastState);
    server.publish("sidebar", msg);
  }

  function broadcastFocusOnly(sender?: any) {
    if (!lastState) return;
    const currentSession = getCurrentSession();
    lastState = { ...lastState, focusedSession, currentSession };
    const msg: FocusUpdate = { type: "focus", focusedSession, currentSession };
    const payload = JSON.stringify(msg);
    if (sender) {
      sender.publish("sidebar", payload);
    } else {
      server.publish("sidebar", payload);
    }
  }

  function moveFocus(delta: -1 | 1, sender?: any) {
    if (!lastState || lastState.sessions.length === 0) return;
    const sessions = lastState.sessions;
    const currentIdx = sessions.findIndex((s) => s.name === focusedSession);
    const newIdx = Math.max(0, Math.min(sessions.length - 1, (currentIdx === -1 ? 0 : currentIdx) + delta));
    focusedSession = sessions[newIdx]!.name;
    broadcastFocusOnly(sender);
  }

  function setFocus(name: string, sender?: any) {
    if (lastState && lastState.sessions.some((s) => s.name === name)) {
      focusedSession = name;
      broadcastFocusOnly(sender);
    }
  }

  function handleFocus(name: string): void {
    focusedSession = name;
    const hadUnseen = tracker.handleFocus(name);
    if (hadUnseen) {
      broadcastState();
    } else {
      broadcastFocusOnly();
    }
  }

  function handleCommand(cmd: ClientCommand, ws: any) {
    switch (cmd.type) {
      case "identify":
        clientTtys.set(ws, cmd.clientTty);
        break;
      case "switch-session": {
        const tty = cmd.clientTty ?? clientTtys.get(ws);
        mux.switchSession(cmd.name, tty);
        break;
      }
      case "switch-index": {
        if (!lastState) break;
        const idx = cmd.index - 1;
        if (idx >= 0 && idx < lastState.sessions.length) {
          mux.switchSession(lastState.sessions[idx]!.name);
        }
        break;
      }
      case "new-session":
        Bun.spawnSync(["tmux", "new-session", "-d"]); // TODO: add to MuxProvider
        broadcastState();
        break;
      case "kill-session":
        Bun.spawnSync(["tmux", "kill-session", "-t", cmd.name]); // TODO: add to MuxProvider
        broadcastState();
        break;
      case "refresh":
        broadcastState();
        break;
      case "move-focus":
        moveFocus(cmd.delta, ws);
        break;
      case "focus-session":
        setFocus(cmd.name, ws);
        break;
      case "mark-seen":
        if (tracker.markSeen(cmd.name)) broadcastState();
        break;
    }
  }

  function cleanup() {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const watcher of gitHeadWatchers.values()) watcher.close();
    gitHeadWatchers.clear();
    if (idleTimer) clearTimeout(idleTimer);
    try { unlinkSync(PID_FILE); } catch {}
    mux.cleanupHooks();
  }

  // --- Write PID + start server ---

  writeFileSync(PID_FILE, String(process.pid));

  const server = Bun.serve({
    port: SERVER_PORT,
    hostname: SERVER_HOST,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/event") {
        try {
          const body = await req.json() as any;
          if (body.session && body.status) {
            tracker.applyEvent(body as AgentEvent);
            broadcastState();
          }
        } catch {}
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/refresh") {
        broadcastState();
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/focus") {
        try {
          let name = await req.text();
          name = name.trim().replace(/^"+|"+$/g, "");
          if (name) handleFocus(name);
        } catch {}
        return new Response("ok", { status: 200 });
      }

      if (server.upgrade(req, { data: {} })) return;
      return new Response("opensessions server", { status: 200 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("sidebar");
        clientCount++;
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (lastState) {
          ws.send(JSON.stringify(lastState));
        } else {
          broadcastState();
        }
      },
      close(ws) {
        ws.unsubscribe("sidebar");
        clientCount--;
        if (clientCount <= 0) {
          clientCount = 0;
          idleTimer = setTimeout(() => {
            cleanup();
            process.exit(0);
          }, SERVER_IDLE_TIMEOUT_MS);
        }
      },
      message(ws, msg) {
        try {
          const cmd = JSON.parse(msg as string) as ClientCommand;
          handleCommand(cmd, ws);
        } catch {}
      },
    },
  });

  // --- Bootstrap ---

  mux.setupHooks(SERVER_HOST, SERVER_PORT);
  broadcastState();

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  console.log(`opensessions server listening on ${SERVER_HOST}:${SERVER_PORT} (mux: ${mux.name})`);
}
