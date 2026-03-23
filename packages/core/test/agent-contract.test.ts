import { describe, test, expect } from "bun:test";
import type { AgentStatus, AgentEvent } from "../src/contracts/agent";

describe("Agent Contract", () => {
  test("AgentEvent has required fields", () => {
    const event: AgentEvent = {
      agent: "amp",
      session: "my-session",
      status: "running",
      ts: Date.now(),
    };

    expect(event.agent).toBe("amp");
    expect(event.session).toBe("my-session");
    expect(event.status).toBe("running");
    expect(typeof event.ts).toBe("number");
  });

  test("AgentStatus includes all valid statuses", () => {
    const statuses: AgentStatus[] = [
      "idle",
      "running",
      "done",
      "error",
      "waiting",
      "interrupted",
    ];
    expect(statuses).toHaveLength(6);
  });

  test("TERMINAL_STATUSES contains done, error, interrupted", () => {
    // Import the actual set
    const { TERMINAL_STATUSES } = require("../src/contracts/agent");
    expect(TERMINAL_STATUSES.has("done")).toBe(true);
    expect(TERMINAL_STATUSES.has("error")).toBe(true);
    expect(TERMINAL_STATUSES.has("interrupted")).toBe(true);
    expect(TERMINAL_STATUSES.has("running")).toBe(false);
    expect(TERMINAL_STATUSES.has("idle")).toBe(false);
    expect(TERMINAL_STATUSES.has("waiting")).toBe(false);
  });
});
