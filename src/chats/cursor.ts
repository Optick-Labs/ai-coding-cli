import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import chalk from "chalk";
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

// node:sqlite imports without a CLI flag only on Node 22.13.0+ (earlier 22.x throws unless launched
// with --experimental-sqlite, which npx doesn't pass). When a Cursor DB is present but the import
// fails, the candidate has Cursor history we simply can't read — tell them why instead of silently
// claiming "no chats found". Printed at most once, and only to an interactive terminal.
let warnedUnavailable = false;
function warnCursorUnavailable(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  if (!process.stdout.isTTY) return;
  console.log(
    chalk.dim(
      "Found Cursor history, but reading it needs Node 22.13 or newer (you're on an older Node). Upgrade Node, or paste your chat from the session page.",
    ),
  );
}

// Unlike the Claude/Codex readers (which hand the uploader the real on-disk log), Cursor has no per-chat
// file, so we materialize each conversation into a temp file. That file holds the candidate's verbatim
// chat content, so it goes in a private per-run dir (`mkdtemp` is 0700) instead of a predictable shared
// path, and the whole dir is removed when the process exits — chat content shouldn't linger in /tmp.
let cachedOutDir: string | null = null;
async function ensureOutDir(): Promise<string> {
  if (cachedOutDir) return cachedOutDir;
  const dir = await mkdtemp(join(tmpdir(), "hi-ai-coding-chats-"));
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — a leftover temp dir is harmless, and exit handlers can't do much else
    }
  });
  cachedOutDir = dir;
  return dir;
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

// The temp filename embeds the composerId, which comes from the DB. Real Cursor ids are UUID-ish and
// safe, but a corrupt value carrying path separators must never let us write outside the temp dir, so
// strip it down to a conservative token.
function safeFileToken(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned || "chat";
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
  workspacePaths: string[];
  createdAt: number;
  headers: ConversationHeader[];
}

// Which project a chat belongs to has moved around across Cursor versions. Older builds stored it in
// `workspaceIdentifier.uri`; newer ones drop that field entirely and instead record the git root in
// `trackedGitRepos[].repoPath` and the `file://` URIs of edited files in `originalFileStates`. Gather
// every path signal available — the match check only needs one of them to land at or inside the repo.
function collectWorkspacePaths(obj: Record<string, unknown>): string[] {
  const paths: string[] = [];

  const ws = obj.workspaceIdentifier as { uri?: { fsPath?: unknown; path?: unknown } } | undefined;
  const wsPath = ws?.uri?.fsPath ?? ws?.uri?.path;
  if (typeof wsPath === "string" && wsPath) paths.push(wsPath);

  const repos = Array.isArray(obj.trackedGitRepos) ? obj.trackedGitRepos : [];
  for (const repo of repos) {
    const repoPath = repo && typeof repo === "object" ? (repo as { repoPath?: unknown }).repoPath : undefined;
    if (typeof repoPath === "string" && repoPath) paths.push(repoPath);
  }

  const fileStates = obj.originalFileStates;
  if (fileStates && typeof fileStates === "object") {
    for (const uri of Object.keys(fileStates)) {
      if (uri) paths.push(uri);
    }
  }

  return paths;
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
  return {
    composerId,
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null,
    workspacePaths: collectWorkspacePaths(obj),
    createdAt: num(obj.createdAt),
    headers,
  };
}

// Cursor records the workspace either as an OS path (`fsPath`, e.g. `C:\Users\me\repo` on Windows) or
// a URI path (`uri.path`, e.g. `/c:/Users/me/repo`, possibly percent-encoded). Bring both — and our
// own repoDir — to one comparable shape so matching survives those format differences: drop a leading
// `file://`, percent-decode, unify separators to `/`, strip the slash a URI puts before a drive
// letter, drop a trailing slash, and lowercase on Windows (its filesystem is case-insensitive and
// drive-letter casing varies). On POSIX we keep case, since the filesystem is case-sensitive.
function normalizeForCompare(input: string): string {
  let s = input.trim();
  if (!s) return "";
  s = s.replace(/^file:\/\//, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    // not valid percent-encoding — compare it as-is
  }
  s = s.replace(/\\/g, "/").replace(/^\/([A-Za-z]:)/, "$1").replace(/\/+$/, "");
  return platform() === "win32" ? s.toLowerCase() : s;
}

// The conversation's own path signals are ground truth. It belongs to this repo when any signal — the
// opened workspace, a tracked git root, or an edited file — lands AT the repo or INSIDE it. This
// mirrors the sibling readers' convention (claude.ts / codex.ts): repo-or-below, never a parent, so
// opening `~/dev` (or merely mentioning the repo name) doesn't sweep in unrelated conversations.
function coversRepo(workspacePaths: string[], repoDir: string): boolean {
  const repo = normalizeForCompare(repoDir);
  if (!repo) return false;
  return workspacePaths.some((p) => {
    const c = normalizeForCompare(p);
    return !!c && (c === repo || c.startsWith(`${repo}/`));
  });
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
      warnCursorUnavailable();
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
      // Narrow the 2k+ conversations down with a cheap LIKE before parsing JSON. We filter on the repo
      // folder's *basename*, not the full path: a single path segment has no separators, so it matches
      // regardless of how Cursor stored the path (Windows `\`, which is doubled inside the stored JSON,
      // or a `/c:/…` URI path) and which field carries it. The LIKE is only a coarse filter; coversRepo
      // below does the authoritative, separator-aware match against the conversation's real paths.
      const candidates: ComposerMeta[] = [];
      try {
        const rows = db
          .prepare(
            "SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value LIKE ? ESCAPE '\\'",
          )
          .all(`%${escapeLike(basename(repoDir))}%`) as unknown as DbRow[];
        for (const row of rows) {
          const meta = parseComposer(row.value);
          if (!meta || meta.headers.length === 0 || meta.workspacePaths.length === 0) continue;
          if (coversRepo(meta.workspacePaths, repoDir)) candidates.push(meta);
        }
      } catch {
        return [];
      }

      candidates.sort((a, b) => b.createdAt - a.createdAt);

      const outDir = await ensureOutDir();

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
        const outPath = join(outDir, `cursor-${safeFileToken(meta.composerId)}.jsonl`);
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
