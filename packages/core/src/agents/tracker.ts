import type { AgentEvent } from "../contracts/agent";
import { TERMINAL_STATUSES } from "../contracts/agent";

const MAX_EVENT_TIMESTAMPS = 30;
const TERMINAL_PRUNE_MS = 5 * 60 * 1000;

const STATUS_PRIORITY: Record<string, number> = {
  running: 5,
  error: 4,
  interrupted: 3,
  waiting: 2,
  done: 1,
  idle: 0,
};

function instanceKey(agent: string, threadId?: string): string {
  return threadId ? `${agent}:${threadId}` : agent;
}

export class AgentTracker {
  // Outer key: session name, inner key: instance key (agent or agent:threadId)
  private instances = new Map<string, Map<string, AgentEvent>>();
  private eventTimestamps = new Map<string, number[]>();
  // Per-instance unseen tracking: "session\0instanceKey"
  private unseenInstances = new Set<string>();
  private active = new Set<string>();

  private unseenKey(session: string, key: string): string {
    return `${session}\0${key}`;
  }

  applyEvent(event: AgentEvent): void {
    const key = instanceKey(event.agent, event.threadId);

    // Store instance
    let sessionInstances = this.instances.get(event.session);
    if (!sessionInstances) {
      sessionInstances = new Map();
      this.instances.set(event.session, sessionInstances);
    }
    sessionInstances.set(key, event);

    // Track event timestamps
    let timestamps = this.eventTimestamps.get(event.session);
    if (!timestamps) {
      timestamps = [];
      this.eventTimestamps.set(event.session, timestamps);
    }
    timestamps.push(event.ts);
    if (timestamps.length > MAX_EVENT_TIMESTAMPS) {
      timestamps.splice(0, timestamps.length - MAX_EVENT_TIMESTAMPS);
    }

    // Per-instance unseen tracking
    const ukey = this.unseenKey(event.session, key);
    if (TERMINAL_STATUSES.has(event.status)) {
      if (!this.active.has(event.session)) {
        this.unseenInstances.add(ukey);
      }
    } else {
      // Non-terminal status for this instance = user is interacting, mark seen
      this.unseenInstances.delete(ukey);
    }
  }

  /** Returns the most important agent state for backward compat */
  getState(session: string): AgentEvent | null {
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances || sessionInstances.size === 0) return null;

    let best: AgentEvent | null = null;
    let bestPriority = -1;
    for (const event of sessionInstances.values()) {
      const p = STATUS_PRIORITY[event.status] ?? 0;
      if (p > bestPriority) {
        bestPriority = p;
        best = event;
      }
    }
    return best;
  }

  /** Returns all agent instances for a session, with unseen flag stamped */
  getAgents(session: string): AgentEvent[] {
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances) return [];
    return [...sessionInstances.values()]
      .map((event) => {
        const key = instanceKey(event.agent, event.threadId);
        const isUnseen = this.unseenInstances.has(this.unseenKey(session, key));
        return isUnseen ? { ...event, unseen: true } : event;
      })
      .sort((a, b) => b.ts - a.ts);
  }

  /** Returns recent event timestamps for sparkline rendering */
  getEventTimestamps(session: string): number[] {
    return this.eventTimestamps.get(session) ?? [];
  }

  markSeen(session: string): boolean {
    const hadUnseen = this.isUnseen(session);
    if (!hadUnseen) return false;

    // Clear unseen flags for all instances — keep the instances themselves
    // (pruneTerminal will remove seen terminal instances after timeout)
    const sessionInstances = this.instances.get(session);
    if (sessionInstances) {
      for (const key of sessionInstances.keys()) {
        this.unseenInstances.delete(this.unseenKey(session, key));
      }
    }
    return true;
  }

  dismiss(session: string, agent: string, threadId?: string): boolean {
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances) return false;

    const key = instanceKey(agent, threadId);
    const removed = sessionInstances.delete(key);
    if (!removed) return false;

    this.unseenInstances.delete(this.unseenKey(session, key));
    if (sessionInstances.size === 0) {
      this.instances.delete(session);
    }
    return true;
  }

  pruneStuck(timeoutMs: number): void {
    const now = Date.now();
    for (const [session, sessionInstances] of this.instances) {
      for (const [key, event] of sessionInstances) {
        if (event.status === "running" && now - event.ts > timeoutMs) {
          sessionInstances.delete(key);
          this.unseenInstances.delete(this.unseenKey(session, key));
        }
      }
      if (sessionInstances.size === 0) {
        this.instances.delete(session);
      }
    }
  }

  /** Auto-prune terminal instances older than timeout, but only if instance is not unseen */
  pruneTerminal(): void {
    const now = Date.now();
    for (const [session, sessionInstances] of this.instances) {
      for (const [key, event] of sessionInstances) {
        if (!TERMINAL_STATUSES.has(event.status)) continue;
        const ukey = this.unseenKey(session, key);
        if (this.unseenInstances.has(ukey)) continue; // Don't prune unseen — user hasn't looked yet
        if (now - event.ts > TERMINAL_PRUNE_MS) {
          sessionInstances.delete(key);
        }
      }
      if (sessionInstances.size === 0) {
        this.instances.delete(session);
      }
    }
  }

  isUnseen(session: string): boolean {
    // Session is unseen if any instance within it is unseen
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances) return false;
    for (const key of sessionInstances.keys()) {
      if (this.unseenInstances.has(this.unseenKey(session, key))) return true;
    }
    return false;
  }

  getUnseen(): string[] {
    // Derive session-level unseen from per-instance tracking
    const sessions = new Set<string>();
    for (const ukey of this.unseenInstances) {
      sessions.add(ukey.split("\0")[0]!);
    }
    return [...sessions];
  }

  handleFocus(session: string): boolean {
    this.active.clear();
    this.active.add(session);

    const hadUnseen = this.isUnseen(session);
    if (hadUnseen) {
      // Clear unseen flags — keep terminal instances visible (as "seen")
      // pruneTerminal will clean them up after timeout
      const sessionInstances = this.instances.get(session);
      if (sessionInstances) {
        for (const key of sessionInstances.keys()) {
          this.unseenInstances.delete(this.unseenKey(session, key));
        }
      }
    }
    return hadUnseen;
  }

  setActiveSessions(sessions: string[]): void {
    this.active.clear();
    for (const s of sessions) this.active.add(s);
  }
}
