import { claudeReader } from "./claude.js";
import { codexReader } from "./codex.js";
import { cursorReader } from "./cursor.js";
import type { ChatReader, DiscoveredChat } from "./types.js";

export type { ChatProvider, DiscoveredChat } from "./types.js";

const READERS: ChatReader[] = [claudeReader, codexReader, cursorReader];

// Discover AI chats from every supported tool for this repo, newest first. A reader that throws
// (missing dir, permission error) contributes nothing rather than failing the whole discovery.
export async function discoverChats(repoDir: string): Promise<DiscoveredChat[]> {
  const results = await Promise.all(
    READERS.map((reader) => reader.discover(repoDir).catch(() => [] as DiscoveredChat[])),
  );
  return results.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
}
