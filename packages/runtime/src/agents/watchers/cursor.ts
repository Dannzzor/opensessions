/**
 * Cursor CLI agent watcher
 *
 * Watches JSONL transcripts under ~/.cursor/projects/<encoded-path>/agent-transcripts/
 * (or $CURSOR_DATA_DIR/projects/...). Paths use the same dash encoding as Claude Code:
 *   /Users/me/proj → Users-me-proj
 *
 * Each line is one message object:
 *   { "role": "user" | "assistant", "message": { "content": [ { "type": "text" | "tool_use" | ... } ] } }
 *
 * The last line determines status: user → running; assistant with tool_use → running;
 * assistant with only text/reasoning (no tools) → done.
 *
 * Uses recursive fs.watch on ~/.cursor/projects plus a 2s poll (like Codex) to catch
 * missed writes and new files.
 *
 * ## Cursor JSONL lifecycle (observed CLI, 2026)
 *
 * - Transcripts may be flat: agent-transcripts/<uuid>.jsonl
 * - Or nested: agent-transcripts/<uuid>/<uuid>.jsonl
 * - Multiple assistant lines append per turn (reasoning, tools, final text).
 */

import { watch, type FSWatcher } from "fs";
import { readdir, stat } from "fs/promises";
import { basename, join } from "path";
import { homedir } from "os";
import type { AgentStatus } from "../../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";

// --- Types ---

interface ContentItem {
  type?: string;
  text?: string;
}

interface CursorLine {
  role?: string;
  message?: { content?: ContentItem[] };
}

interface SessionState {
  status: AgentStatus;
  fileSize: number;
  threadName?: string;
  projectDir?: string;
  toolUseSeenAt?: number;
  lastGrowthAt?: number;
}

const POLL_MS = 2000;
const STALE_MS = 5 * 60 * 1000;
const TOOL_USE_WAIT_MS = 3000;
const STUCK_RUNNING_MS = 15_000;
const THREAD_NAME_MAX = 80;

const INTERRUPT_PATTERNS = [
  "[Request interrupted by user",
  "[Request interrupted",
];

// --- Path helpers ---

function cursorDataRoot(): string {
  return process.env.CURSOR_DATA_DIR ?? join(homedir(), ".cursor");
}

/** Decode Cursor/Claude-style encoded project dir name back to a filesystem path */
export function decodeProjectDir(encoded: string): string {
  const decoded = encoded.replace(/-/g, "/");
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

export function projectDirFromTranscriptPath(filePath: string, projectsRoot: string): string | null {
  const normRoot = projectsRoot.endsWith("/") ? projectsRoot.slice(0, -1) : projectsRoot;
  if (!filePath.startsWith(normRoot)) return null;
  const rel = filePath.slice(normRoot.length + 1);
  const firstSlash = rel.indexOf("/");
  if (firstSlash === -1) return null;
  const encoded = rel.slice(0, firstSlash);
  const after = rel.slice(firstSlash + 1);
  if (!after.startsWith("agent-transcripts/")) return null;
  return decodeProjectDir(encoded);
}

function parseThreadId(filePath: string): string {
  const name = basename(filePath, ".jsonl");
  return name.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)?.[0] ?? name;
}

// --- Status ---

export function isToolUseLine(line: CursorLine): boolean {
  if (line.role !== "assistant") return false;
  const content = line.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((c) => c.type === "tool_use");
}

/**
 * Status implied by one JSONL line, or null if we should keep the previous status.
 */
export function determineStatus(line: CursorLine): AgentStatus | null {
  if (line.role === "user") {
    const text = extractUserPlainText(line);
    if (text && INTERRUPT_PATTERNS.some((p) => text.startsWith(p))) return "interrupted";
    return "running";
  }

  if (line.role === "assistant") {
    const content = line.message?.content;
    if (!Array.isArray(content)) return "running";
    if (content.some((c) => c.type === "tool_use")) return "running";
    return "done";
  }

  return null;
}

function extractUserPlainText(line: CursorLine): string | undefined {
  const content = line.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((c) => c.type === "text")?.text;
  return typeof text === "string" ? text : undefined;
}

export function extractThreadName(line: CursorLine): string | undefined {
  if (line.role !== "user") return undefined;
  let text = extractUserPlainText(line);
  if (!text) return undefined;
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m?.[1]) text = m[1].trim();
  const firstLine = text.split("\n").map((p) => p.trim()).find(Boolean);
  if (!firstLine) return undefined;
  if (firstLine.startsWith("<") || firstLine.startsWith("{")) return undefined;
  return firstLine.slice(0, THREAD_NAME_MAX);
}

function foldLinesIntoStatus(lines: string[]): { status: AgentStatus; lastToolUse: boolean; threadName?: string } {
  let status: AgentStatus = "idle";
  let lastToolUse = false;
  let threadName: string | undefined;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let line: CursorLine;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!threadName) {
      const name = extractThreadName(line);
      if (name) threadName = name;
    }

    const s = determineStatus(line);
    if (s !== null) status = s;
    lastToolUse = isToolUseLine(line);
  }

  return { status, lastToolUse, threadName };
}

async function collectTranscriptFiles(agentTranscriptsRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(agentTranscriptsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(agentTranscriptsRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTranscriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function collectAllTranscripts(projectsRoot: string): Promise<string[]> {
  let projectEncodings: string[];
  try {
    projectEncodings = await readdir(projectsRoot);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const enc of projectEncodings) {
    const at = join(projectsRoot, enc, "agent-transcripts");
    out.push(...await collectTranscriptFiles(at));
  }
  return out;
}

// --- Watcher ---

export class CursorAgentWatcher implements AgentWatcher {
  readonly name = "cursor";

  private sessions = new Map<string, SessionState>();
  private fsWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ctx: AgentWatcherContext | null = null;
  private projectsRoot: string;
  private scanning = false;
  private seeded = false;

  constructor() {
    this.projectsRoot = join(cursorDataRoot(), "projects");
  }

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    this.setupWatch();
    setTimeout(() => this.scan(), 50);
    this.pollTimer = setInterval(() => this.scan(), POLL_MS);
  }

  stop(): void {
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch {}
      this.fsWatcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx = null;
  }

  private emitStatus(threadId: string, state: SessionState): void {
    if (!this.ctx || !this.seeded || !state.projectDir) return;
    const session = this.ctx.resolveSession(state.projectDir);
    if (!session) return;
    this.ctx.emit({
      agent: "cursor",
      session,
      status: state.status,
      ts: Date.now(),
      threadId,
      ...(state.threadName && { threadName: state.threadName }),
    });
  }

  private async processFile(filePath: string): Promise<void> {
    if (!this.ctx) return;

    const projectDir = projectDirFromTranscriptPath(filePath, this.projectsRoot);
    if (!projectDir) return;

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return;
    }

    const threadId = parseThreadId(filePath);
    const prev = this.sessions.get(threadId);

    if (prev && fileStat.size === prev.fileSize) {
      const now = Date.now();

      if (prev.status === "running" && prev.toolUseSeenAt && now - prev.toolUseSeenAt >= TOOL_USE_WAIT_MS) {
        prev.status = "waiting";
        prev.toolUseSeenAt = undefined;
        this.emitStatus(threadId, prev);
      }

      if (
        (prev.status === "running" || prev.status === "waiting")
        && prev.lastGrowthAt
        && now - prev.lastGrowthAt >= STUCK_RUNNING_MS
      ) {
        prev.status = "stale";
        prev.toolUseSeenAt = undefined;
        prev.lastGrowthAt = undefined;
        this.emitStatus(threadId, prev);
      }

      return;
    }

    const now = Date.now();
    let text: string;
    try {
      text = await Bun.file(filePath).text();
    } catch {
      return;
    }

    const lines = text.split("\n").filter(Boolean);
    const fold = foldLinesIntoStatus(lines);
    const status = fold.status === "idle" ? "idle" : fold.status;

    this.sessions.set(threadId, {
      status,
      fileSize: fileStat.size,
      threadName: fold.threadName,
      projectDir,
      toolUseSeenAt: fold.lastToolUse && status === "running" ? now : undefined,
      lastGrowthAt: (status === "running" || status === "waiting") ? now : undefined,
    });

    if (!this.seeded) return;

    const next = this.sessions.get(threadId)!;
    const prevStatus = prev?.status;
    if (next.status === prevStatus) return;
    if (!prev && next.status === "idle") return;

    this.emitStatus(threadId, next);
  }

  private async scan(): Promise<void> {
    if (this.scanning || !this.ctx) return;
    this.scanning = true;

    try {
      const files = await collectAllTranscripts(this.projectsRoot);
      const now = Date.now();

      for (const filePath of files) {
        let fileStat;
        try {
          fileStat = await stat(filePath);
        } catch {
          continue;
        }
        if (now - fileStat.mtimeMs > STALE_MS) continue;
        await this.processFile(filePath);
      }
    } finally {
      if (!this.seeded) {
        this.seeded = true;
        for (const [threadId, state] of this.sessions) {
          if (state.status === "idle" || !state.projectDir) continue;
          const session = this.ctx?.resolveSession(state.projectDir);
          if (!session) continue;
          this.ctx?.emit({
            agent: "cursor",
            session,
            status: state.status,
            ts: Date.now(),
            threadId,
            ...(state.threadName && { threadName: state.threadName }),
          });
        }
      }
      this.scanning = false;
    }
  }

  private setupWatch(): void {
    try {
      this.fsWatcher = watch(this.projectsRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename?.endsWith(".jsonl") || !filename.includes("agent-transcripts")) return;
        this.processFile(join(this.projectsRoot, filename));
      });
    } catch {
    }
  }
}
