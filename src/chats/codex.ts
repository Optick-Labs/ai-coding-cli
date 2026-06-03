import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ChatReader, DiscoveredChat } from "./types.js";

// Codex stores one "rollout" JSONL per session under ~/.codex/sessions/YYYY/MM/DD/. Unlike Claude,
// the path is keyed by date, not project — the working dir lives inside the file's session_meta, so
// we read each candidate and keep the ones whose cwd matches this repo.
function codexSessionsRoot(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(home, "sessions");
}

// Newest-first scan cap so a deep history doesn't make discovery slow.
const MAX_FILES_SCANNED = 40;
const MAX_MATCHES = 15;

function preambleStart(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("#") ||
    t.startsWith("<INSTRUCTIONS") ||
    t.startsWith("<permissions") ||
    t.startsWith("<user_instructions")
  );
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if ((b.type === "input_text" || b.type === "output_text" || b.type === "text") && b.text) {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

function inspect(raw: string): { cwd: string | null; title: string | null; messageCount: number } {
  let cwd: string | null = null;
  let title: string | null = null;
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
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (obj.type === "session_meta" && payload && typeof payload.cwd === "string") {
      cwd = payload.cwd;
    } else if (obj.type === "response_item" && payload?.type === "message") {
      const role = String(payload.role ?? "");
      if (role === "developer" || role === "system") continue;
      messageCount++;
      if (role === "user" && !title) {
        const text = messageText(payload.content);
        if (text && !preambleStart(text)) {
          title = text.replace(/\s+/g, " ").trim().slice(0, 80);
        }
      }
    }
  }
  return { cwd, title, messageCount };
}

async function listRolloutFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  return entries
    .map((rel) => join(root, rel))
    .filter((p) => basename(p).startsWith("rollout-") && p.endsWith(".jsonl"));
}

export const codexReader: ChatReader = {
  provider: "CODEX",
  async discover(repoDir: string): Promise<DiscoveredChat[]> {
    const root = codexSessionsRoot();
    if (!existsSync(root)) return [];

    const files = await listRolloutFiles(root);
    // Isolate each stat so one bad file (rotated mid-scan, stray symlink, permission edge) drops out
    // instead of rejecting the whole discovery.
    const withStats = (
      await Promise.all(
        files.map(async (path) => {
          try {
            const s = await stat(path);
            return { path, mtimeMs: s.mtimeMs, byteSize: s.size };
          } catch {
            return null;
          }
        }),
      )
    ).filter((f): f is { path: string; mtimeMs: number; byteSize: number } => f !== null);
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const chats: DiscoveredChat[] = [];
    for (const file of withStats.slice(0, MAX_FILES_SCANNED)) {
      if (chats.length >= MAX_MATCHES) break;
      let raw: string;
      try {
        raw = await readFile(file.path, "utf8");
      } catch {
        continue;
      }
      const { cwd, title, messageCount } = inspect(raw);
      // Match the session repo or any subdirectory the candidate may have run Codex in.
      const inRepo = cwd === repoDir || (cwd?.startsWith(`${repoDir}/`) ?? false);
      if (!inRepo || messageCount === 0) continue;
      chats.push({
        provider: "CODEX",
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
