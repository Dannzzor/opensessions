import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildLocalLinks, loadPortlessState, parsePortlessRoutes } from "../src/server/portless";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `opensessions-portless-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("portless helpers", () => {
  test("parsePortlessRoutes keeps only valid hostname-to-port mappings", () => {
    expect(parsePortlessRoutes(JSON.stringify([
      { hostname: "editor.localhost", port: 4549, pid: 123 },
      { hostname: "broken.localhost", port: "nope" },
      { port: 4312 },
      null,
    ]))).toEqual([
      { hostname: "editor.localhost", port: 4549 },
    ]);
  });

  test("loadPortlessState reads proxy metadata and routes from disk", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "routes.json"), JSON.stringify([
      { hostname: "editor.localhost", port: 4549, pid: 123 },
      { hostname: "api.localhost", port: 4312, pid: 456 },
    ]));
    writeFileSync(join(dir, "proxy.port"), "1355");

    const state = loadPortlessState([dir]);
    expect(state).not.toBeNull();
    expect(state?.proxyPort).toBe(1355);
    expect(state?.secure).toBe(false);
    expect(state?.routesByPort.get(4549)).toEqual(["editor.localhost"]);
    expect(state?.routesByPort.get(4312)).toEqual(["api.localhost"]);
  });

  test("buildLocalLinks prefers portless hostnames and falls back to localhost", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "routes.json"), JSON.stringify([
      { hostname: "editor.localhost", port: 4549, pid: 123 },
    ]));
    writeFileSync(join(dir, "proxy.port"), "1355");

    const state = loadPortlessState([dir]);
    expect(buildLocalLinks([4549, 9000], state)).toEqual([
      {
        kind: "portless",
        port: 4549,
        url: "http://editor.localhost:1355",
        label: "editor.localhost:1355",
      },
      {
        kind: "direct",
        port: 9000,
        url: "http://localhost:9000",
        label: "localhost:9000",
      },
    ]);
  });
});
