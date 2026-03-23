export interface MuxSessionInfo {
  name: string;
  createdAt: number;
  dir: string;
  windows: number;
}

export interface MuxProvider {
  readonly name: string;

  listSessions(): MuxSessionInfo[];
  switchSession(name: string, clientTty?: string): void;
  getCurrentSession(): string | null;
  getSessionDir(name: string): string;
  getPaneCount(name: string): number;
  getClientTty(): string;
  setupHooks(serverHost: string, serverPort: number): void;
  cleanupHooks(): void;
}
