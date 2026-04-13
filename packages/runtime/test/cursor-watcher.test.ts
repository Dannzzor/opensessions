import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  CursorAgentWatcher,
  determineStatus,
  decodeProjectDir,
  projectDirFromTranscriptPath,
  cursorSlugifyPath,
  cursorTranscriptProjectInfo,
  isToolUseLine,
  extractThreadName,
  resolveCursorFoldStatus,
} from "../src/agents/watchers/cursor";
import type { AgentEvent } from "../src/contracts/agent";
import type { AgentWatcherContext } from "../src/contracts/agent-watcher";

describe("Cursor decodeProjectDir", () => {
  test("maps dash segments to absolute path (Cursor omits leading dash)", () => {
    expect(decodeProjectDir("Users-me-myproject")).toBe("/Users/me/myproject");
  });

  test("supports Claude-style leading dash segment", () => {
    expect(decodeProjectDir("-Users-me-myproject")).toBe("/Users/me/myproject");
  });
});

describe("Cursor projectDirFromTranscriptPath", () => {
  test("extracts project dir from agent-transcripts path", () => {
    const root = "/Users/x/.cursor/projects";
    const file = "/Users/x/.cursor/projects/Users-me-repo/agent-transcripts/abc/abc.jsonl";
    expect(projectDirFromTranscriptPath(file, root)).toBe("/Users/me/repo");
  });

  test("returns null when path is not under projects root", () => {
    expect(projectDirFromTranscriptPath("/tmp/foo.jsonl", "/other")).toBeNull();
  });
});

describe("Cursor slugify + transcript info", () => {
  test("cursorSlugifyPath matches CLI algorithm", () => {
    expect(cursorSlugifyPath("/Users/me/myproject")).toBe("Users-me-myproject");
    expect(cursorSlugifyPath("//tmp//foo//")).toBe("tmp-foo");
  });

  test("cursorTranscriptProjectInfo returns slug and decoded", () => {
    const root = "/Users/x/.cursor/projects";
    const file = "/Users/x/.cursor/projects/Users-me-repo/agent-transcripts/abc/abc.jsonl";
    expect(cursorTranscriptProjectInfo(file, root)).toEqual({
      slug: "Users-me-repo",
      decoded: "/Users/me/repo",
    });
  });
});

describe("Cursor determineStatus", () => {
  test("user message → running", () => {
    expect(determineStatus({
      role: "user",
      message: { content: [{ type: "text", text: "hello" }] },
    })).toBe("running");
  });

  test("user interrupt → interrupted", () => {
    expect(determineStatus({
      role: "user",
      message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
    })).toBe("interrupted");
  });

  test("assistant with tool_use → running", () => {
    expect(determineStatus({
      role: "assistant",
      message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Read", input: {} }] },
    })).toBe("running");
  });

  test("assistant text only (streaming chunk) → null", () => {
    expect(determineStatus({
      role: "assistant",
      message: { content: [{ type: "text", text: "partial" }] },
    })).toBe(null);
  });

  test("assistant text only + stop_reason end_turn → done", () => {
    expect(determineStatus({
      role: "assistant",
      message: {
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      },
    })).toBe("done");
  });

  test("assistant thinking → running", () => {
    expect(determineStatus({
      role: "assistant",
      message: { content: [{ type: "thinking", "thinking": "..." }] },
    })).toBe("running");
  });
});

describe("Cursor resolveCursorFoldStatus", () => {
  const lines = [
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "hi" }] },
    }),
    JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: "partial" }] },
    }),
  ];

  test("text-only tail + recent mtime → running", () => {
    const now = 1_000_000;
    expect(resolveCursorFoldStatus("running", lines, now - 1000, now)).toBe("running");
  });

  test("text-only tail + old mtime → done", () => {
    const now = 1_000_000;
    expect(resolveCursorFoldStatus("running", lines, now - 60_000, now)).toBe("done");
  });
});

describe("Cursor isToolUseLine", () => {
  test("detects tool_use in assistant message", () => {
    expect(isToolUseLine({
      role: "assistant",
      message: { content: [{ type: "tool_use", name: "Grep" }] },
    })).toBe(true);
  });

  test("false for text-only assistant", () => {
    expect(isToolUseLine({
      role: "assistant",
      message: { content: [{ type: "text", text: "x" }] },
    })).toBe(false);
  });
});

describe("Cursor extractThreadName", () => {
  test("strips user_query wrapper", () => {
    const name = extractThreadName({
      role: "user",
      message: {
        content: [{ type: "text", text: "<user_query>\nhello world\n</user_query>" }],
      },
    });
    expect(name).toBe("hello world");
  });
});

describe("CursorAgentWatcher", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let encoded: string;
  let transcriptPath: string;
  const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  let events: AgentEvent[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `os-cursor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    projectsRoot = join(tmpDir, "projects");
    encoded = "Users-testuser-testproject";
    mkdirSync(join(projectsRoot, encoded, "agent-transcripts", sessionId), { recursive: true });
    transcriptPath = join(projectsRoot, encoded, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
    events = [];
    delete process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.CURSOR_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  test("emits cursor events for transcript updates", async () => {
    const watcher = new CursorAgentWatcher();

    const ctx: AgentWatcherContext = {
      resolveSession: (dir: string) => (dir === "/Users/testuser/testproject" ? "tmux-1" : null),
      emit: (e: AgentEvent) => events.push(e),
    };

    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\nhi\n</user_query>" }] },
      })}\n`,
    );

    watcher.start(ctx);

    await new Promise((r) => setTimeout(r, 150));

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "thinking" }, { type: "tool_use", name: "Read", input: { path: "/x" } }] },
      })}\n`,
    );

    await new Promise((r) => setTimeout(r, 250));

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "text", text: "final" }],
          stop_reason: "end_turn",
        },
      })}\n`,
    );

    await new Promise((r) => setTimeout(r, 250));

    watcher.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.agent === "cursor")).toBe(true);
    expect(events.some((e) => e.status === "running")).toBe(true);
    expect(events.some((e) => e.status === "done")).toBe(true);
    expect(events.some((e) => e.threadId === sessionId)).toBe(true);
  });

  test("resolves session via slug when resolveSession cannot match cwd", async () => {
    const watcher = new CursorAgentWatcher();

    const ctx: AgentWatcherContext = {
      resolveSession: () => null,
      resolveSessionForCursorProject: (_decoded, slug) =>
        (slug === "Users-testuser-testproject" ? "tmux-slug" : null),
      emit: (e: AgentEvent) => events.push(e),
    };

    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "go" }] },
      })}\n`,
    );

    watcher.start(ctx);
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    expect(events.some((e) => e.session === "tmux-slug" && e.agent === "cursor")).toBe(true);
  });

  test(
    "promotes stuck running to stale",
    async () => {
      const watcher = new CursorAgentWatcher();

      const ctx: AgentWatcherContext = {
        resolveSession: () => "tmux-stale",
        emit: (e: AgentEvent) => events.push(e),
      };

      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "x" }, { type: "tool_use", name: "Read", input: {} }] },
        })}\n`,
      );

      watcher.start(ctx);
      await new Promise((r) => setTimeout(r, 200));

      const seedCount = events.length;

      await new Promise((r) => setTimeout(r, 16_000));

      watcher.stop();

      const staleEvents = events.slice(seedCount).filter((e) => e.status === "stale");
      expect(staleEvents.length).toBeGreaterThanOrEqual(1);
    },
    { timeout: 20_000 },
  );
});
