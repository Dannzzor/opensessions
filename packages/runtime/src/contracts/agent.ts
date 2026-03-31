export type AgentStatus = "idle" | "running" | "tool-running" | "done" | "error" | "waiting" | "interrupted" | "stale";

export interface AgentEvent {
  agent: string;
  session: string;
  status: AgentStatus;
  ts: number;
  threadId?: string;
  threadName?: string;
  /** Set by tracker when serializing for the TUI — true if user hasn't seen this terminal state */
  unseen?: boolean;
  /** Set by pane scanner — the tmux pane ID where this agent was detected */
  paneId?: string;
}

export const TERMINAL_STATUSES = new Set<AgentStatus>(["done", "error", "interrupted", "stale"]);
