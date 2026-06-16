import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatReader, DiscoveredChat } from "./types.js";

// Cursor doesn't write per-chat files like Claude Code or Codex. Every conversation lives in one big
// SQLite DB (~/Library/Application Support/Cursor/User/globalStorage/state.vscdb on macOS) in a
// key/value table `cursorDiskKV`: a `composerData:<id>` row per chat (title, workspace folder, and the
// ordered list of message ids) plus a `bubbleId:<composerId>:<bubbleId>` row per message. We read the
// rows for chats whose workspace is this repo, flatten them into normalized JSONL, and stash that in a
// temp file so the rest of the capture pipeline (which uploads a file path verbatim) works unchanged.
// The server parses this JSONL deterministically — see parseRawChat.ts (CURSOR branch).

// node:sqlite is still flagged experimental, so Node prints a warning the first time it's imported.
// Load it lazily (Cursor users only) with that one warning muted so the CLI output stays clean.
type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;
let cachedCtor: DatabaseSyncCtor | null = null;
async function loadDatabaseSync(): Promise<DatabaseSyncCtor> {
  if (cachedCtor) return cachedCtor;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /sqlite/i.test(String(warning))) return;
    return (original as (w: unknown, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // Build the specifier at runtime so the bundler can't statically rewrite it. esbuild doesn't yet
    // recognize the newer `node:sqlite` builtin and strips the `node:` prefix, which then fails to
    // resolve as a bare `sqlite` package — keeping it dynamic leaves the import for Node to resolve.
    const specifier = ["node", "sqlite"].join(":");
    const mod = (await import(specifier)) as typeof import("node:sqlite");
    cachedCtor = mod.DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
  return cachedCtor;
}

function cursorGlobalDb(): string {
  if (process.env.HI_CURSOR_DB) return process.env.HI_CURSOR_DB;
  const home = homedir();
  let base: string;
  switch (platform()) {
    case "darwin":
      base = join(home, "Library", "Application Support", "Cursor");
      break;
    case "win32":
      base = join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor");
      break;
    default:
      base = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor");
  }
  return join(base, "User", "globalStorage", "state.vscdb");
}

// Cap the conversations we materialize — a heavy Cursor user accumulates thousands, and the picker only
// ever surfaces the latest handful.
const MAX_MATCHES = 15;
const MAX_TOOL_PREVIEW = 200;

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function compact(value: unknown, limit = MAX_TOOL_PREVIEW): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

// `\`, `%` and `_` are LIKE metacharacters — escape them so a repo path is matched literally.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

interface Turn {
  role: "user" | "assistant" | "tool";
  text: string;
}

interface ConversationHeader {
  bubbleId: string;
  type: number;
}

interface ComposerMeta {
  composerId: string;
  name: string | null;
  workspacePath: string | null;
  createdAt: number;
  headers: ConversationHeader[];
}

function parseComposer(raw: string): ComposerMeta | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const composerId = typeof obj.composerId === "string" ? obj.composerId : null;
  if (!composerId) return null;
  const headersRaw = Array.isArray(obj.fullConversationHeadersOnly) ? obj.fullConversationHeadersOnly : [];
  const headers = headersRaw
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
    .map((h) => ({ bubbleId: String(h.bubbleId ?? ""), type: num(h.type) }))
    .filter((h) => h.bubbleId);
  const workspace = obj.workspaceIdentifier as { uri?: { fsPath?: unknown; path?: unknown } } | undefined;
  const fsPath = workspace?.uri?.fsPath ?? workspace?.uri?.path;
  return {
    composerId,
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null,
    workspacePath: typeof fsPath === "string" ? fsPath : null,
    createdAt: num(obj.createdAt),
    headers,
  };
}

// The composer's workspace is ground truth. Accept an exact match or either side being a parent — a
// candidate may have opened the repo's parent folder, or a subfolder of it, in Cursor.
function workspaceCoversRepo(workspacePath: string, repoDir: string): boolean {
  return (
    workspacePath === repoDir ||
    repoDir.startsWith(`${workspacePath}/`) ||
    workspacePath.startsWith(`${repoDir}/`)
  );
}

function bubbleToTurn(raw: string): Turn | null {
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = typeof b.text === "string" ? b.text.trim() : "";
  // type 1 = the candidate's message, type 2 = the model (prose, or a tool call with empty text).
  if (b.type === 1) return text ? { role: "user", text } : null;
  if (b.type === 2) {
    if (text) return { role: "assistant", text };
    const tool = b.toolFormerData as { name?: unknown; params?: unknown; rawArgs?: unknown } | undefined;
    if (tool?.name) {
      const args = tool.params ?? tool.rawArgs;
      const argText = args ? ` ${compact(args)}` : "";
      return { role: "tool", text: `[tool: ${String(tool.name)}${argText}]` };
    }
  }
  return null;
}

interface DbRow {
  value: string;
}

export const cursorReader: ChatReader = {
  provider: "CURSOR",
  async discover(repoDir: string): Promise<DiscoveredChat[]> {
    const dbPath = cursorGlobalDb();
    if (!existsSync(dbPath)) return [];

    let DatabaseSync: DatabaseSyncCtor;
    try {
      DatabaseSync = await loadDatabaseSync();
    } catch {
      return [];
    }

    // Read-only so we never contend with a running Cursor for the write lock.
    let db: InstanceType<DatabaseSyncCtor>;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return [];
    }

    try {
      // Narrow the 2k+ conversations down with a cheap LIKE on the repo path before parsing JSON. The
      // path lands in each composer's workspaceIdentifier, so a freshly cloned problem dir matches only
      // its own chats. The LIKE is just a filter; workspaceCoversRepo below is the authoritative check.
      const candidates: ComposerMeta[] = [];
      try {
        const rows = db
          .prepare(
            "SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value LIKE ? ESCAPE '\\'",
          )
          .all(`%${escapeLike(repoDir)}%`) as unknown as DbRow[];
        for (const row of rows) {
          const meta = parseComposer(row.value);
          if (!meta || meta.headers.length === 0 || !meta.workspacePath) continue;
          if (workspaceCoversRepo(meta.workspacePath, repoDir)) candidates.push(meta);
        }
      } catch {
        return [];
      }

      candidates.sort((a, b) => b.createdAt - a.createdAt);

      const outDir = join(tmpdir(), "hi-ai-coding-chats");
      await mkdir(outDir, { recursive: true }).catch(() => undefined);

      const bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
      const chats: DiscoveredChat[] = [];
      for (const meta of candidates.slice(0, MAX_MATCHES)) {
        const turns: Turn[] = [];
        let lastActivity = meta.createdAt;
        for (const header of meta.headers) {
          let row: DbRow | undefined;
          try {
            row = bubbleStmt.get(`bubbleId:${meta.composerId}:${header.bubbleId}`) as unknown as
              | DbRow
              | undefined;
          } catch {
            continue;
          }
          if (!row) continue;
          try {
            const parsed = JSON.parse(row.value) as { createdAt?: unknown };
            lastActivity = Math.max(lastActivity, num(parsed.createdAt));
          } catch {
            // fall through — bubbleToTurn re-parses and tolerates the failure
          }
          const turn = bubbleToTurn(row.value);
          if (turn) turns.push(turn);
        }

        const messageCount = turns.filter((t) => t.role !== "tool").length;
        if (messageCount === 0) continue;

        const ndjson = `${turns.map((t) => JSON.stringify(t)).join("\n")}\n`;
        const outPath = join(outDir, `cursor-${meta.composerId}.jsonl`);
        try {
          await writeFile(outPath, ndjson, "utf8");
        } catch {
          continue;
        }
        let byteSize = Buffer.byteLength(ndjson, "utf8");
        try {
          byteSize = (await stat(outPath)).size;
        } catch {
          // keep the computed size
        }

        const firstUser = turns.find((t) => t.role === "user")?.text ?? null;
        const title = meta.name ?? (firstUser ? firstUser.replace(/\s+/g, " ").trim().slice(0, 80) : null);

        chats.push({
          provider: "CURSOR",
          title,
          path: outPath,
          mtimeMs: lastActivity || meta.createdAt,
          messageCount,
          byteSize,
        });
      }
      return chats;
    } finally {
      try {
        db.close();
      } catch {
        // best-effort
      }
    }
  },
};
