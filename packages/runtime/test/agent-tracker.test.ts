import { describe, test, expect, beforeEach } from "bun:test";
import { AgentTracker } from "../src/agents/tracker";
import type { AgentEvent } from "../src/contracts/agent";

function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    agent: "amp",
    session: "sess-1",
    status: "running",
    ts: Date.now(),
    ...overrides,
  };
}

describe("AgentTracker", () => {
  let tracker: AgentTracker;

  beforeEach(() => {
    tracker = new AgentTracker();
  });

  // --- applyEvent ---

  test("applyEvent stores agent state by session", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "running" }));

    const state = tracker.getState("sess-1");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("running");
    expect(state!.agent).toBe("amp");
  });

  test("applyEvent overwrites previous state for same session", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "running" }));
    tracker.applyEvent(event({ session: "sess-1", status: "done" }));

    expect(tracker.getState("sess-1")!.status).toBe("done");
  });

  test("applyEvent marks terminal status as unseen when session not active", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done" }));

    expect(tracker.getUnseen()).toContain("sess-1");
  });

  test("applyEvent treats stale as a terminal unseen status", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "stale" }));

    expect(tracker.getUnseen()).toContain("sess-1");
    expect(tracker.getState("sess-1")!.status).toBe("stale");
  });

  test("pruneStuck removes tool-running states older than timeout", () => {
    const oldTs = Date.now() - 4 * 60 * 1000;
    tracker.applyEvent(event({ session: "sess-1", status: "tool-running", ts: oldTs }));

    tracker.pruneStuck(3 * 60 * 1000);

    expect(tracker.getState("sess-1")).toBeNull();
  });

  test("applyEvent does NOT mark terminal status as unseen when session is active", () => {
    tracker.setActiveSessions(["sess-1"]);
    tracker.applyEvent(event({ session: "sess-1", status: "done" }));

    expect(tracker.getUnseen()).not.toContain("sess-1");
  });

  test("applyEvent clears unseen when same instance transitions to non-terminal", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done", threadId: "t1" }));
    expect(tracker.getUnseen()).toContain("sess-1");

    tracker.applyEvent(event({ session: "sess-1", status: "running", threadId: "t1" }));
    expect(tracker.getUnseen()).not.toContain("sess-1");
  });

  test("applyEvent: resuming thread A does NOT clear thread B unseen", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done", threadId: "t1" }));
    tracker.applyEvent(event({ session: "sess-1", status: "done", threadId: "t2" }));
    expect(tracker.isUnseen("sess-1")).toBe(true);

    // Thread A resumes (user interacted) — but thread B is still unseen
    tracker.applyEvent(event({ session: "sess-1", status: "running", threadId: "t1" }));
    expect(tracker.isUnseen("sess-1")).toBe(true); // thread B still unseen
  });

  // --- getState ---

  test("getState returns null for unknown session", () => {
    expect(tracker.getState("unknown")).toBeNull();
  });

  // --- markSeen ---

  test("markSeen clears unseen flag but keeps terminal instances", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done" }));
    expect(tracker.getUnseen()).toContain("sess-1");

    const cleared = tracker.markSeen("sess-1");
    expect(cleared).toBe(true);
    expect(tracker.getUnseen()).not.toContain("sess-1");
    // Instance still exists (seen terminal), pruneTerminal will clean it up
    expect(tracker.getState("sess-1")).not.toBeNull();
    expect(tracker.getState("sess-1")!.status).toBe("done");
  });

  test("markSeen returns false when session has no unseen", () => {
    expect(tracker.markSeen("nonexistent")).toBe(false);
  });

  test("markSeen does NOT remove state when status is not terminal", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "running" }));
    // Manually add to unseen to test edge case
    const cleared = tracker.markSeen("sess-1");
    expect(cleared).toBe(false);
    expect(tracker.getState("sess-1")).not.toBeNull();
  });

  test("dismiss removes only the targeted agent instance", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done", agent: "amp", threadId: "t1" }));
    tracker.applyEvent(event({ session: "sess-1", status: "running", agent: "codex", threadId: "t2" }));

    const dismissed = tracker.dismiss("sess-1", "amp", "t1");

    expect(dismissed).toBe(true);
    expect(tracker.getAgents("sess-1").map((agent) => `${agent.agent}:${agent.threadId}`)).toEqual(["codex:t2"]);
    expect(tracker.getUnseen()).not.toContain("sess-1");
  });

  // --- pruneStuck ---

  test("pruneStuck removes running states older than timeout", () => {
    const oldTs = Date.now() - 4 * 60 * 1000; // 4 minutes ago
    tracker.applyEvent(event({ session: "sess-1", status: "running", ts: oldTs }));

    tracker.pruneStuck(3 * 60 * 1000);

    expect(tracker.getState("sess-1")).toBeNull();
    expect(tracker.getUnseen()).not.toContain("sess-1");
  });

  test("pruneStuck does NOT remove recent running states", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "running", ts: Date.now() }));

    tracker.pruneStuck(3 * 60 * 1000);

    expect(tracker.getState("sess-1")).not.toBeNull();
  });

  test("pruneStuck does NOT remove non-running states regardless of age", () => {
    const oldTs = Date.now() - 10 * 60 * 1000;
    tracker.applyEvent(event({ session: "sess-1", status: "stale", ts: oldTs }));

    tracker.pruneStuck(3 * 60 * 1000);

    expect(tracker.getState("sess-1")).not.toBeNull();
  });

  // --- isUnseen ---

  test("isUnseen returns correct value", () => {
    expect(tracker.isUnseen("sess-1")).toBe(false);

    tracker.applyEvent(event({ session: "sess-1", status: "error" }));
    expect(tracker.isUnseen("sess-1")).toBe(true);

    tracker.markSeen("sess-1");
    expect(tracker.isUnseen("sess-1")).toBe(false);
  });

  // --- handleFocus ---

  test("handleFocus clears unseen for focused session", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done" }));
    expect(tracker.isUnseen("sess-1")).toBe(true);

    const hadUnseen = tracker.handleFocus("sess-1");
    expect(hadUnseen).toBe(true);
    expect(tracker.isUnseen("sess-1")).toBe(false);
  });

  test("handleFocus updates active sessions", () => {
    tracker.handleFocus("sess-2");

    // Now sess-2 is active; a terminal event shouldn't mark it unseen
    tracker.applyEvent(event({ session: "sess-2", status: "done" }));
    expect(tracker.isUnseen("sess-2")).toBe(false);
  });

  // --- getAgents unseen flag ---

  test("getAgents stamps unseen flag on terminal instances", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done", threadId: "t1" }));
    const agents = tracker.getAgents("sess-1");
    expect(agents.length).toBe(1);
    expect(agents[0]!.unseen).toBe(true);
  });

  test("getAgents does not stamp unseen on seen terminal instances", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done", threadId: "t1" }));
    tracker.markSeen("sess-1");
    const agents = tracker.getAgents("sess-1");
    expect(agents.length).toBe(1);
    expect(agents[0]!.unseen).toBeUndefined();
  });

  // --- getAgents ordering ---

  test("getAgents returns newest items first", () => {
    tracker.applyEvent(event({ session: "sess-1", status: "done", threadId: "t1", ts: 100 }));
    tracker.applyEvent(event({ session: "sess-1", status: "running", threadId: "t2", ts: 200 }));

    const agents = tracker.getAgents("sess-1");

    expect(agents.map((agent) => agent.threadId)).toEqual(["t2", "t1"]);
  });

  // --- pruneTerminal ---

  test("pruneTerminal removes seen terminal instances after timeout", () => {
    const oldTs = Date.now() - 6 * 60 * 1000; // 6 min ago, past TERMINAL_PRUNE_MS
    tracker.applyEvent(event({ session: "sess-1", status: "done", ts: oldTs }));
    tracker.markSeen("sess-1"); // Mark seen so pruneTerminal can remove it

    tracker.pruneTerminal();

    expect(tracker.getState("sess-1")).toBeNull();
  });

  test("pruneTerminal does NOT remove unseen terminal instances", () => {
    const oldTs = Date.now() - 6 * 60 * 1000;
    tracker.applyEvent(event({ session: "sess-1", status: "done", ts: oldTs }));
    // NOT marked seen

    tracker.pruneTerminal();

    expect(tracker.getState("sess-1")).not.toBeNull();
  });
});
