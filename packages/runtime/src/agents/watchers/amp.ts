/**
 * Amp agent watcher — Cloud API + DTW WebSocket edition
 *
 * Uses a two-tier strategy for watching Amp thread status:
 *
 * 1. **Polling** (Phase 1): Periodically fetches the thread list API to
 *    discover threads and detect status changes. Used for seed, discovery
 *    of new threads, and as a fallback when WebSocket isn't available.
 *
 * 2. **DTW WebSocket** (Phase 2): For threads detected as actively running,
 *    connects to the Durable Thread Worker WebSocket for real-time
 *    `agentStates` updates. Provides instant status transitions without
 *    polling. Automatically disconnects on terminal states and falls back
 *    to polling on failure.
 *
 * ## Data source
 *
 * Amp stores threads in the cloud (Durable Thread Workers / DTW).
 * The local directory ~/.local/share/amp/threads/ is no longer written to.
 *
 * - Credentials: ~/.local/share/amp/secrets.json
 *   Key format: "apiKey@<ampUrl>" (e.g. "apiKey@https://ampcode.com/")
 *   Fallback: "apiKey" field
 *
 * - Amp URL: ~/.config/amp/settings.json `.url` field
 *   Default: https://ampcode.com
 *
 * - Thread list: GET <ampUrl>/api/threads?limit=20
 *   Returns array of threads with id, title, v, updatedAt,
 *   env.initial.trees[0].uri (project dir as file:// URI)
 *
 * - Thread detail: GET <ampUrl>/api/threads/<id>
 *   Returns full thread with messages[] array.
 *   Each message has role, state.type, state.stopReason — exactly
 *   what our determineStatus() function parses.
 *
 * - DTW WebSocket: POST <ampUrl>/api/durable-thread-workers with {threadId}
 *   returns {wsToken}. Connect to wss://production.ampworkers.com/threads/<id>?wsToken=<token>
 *   to receive real-time agentStates stream: { state: "idle"|"running"|"tool-running"|"waiting" }
 *
 * ## Amp Thread Message Lifecycle
 *
 * ### Message structure
 *   - role: "user" | "assistant"
 *   - state?: { type: string; stopReason?: string }  (assistant only)
 *   - interrupted?: boolean  (user only)
 *   - content: ContentItem[]  (tool_use, tool_result, text, thinking)
 *
 * ### State types (assistant messages)
 *   - `streaming`  → "running"
 *   - `complete` + stopReason:
 *       - `end_turn`   → "done"
 *       - `tool_use`   → "running"
 *       - other        → "error"
 *   - `cancelled`  → "interrupted"
 *
 * ### User messages
 *   - content=[tool_result] with run.status=in-progress → "tool-running"
 *   - otherwise → "running"
 *
 * ### Waiting / stale detection
 *   After TOOL_WAIT_MS (3s) with no version changes at a tool boundary,
 *   "running" → "waiting". After STUCK_RUNNING_MS (2m) with no version
 *   changes while actively running/waiting, → "stale".
 *
 * All network I/O is async to avoid blocking the server event loop.
 */

import { join } from "path";
import { homedir } from "os";
import type { AgentStatus } from "../../contracts/agent";
import { TERMINAL_STATUSES } from "../../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";

// --- Thread/message types ---

interface MessageState {
  type?: string;
  stopReason?: string;
}

interface Message {
  role?: string;
  state?: MessageState;
  interrupted?: boolean;
  content?: ContentItem[] | string;
}

interface ContentItem {
  type?: string;
  run?: {
    status?: string;
  };
}

interface ThreadSnapshot {
  status: AgentStatus;
  version: number;
  title?: string;
  projectDir?: string;
  /** Timestamp when we last saw the version advance. For stuck detection. */
  lastGrowthAt?: number;
  /** Whether this running snapshot represents a quiet tool boundary that should become waiting. */
  waitingEligible?: boolean;
}

/** API thread list item — subset of fields we use */
interface ApiThreadSummary {
  id: string;
  v: number;
  title?: string;
  updatedAt?: string;
  env?: {
    initial?: {
      trees?: Array<{ uri?: string }>;
    };
  };
}

/** API thread detail — subset of fields we use */
interface ApiThreadDetail {
  id: string;
  v: number;
  title?: string;
  messages?: Message[];
  env?: {
    initial?: {
      trees?: Array<{ uri?: string }>;
    };
  };
}

/** POST /api/durable-thread-workers response */
interface DtwTokenResponse {
  wsToken: string;
  threadVersion?: number;
  usesDtw?: boolean;
}

/** WebSocket agentStates message shape */
interface AgentStateMessage {
  type?: string;
  state?: string;
}

const DTW_WS_BASE = "wss://production.ampworkers.com";
const POLL_MS = 2000;
/** How long to wait before promoting quiet tool boundaries from running → waiting */
const TOOL_WAIT_MS = 3_000;
/** How long Amp can stay quiet before we consider the thread stale */
const STUCK_RUNNING_MS = 2 * 60 * 1000;
/** Only consider threads updated in the last 5 minutes */
const RECENT_MS = 5 * 60 * 1000;

// --- Status detection ---

/**
 * Determine the agent status from the last message in a thread.
 *
 * Returns the status implied by the message. Called with the last
 * element of the `messages` array from the thread JSON.
 */
export function determineStatus(lastMsg: { role?: string; state?: MessageState; interrupted?: boolean; content?: ContentItem[] | string } | null): AgentStatus {
  if (!lastMsg?.role) return "idle";

  if (lastMsg.role === "user") {
    if (hasToolResultRunStatus(lastMsg.content, "in-progress")) return "tool-running";
    return "running";
  }

  if (lastMsg.role === "assistant") {
    const state = lastMsg.state;
    if (!state || !state.type) return "running";

    if (state.type === "streaming") return "running";
    if (state.type === "cancelled") return "interrupted";

    if (state.type === "complete") {
      if (state.stopReason === "tool_use") return "running";
      if (state.stopReason === "end_turn") return "done";
      // Other stop reasons (max_tokens, etc.) are terminal failures.
      return "error";
    }

    // Unknown state type — defensive, treat as running
    return "running";
  }

  return "idle";
}

function hasContentType(content: Message["content"], type: string): boolean {
  return Array.isArray(content) && content.some((item) => item?.type === type);
}

function hasToolResultRunStatus(content: Message["content"], status: string): boolean {
  return Array.isArray(content) && content.some((item) => item?.type === "tool_result" && item.run?.status === status);
}

function isWaitingCandidate(lastMsg: Message | null): boolean {
  if (!lastMsg) return false;

  if (lastMsg.role === "assistant") {
    return lastMsg.state?.type === "complete" && lastMsg.state.stopReason === "tool_use";
  }

  if (lastMsg.role === "user") {
    return hasContentType(lastMsg.content, "tool_result") && !hasToolResultRunStatus(lastMsg.content, "in-progress");
  }

  return false;
}

// --- Credential / config loading ---

async function loadAmpUrl(): Promise<string> {
  try {
    const settingsPath = join(homedir(), ".config", "amp", "settings.json");
    const raw = await Bun.file(settingsPath).text();
    const settings = JSON.parse(raw);
    if (settings.url && typeof settings.url === "string") return settings.url.replace(/\/$/, "");
  } catch {
    // settings.json doesn't exist or is unreadable
  }
  return "https://ampcode.com";
}

async function loadApiKey(ampUrl: string): Promise<string | null> {
  try {
    const secretsPath = join(homedir(), ".local", "share", "amp", "secrets.json");
    const raw = await Bun.file(secretsPath).text();
    const secrets = JSON.parse(raw);

    // Try URL-specific key first (with and without trailing slash)
    const urlWithSlash = ampUrl.endsWith("/") ? ampUrl : `${ampUrl}/`;
    const urlWithoutSlash = ampUrl.replace(/\/$/, "");

    const key =
      secrets[`apiKey@${urlWithSlash}`] ??
      secrets[`apiKey@${urlWithoutSlash}`] ??
      secrets.apiKey;

    return typeof key === "string" && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

// --- API helpers ---

function extractProjectDir(thread: { env?: { initial?: { trees?: Array<{ uri?: string }> } } }): string | undefined {
  const uri = thread.env?.initial?.trees?.[0]?.uri ?? "";
  return uri.startsWith("file://") ? uri.slice(7) : undefined;
}

// --- Watcher implementation ---

export class AmpAgentWatcher implements AgentWatcher {
  readonly name = "amp";

  /** Internal thread state — exposed for testing via (watcher as any).threads */
  private threads = new Map<string, ThreadSnapshot>();
  /** Active WebSocket connections per thread ID */
  private wsConnections = new Map<string, WebSocket>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ctx: AgentWatcherContext | null = null;
  private scanning = false;
  private seeded = false;

  /** Loaded once at start. Overridable for testing. */
  private ampUrl: string | null = null;
  private apiKey: string | null = null;

  /**
   * Override the fetch function for testing.
   * Defaults to globalThis.fetch.
   */
  _fetch: typeof fetch = globalThis.fetch.bind(globalThis);

  /**
   * Override WebSocket constructor for testing.
   * Defaults to globalThis.WebSocket.
   */
  _WebSocket: typeof WebSocket = globalThis.WebSocket;

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    this.initAndPoll();
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const [, ws] of this.wsConnections) {
      try { ws.close(); } catch {}
    }
    this.wsConnections.clear();
    this.ctx = null;
  }

  private async initAndPoll(): Promise<void> {
    this.ampUrl = await loadAmpUrl();
    this.apiKey = await loadApiKey(this.ampUrl);
    if (!this.apiKey) return;

    // First scan is the seed
    await this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
  }

  /** Emit a status change event if we have a valid session mapping */
  private emitStatus(threadId: string, snapshot: ThreadSnapshot): boolean {
    if (!this.ctx || !snapshot.projectDir || snapshot.status === "idle") return false;

    const session = this.ctx.resolveSession(snapshot.projectDir);
    if (!session || session === "unknown") return false;

    this.ctx.emit({
      agent: "amp",
      session,
      status: snapshot.status,
      ts: Date.now(),
      threadId,
      threadName: snapshot.title,
    });
    return true;
  }

  private async poll(): Promise<void> {
    if (this.scanning || !this.ctx || !this.ampUrl || !this.apiKey) return;
    this.scanning = true;
    const initialSeed = !this.seeded;

    try {
      const threads = await this.fetchThreadList();
      if (!threads) return;

      const now = Date.now();

      for (const thread of threads) {
        const updatedAt = thread.updatedAt ? new Date(thread.updatedAt).getTime() : 0;
        if (now - updatedAt > RECENT_MS) continue;

        const prev = this.threads.get(thread.id);

        // Version unchanged — check waiting/stale timers
        if (prev && thread.v === prev.version) {
          if (!this.seeded) continue;

          if (prev.status === "running" && prev.waitingEligible && prev.lastGrowthAt && now - prev.lastGrowthAt >= TOOL_WAIT_MS) {
            prev.status = "waiting";
            prev.waitingEligible = false;
            this.emitStatus(thread.id, prev);
            continue;
          }

          if ((prev.status === "tool-running" || prev.status === "waiting" || (prev.status === "running" && !prev.waitingEligible)) && prev.lastGrowthAt && now - prev.lastGrowthAt >= STUCK_RUNNING_MS) {
            prev.status = "stale";
            prev.lastGrowthAt = undefined;
            prev.waitingEligible = false;
            this.emitStatus(thread.id, prev);
            continue;
          }

          continue;
        }

        // Version changed or new thread — fetch full detail
        await this.processThread(thread.id, thread, prev, now);
      }
    } finally {
      if (initialSeed) {
        this.seeded = true;
        for (const [threadId, snapshot] of this.threads) {
          this.emitStatus(threadId, snapshot);
          // Connect WebSockets for running threads discovered during seed
          if (!TERMINAL_STATUSES.has(snapshot.status) && snapshot.status !== "idle" && !this.wsConnections.has(threadId)) {
            this.connectWebSocket(threadId);
          }
        }
      }
      this.scanning = false;
    }
  }

  private async processThread(
    threadId: string,
    summary: ApiThreadSummary,
    prev: ThreadSnapshot | undefined,
    now: number,
  ): Promise<void> {
    const detail = await this.fetchThreadDetail(threadId);
    if (!detail) return;

    const messages = detail.messages ?? [];
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const projectDir = extractProjectDir(detail);
    const title = detail.title || undefined;
    const version = detail.v ?? summary.v ?? 0;

    const status = determineStatus(lastMsg ? { role: lastMsg.role, state: lastMsg.state, interrupted: lastMsg.interrupted, content: lastMsg.content } : null);
    const waitingEligible = status === "running" && isWaitingCandidate(lastMsg);
    const statusChanged = prev?.status !== status;
    const titleChanged = prev?.title !== title;
    const projectDirChanged = prev?.projectDir !== projectDir;

    if (prev && version === prev.version && !statusChanged && !titleChanged && !projectDirChanged) {
      if (prev.status === "running" || prev.status === "tool-running" || prev.status === "waiting") prev.lastGrowthAt = now;
      prev.waitingEligible = waitingEligible;
      return;
    }

    const snapshot: ThreadSnapshot = {
      status,
      version,
      title,
      projectDir,
      lastGrowthAt: (status === "running" || status === "tool-running") ? now : undefined,
      waitingEligible,
    };
    this.threads.set(threadId, snapshot);

    // Seed mode: record state without emitting
    if (!this.seeded) return;

    if (statusChanged || titleChanged) this.emitStatus(threadId, snapshot);

    // Connect WebSocket for actively running threads (non-terminal, non-idle)
    if (!TERMINAL_STATUSES.has(status) && status !== "idle" && !this.wsConnections.has(threadId)) {
      this.connectWebSocket(threadId);
    }
  }

  // --- DTW WebSocket streaming ---

  private async connectWebSocket(threadId: string): Promise<void> {
    if (!this.ampUrl || !this.apiKey) return;
    if (this.wsConnections.has(threadId)) return;

    const token = await this.fetchDtwToken(threadId);
    if (!token) return;

    try {
      const wsUrl = `${DTW_WS_BASE}/threads/${threadId}?wsToken=${token}`;
      const ws = new this._WebSocket(wsUrl);

      this.wsConnections.set(threadId, ws);

      ws.onmessage = (event) => {
        this.handleWsMessage(threadId, event.data);
      };

      ws.onclose = () => {
        this.wsConnections.delete(threadId);
      };

      ws.onerror = () => {
        this.wsConnections.delete(threadId);
        try { ws.close(); } catch {}
      };
    } catch {
      // WebSocket construction failed — polling will handle it
    }
  }

  private handleWsMessage(threadId: string, data: unknown): void {
    if (!this.ctx) return;

    try {
      const raw = typeof data === "string" ? data : String(data);
      const msg: AgentStateMessage = JSON.parse(raw);

      if (!msg.state) return;

      const status = msg.state as AgentStatus;
      const snapshot = this.threads.get(threadId);
      if (!snapshot) return;

      const now = Date.now();

      if (snapshot.status === status) {
        // Same status — update growth timestamp
        if (status === "running" || status === "tool-running") {
          snapshot.lastGrowthAt = now;
        }
        return;
      }

      snapshot.status = status;
      snapshot.lastGrowthAt = (status === "running" || status === "tool-running") ? now : undefined;
      snapshot.waitingEligible = false;

      this.emitStatus(threadId, snapshot);

      // Disconnect on terminal states — polling will pick up any future changes
      if (TERMINAL_STATUSES.has(status) || status === "idle") {
        this.disconnectWebSocket(threadId);
      }
    } catch {
      // Malformed message — ignore
    }
  }

  private disconnectWebSocket(threadId: string): void {
    const ws = this.wsConnections.get(threadId);
    if (ws) {
      this.wsConnections.delete(threadId);
      try { ws.close(); } catch {}
    }
  }

  private async fetchDtwToken(threadId: string): Promise<string | null> {
    try {
      const res = await this._fetch(`${this.ampUrl}/api/durable-thread-workers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadId }),
      });
      if (!res.ok) return null;
      const body = await res.json() as DtwTokenResponse;
      return body.wsToken ?? null;
    } catch {
      return null;
    }
  }

  // --- API helpers ---

  private async fetchThreadList(): Promise<ApiThreadSummary[] | null> {
    try {
      const res = await this._fetch(`${this.ampUrl}/api/threads?limit=20`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return null;
      return await res.json() as ApiThreadSummary[];
    } catch {
      return null;
    }
  }

  private async fetchThreadDetail(threadId: string): Promise<ApiThreadDetail | null> {
    try {
      const res = await this._fetch(`${this.ampUrl}/api/threads/${threadId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return null;
      return await res.json() as ApiThreadDetail;
    } catch {
      return null;
    }
  }
}
