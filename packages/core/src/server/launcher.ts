import { existsSync, readFileSync } from "fs";
import { connect } from "net";
import { SERVER_PORT, SERVER_HOST, PID_FILE } from "../shared";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortOpen(host: string, port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

function resolveServerEntryPath(): string {
  const fromMeta = new URL("./start.ts", import.meta.url).pathname;
  if (existsSync(fromMeta)) return fromMeta;
  const fromDist = new URL("../src/server/start.ts", import.meta.url).pathname;
  if (existsSync(fromDist)) return fromDist;
  return fromMeta;
}

export async function ensureServer(): Promise<void> {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(pid) && isProcessAlive(pid) && await isPortOpen(SERVER_HOST, SERVER_PORT)) {
      return;
    }
  }

  const serverPath = resolveServerEntryPath();
  const proc = Bun.spawn(["bun", "run", serverPath], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref();

  for (let i = 0; i < 60; i++) {
    await Bun.sleep(50);
    if (await isPortOpen(SERVER_HOST, SERVER_PORT, 100)) return;
  }

  throw new Error("Server failed to start within 3 seconds");
}
