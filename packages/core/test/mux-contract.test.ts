import { describe, test, expect } from "bun:test";
import type { MuxProvider, MuxSessionInfo } from "../src/contracts/mux";

describe("Mux Contract", () => {
  test("MuxSessionInfo has required fields", () => {
    const info: MuxSessionInfo = {
      name: "my-session",
      createdAt: 1700000000,
      dir: "/home/user/project",
      windows: 2,
    };

    expect(info.name).toBe("my-session");
    expect(info.createdAt).toBe(1700000000);
    expect(info.dir).toBe("/home/user/project");
    expect(info.windows).toBe(2);
  });

  test("MuxProvider interface has all required methods", () => {
    // Create a mock that satisfies the interface
    const mock: MuxProvider = {
      name: "test-mux",
      listSessions: () => [],
      switchSession: (_name: string, _clientTty?: string) => {},
      getCurrentSession: () => null,
      getSessionDir: (_name: string) => "",
      getPaneCount: (_name: string) => 1,
      getClientTty: () => "",
      setupHooks: (_serverHost: string, _serverPort: number) => {},
      cleanupHooks: () => {},
    };

    expect(mock.name).toBe("test-mux");
    expect(mock.listSessions()).toEqual([]);
    expect(mock.getCurrentSession()).toBeNull();
    expect(mock.getPaneCount("test")).toBe(1);
    expect(mock.getClientTty()).toBe("");
  });
});
