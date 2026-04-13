/**
 * Cursor CLI agent watcher
 *
 * Watches JSONL transcripts under ~/.cursor/projects/<slug>/agent-transcripts/
 * (or $CURSOR_DATA_DIR/projects/...). The folder `<slug>` is Cursor's slugifyPath(workspace):
 *   /Users/me/proj → Users-me-proj (non-alphanumerics → "-", collapse trim)
 *
 * Session resolution matches mux cwd via the same slug (`resolveSessionForCursorProject`), not only dash-to-slash decoding.
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
  message?: { content?: ContentItem[]; stop_reason?: string | null };
}

interface SessionState {
  status: AgentStatus;
  fileSize: number;
  threadName?: string;
  /** Best-effort path from slug (dash → slash); may not match pane cwd */
  projectDir?: string;
  /** Directory name under .../projects/ — matches Cursor CLI slugifyPath(cwd) */
  projectSlug: string;
  toolUseSeenAt?: number;
  lastGrowthAt?: number;
}

const POLL_MS = 2000;
const STALE_MS = 5 * 60 * 1000;
/** Assistant text-only JSONL lines are usually streaming chunks; treat as done only after file is quiet */
const STREAMING_GRACE_MS = 5000;
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

/** Same algorithm as Cursor CLI `slugifyPath` (see bundled agent). */
export function cursorSlugifyPath(absPath: string): string {
  return absPath
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Decode slug dir name to a heuristic filesystem path (dash → slash). Often matches workspace. */
export function decodeProjectDir(encoded: string): string {
  const decoded = encoded.replace(/-/g, "/");
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

/** Slug folder + decoded path from a transcript file under .../projects/<slug>/agent-transcripts/ */
export function cursorTranscriptProjectInfo(
  filePath: string,
  projectsRoot: string,
): { slug: string; decoded: string } | null {
  const normRoot = projectsRoot.endsWith("/") ? projectsRoot.slice(0, -1) : projectsRoot;
  if (!filePath.startsWith(normRoot)) return null;
  const rel = filePath.slice(normRoot.length + 1);
  const firstSlash = rel.indexOf("/");
  if (firstSlash === -1) return null;
  const slug = rel.slice(0, firstSlash);
  const after = rel.slice(firstSlash + 1);
  if (!after.startsWith("agent-transcripts/")) return null;
  return { slug, decoded: decodeProjectDir(slug) };
}

export function projectDirFromTranscriptPath(filePath: string, projectsRoot: string): string | null {
  return cursorTranscriptProjectInfo(filePath, projectsRoot)?.decoded ?? null;
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
    if (content.some((c) => c.type === "thinking")) return "running";
    if (content.some((c) => c.type === "reasoning")) return "running";
    const stop = line.message?.stop_reason;
    if (stop === "end_turn" || stop === "stop") return "done";
    // Plain text lines are streamed as many JSONL records; fold + mtime decide "done"
    return null;
  }

  return null;
}

function parseLastNonEmptyJsonlLine(lines: string[]): CursorLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw?.trim()) continue;
    try {
      return JSON.parse(raw) as CursorLine;
    } catch {
      continue;
    }
  }
  return null;
}

/** Assistant message with only "soft" content types (no tools / thinking / tool_result). */
function isAssistantTextOnlyStreamChunk(line: CursorLine): boolean {
  if (line.role !== "assistant") return false;
  const content = line.message?.content;
  if (!Array.isArray(content)) return false;
  return !content.some((c) =>
    c.type === "tool_use"
    || c.type === "thinking"
    || c.type === "reasoning"
    || c.type === "tool_result",
  );
}

/**
 * Cursor emits many assistant JSONL lines; the last line is often text-only while the model
 * is still streaming. Use file mtime + optional stop_reason to infer done vs running.
 */
export function resolveCursorFoldStatus(
  foldStatus: AgentStatus,
  lines: string[],
  fileMtimeMs: number,
  now: number,
): AgentStatus {
  let status = foldStatus === "idle" ? "idle" : foldStatus;
  const last = parseLastNonEmptyJsonlLine(lines);
  if (!last || last.role !== "assistant" || !isAssistantTextOnlyStreamChunk(last)) {
    return status;
  }
  const stop = last.message?.stop_reason;
  if (stop === "end_turn" || stop === "stop") return "done";
  if (now - fileMtimeMs < STREAMING_GRACE_MS) return "running";
  return "done";
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

  private resolveCursorSession(state: SessionState): string | null {
    if (!this.ctx) return null;
    if (this.ctx.resolveSessionForCursorProject) {
      return this.ctx.resolveSessionForCursorProject(state.projectDir ?? "", state.projectSlug);
    }
    if (!state.projectDir) return null;
    return this.ctx.resolveSession(state.projectDir);
  }

  private emitStatus(threadId: string, state: SessionState): void {
    if (!this.ctx || !this.seeded) return;
    const session = this.resolveCursorSession(state);
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

    const info = cursorTranscriptProjectInfo(filePath, this.projectsRoot);
    if (!info) return;
    const { decoded: projectDir, slug: projectSlug } = info;

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
    const status = resolveCursorFoldStatus(fold.status, lines, fileStat.mtimeMs, now);

    this.sessions.set(threadId, {
      status,
      fileSize: fileStat.size,
      threadName: fold.threadName,
      projectDir,
      projectSlug,
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
          if (state.status === "idle") continue;
          const session = this.resolveCursorSession(state);
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
