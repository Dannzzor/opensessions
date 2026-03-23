import type { AgentEvent } from "../contracts/agent";
import { TERMINAL_STATUSES } from "../contracts/agent";

export class AgentTracker {
  private states = new Map<string, AgentEvent>();
  private unseen = new Set<string>();
  private active = new Set<string>();

  applyEvent(event: AgentEvent): void {
    this.states.set(event.session, event);

    if (TERMINAL_STATUSES.has(event.status)) {
      if (!this.active.has(event.session)) {
        this.unseen.add(event.session);
      }
    } else {
      this.unseen.delete(event.session);
    }
  }

  getState(session: string): AgentEvent | null {
    return this.states.get(session) ?? null;
  }

  markSeen(session: string): boolean {
    const cleared = this.unseen.delete(session);
    if (cleared) {
      const state = this.states.get(session);
      if (state && TERMINAL_STATUSES.has(state.status)) {
        this.states.delete(session);
      }
    }
    return cleared;
  }

  pruneStuck(timeoutMs: number): void {
    const now = Date.now();
    for (const [session, state] of this.states) {
      if (state.status === "running" && now - state.ts > timeoutMs) {
        this.states.delete(session);
        this.unseen.delete(session);
      }
    }
  }

  isUnseen(session: string): boolean {
    return this.unseen.has(session);
  }

  getUnseen(): string[] {
    return [...this.unseen];
  }

  handleFocus(session: string): boolean {
    this.active.clear();
    this.active.add(session);

    const hadUnseen = this.unseen.delete(session);
    if (hadUnseen) {
      const state = this.states.get(session);
      if (state && TERMINAL_STATUSES.has(state.status)) {
        this.states.delete(session);
      }
    }
    return hadUnseen;
  }

  setActiveSessions(sessions: string[]): void {
    this.active.clear();
    for (const s of sessions) this.active.add(s);
  }
}
