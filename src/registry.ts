import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir, sessionFileExists, type Lang } from "./session.js";

// A per-user index of active session LOCATIONS, so a command run from the wrong directory can point
// the candidate at the folder their session actually lives in. It holds ONLY non-secret locators —
// never a token. The token stays in the 0600 credentials file keyed by repo path (see session.ts);
// callers that need it recover it from there, not from here.
export interface RegistryEntry {
  repoDir: string;
  task: string;
  lang: Lang;
  startedAt: string;
  deadline: string;
}

function registryPath(): string {
  return join(configDir(), "sessions.json");
}

function isEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.repoDir === "string" &&
    typeof e.task === "string" &&
    typeof e.lang === "string" &&
    typeof e.startedAt === "string" &&
    typeof e.deadline === "string"
  );
}

// Tolerant read: a missing or corrupt registry is treated as empty, never fatal — it's a recovery
// aid, not load-bearing state.
async function readRaw(): Promise<RegistryEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

// Atomic write: a unique temp file in the same dir, then rename, so a concurrent reader never sees a
// half-written file. Last-writer-wins across parallel `start`s is fine for advisory data — no locking.
async function writeRaw(entries: RegistryEntry[]): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `sessions.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(entries, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tmp, registryPath());
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

// All registry mutations are best-effort: the registry never blocks or breaks a real command.
export async function addSession(entry: RegistryEntry): Promise<void> {
  try {
    const entries = (await readRaw()).filter((e) => e.repoDir !== entry.repoDir);
    entries.push(entry);
    await writeRaw(entries);
  } catch {
    // ignored — recovery aid only
  }
}

export async function removeSession(repoDir: string): Promise<void> {
  try {
    const entries = await readRaw();
    const kept = entries.filter((e) => e.repoDir !== repoDir);
    if (kept.length !== entries.length) await writeRaw(kept);
  } catch {
    // ignored — recovery aid only
  }
}

// Returns the live entries, pruning on read any whose folder (or `.hi/session.json`) is gone. Best
// effort persists the pruned set back; a write failure just means we re-prune next time.
export async function listSessions(): Promise<RegistryEntry[]> {
  const entries = await readRaw();
  const live = entries.filter((e) => existsSync(e.repoDir) && sessionFileExists(e.repoDir));
  if (live.length !== entries.length) {
    try {
      await writeRaw(live);
    } catch {
      // ignored
    }
  }
  return live;
}
