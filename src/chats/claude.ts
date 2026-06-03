import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatReader, DiscoveredChat } from "./types.js";

// Claude Code stores one JSONL per session under a per-project folder whose name is the project's
// absolute path with every non-alphanumeric char replaced by "-". e.g.
// /Users/me/dev/ai-interview -> -Users-me-dev-ai-interview
function projectDirName(repoDir: string): string {
  return repoDir.replace(/[^A-Za-z0-9]/g, "-");
}

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

// Only scan the most recent files — a long-lived project can accumulate hundreds of sessions and
// we only ever surface the latest handful in the picker.
const MAX_FILES_SCANNED = 15;

function firstUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      return String((block as { text?: string }).text ?? "");
    }
  }
  return "";
}

function isPreamble(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<local-command-caveat>") || t.startsWith("<command-name>");
}

function inspect(raw: string): { title: string | null; messageCount: number } {
  let title: string | null = null;
  let firstUser: string | null = null;
  let messageCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "ai-title" && !title) {
      title = String((obj as { aiTitle?: string }).aiTitle ?? "") || null;
    }
    if (obj.type === "user" || obj.type === "assistant") {
      messageCount++;
      if (obj.type === "user" && firstUser === null) {
        const text = firstUserText((obj.message as { content?: unknown })?.content);
        if (text && !isPreamble(text)) firstUser = text;
      }
    }
  }
  if (!title && firstUser) {
    title = firstUser.replace(/\s+/g, " ").trim().slice(0, 80);
  }
  return { title, messageCount };
}

export const claudeReader: ChatReader = {
  provider: "CLAUDE",
  async discover(repoDir: string): Promise<DiscoveredChat[]> {
    const projectsRoot = join(claudeRoot(), "projects");
    if (!existsSync(projectsRoot)) return [];

    // The candidate may have run Claude Code in the session repo or any subdirectory of it. Folder
    // names are the cwd with non-alphanumerics replaced by "-", so a subdir shares the repo's prefix.
    const repoPrefix = projectDirName(repoDir);
    const projectDirs = (await readdir(projectsRoot)).filter(
      (name) => name === repoPrefix || name.startsWith(`${repoPrefix}-`),
    );

    const files = (
      await Promise.all(
        projectDirs.map(async (name) => {
          const dir = join(projectsRoot, name);
          const jsonl = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
          return jsonl.map((f) => join(dir, f));
        }),
      )
    ).flat();

    const withStats = await Promise.all(
      files.map(async (path) => {
        const s = await stat(path);
        return { path, mtimeMs: s.mtimeMs, byteSize: s.size };
      }),
    );
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const chats: DiscoveredChat[] = [];
    for (const file of withStats.slice(0, MAX_FILES_SCANNED)) {
      const raw = await readFile(file.path, "utf8");
      const { title, messageCount } = inspect(raw);
      if (messageCount === 0) continue;
      chats.push({
        provider: "CLAUDE",
        title,
        path: file.path,
        mtimeMs: file.mtimeMs,
        messageCount,
        byteSize: file.byteSize,
      });
    }
    return chats;
  },
};
