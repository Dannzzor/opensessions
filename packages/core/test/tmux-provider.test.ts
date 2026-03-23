import { describe, test, expect } from "bun:test";
import { TmuxProvider } from "../src/mux/tmux";
import type { MuxProvider, MuxSessionInfo } from "../src/contracts/mux";

describe("TmuxProvider", () => {
  test("implements MuxProvider interface", () => {
    const provider: MuxProvider = new TmuxProvider();
    expect(provider.name).toBe("tmux");
    expect(typeof provider.listSessions).toBe("function");
    expect(typeof provider.switchSession).toBe("function");
    expect(typeof provider.getCurrentSession).toBe("function");
    expect(typeof provider.getSessionDir).toBe("function");
    expect(typeof provider.getPaneCount).toBe("function");
    expect(typeof provider.getClientTty).toBe("function");
    expect(typeof provider.setupHooks).toBe("function");
    expect(typeof provider.cleanupHooks).toBe("function");
  });

  test("listSessions returns MuxSessionInfo array", () => {
    const provider = new TmuxProvider();
    const sessions = provider.listSessions();
    // This is a real tmux call — it returns sessions if tmux is running,
    // or an empty array if not. Either way, it should be an array.
    expect(Array.isArray(sessions)).toBe(true);
    for (const s of sessions) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.createdAt).toBe("number");
      expect(typeof s.dir).toBe("string");
      expect(typeof s.windows).toBe("number");
    }
  });

  test("getCurrentSession returns string or null", () => {
    const provider = new TmuxProvider();
    const session = provider.getCurrentSession();
    // null if no tmux, string if tmux is running
    expect(session === null || typeof session === "string").toBe(true);
  });

  test("getClientTty returns string", () => {
    const provider = new TmuxProvider();
    const tty = provider.getClientTty();
    expect(typeof tty).toBe("string");
  });

  test("getPaneCount returns number >= 0 for any session name", () => {
    const provider = new TmuxProvider();
    // For a nonexistent session, should return 0 or 1
    const count = provider.getPaneCount("nonexistent-session-xyz");
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
