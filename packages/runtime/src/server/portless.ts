import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { LocalLink } from "../shared";

interface PortlessRoute {
  hostname: string;
  port: number;
}

export interface PortlessState {
  proxyPort: number;
  secure: boolean;
  routesByPort: Map<number, string[]>;
}

const DEFAULT_PROXY_PORT = 1355;

function formatUrl(hostname: string, proxyPort: number, secure: boolean): string {
  const protocol = secure ? "https" : "http";
  const defaultPort = secure ? 443 : 80;
  return proxyPort === defaultPort
    ? `${protocol}://${hostname}`
    : `${protocol}://${hostname}:${proxyPort}`;
}

function displayLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

function stateDirs(env = process.env): string[] {
  const dirs = [
    env.PORTLESS_STATE_DIR,
    join(homedir(), ".portless"),
    "/tmp/portless",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return [...new Set(dirs)];
}

export function parsePortlessRoutes(text: string): PortlessRoute[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];

    const hostname = "hostname" in entry ? entry.hostname : undefined;
    const port = "port" in entry ? entry.port : undefined;
    if (typeof hostname !== "string") return [];
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return [];

    return [{ hostname, port }];
  });
}

export function loadPortlessState(dirs = stateDirs()): PortlessState | null {
  for (const dir of dirs) {
    const routesPath = join(dir, "routes.json");
    if (!existsSync(routesPath)) continue;

    const routes = parsePortlessRoutes(readFileSync(routesPath, "utf-8"));
    const proxyPortPath = join(dir, "proxy.port");
    const secure = existsSync(join(dir, "proxy.tls"));
    const proxyPortText = existsSync(proxyPortPath)
      ? readFileSync(proxyPortPath, "utf-8").trim()
      : "";
    const parsedProxyPort = Number.parseInt(proxyPortText, 10);
    const proxyPort = Number.isInteger(parsedProxyPort) && parsedProxyPort > 0
      ? parsedProxyPort
      : DEFAULT_PROXY_PORT;

    const routesByPort = new Map<number, string[]>();
    for (const route of routes) {
      const hostnames = routesByPort.get(route.port) ?? [];
      if (!hostnames.includes(route.hostname)) {
        hostnames.push(route.hostname);
        hostnames.sort((a, b) => a.localeCompare(b));
      }
      routesByPort.set(route.port, hostnames);
    }

    return { proxyPort, secure, routesByPort };
  }

  return null;
}

export function buildLocalLinks(ports: number[], portlessState = loadPortlessState()): LocalLink[] {
  const links: LocalLink[] = [];
  const seen = new Set<string>();

  for (const port of ports) {
    const hostnames = portlessState?.routesByPort.get(port);
    if (hostnames?.length) {
      for (const hostname of hostnames) {
        const url = formatUrl(hostname, portlessState.proxyPort, portlessState.secure);
        if (seen.has(url)) continue;
        seen.add(url);
        links.push({
          kind: "portless",
          port,
          url,
          label: displayLabel(url),
        });
      }
      continue;
    }

    const url = `http://localhost:${port}`;
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({
      kind: "direct",
      port,
      url,
      label: `localhost:${port}`,
    });
  }

  return links;
}
