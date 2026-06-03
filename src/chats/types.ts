export type ChatProvider = "CLAUDE" | "CODEX";

export interface DiscoveredChat {
  provider: ChatProvider;
  title: string | null;
  path: string;
  mtimeMs: number;
  messageCount: number;
  byteSize: number;
}

export interface ChatReader {
  provider: ChatProvider;
  discover(repoDir: string): Promise<DiscoveredChat[]>;
}
