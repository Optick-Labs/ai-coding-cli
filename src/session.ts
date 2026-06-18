import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { createHash } from "node:crypto";

import { listSessions, type RegistryEntry } from "./registry.js";

export const LANGS = ["python", "java", "typescript", "go", "csharp", "any"] as const;
export type Lang = (typeof LANGS)[number];

export interface Session {
  task: string;
  lang: Lang;
  startedAt: string;
  deadlineMinutes: number;
  deadline: string;
  baselineSha: string;
  submittedAt?: string;
  token?: string;
  apiBaseUrl?: string;
}

export interface FoundSession {
  session: Session;
  hiDir: string;
  repoDir: string;
}

const SESSION_FILE = "session.json";

// O_NOFOLLOW where the platform supports it (0 elsewhere, e.g. Windows) so opening a file we own
// fails instead of following a symlink. Stops a seed repo that ships `.hi/session.json` as a symlink
// from redirecting our write outside the repo.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Auth material (bearer token + the API base it's valid for) is the secret part of a session.
type Credentials = Pick<Session, "token" | "apiBaseUrl">;

// Owner-only, never written through a symlink. The open mode applies on creation; the explicit chmod
// covers an overwrite of a pre-existing, looser-permissioned file. chmod is best-effort (a no-op on
// filesystems that don't support it).
async function writeProtectedFile(path: string, data: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.chmod(0o600).catch(() => undefined);
  } finally {
    await handle.close();
  }
}

// Everything in the session except the secret auth fields — this is what's safe to persist inside the
// cloned exercise repo (which contains server-provided code the candidate runs).
function withoutSecrets(session: Session): Omit<Session, "token" | "apiBaseUrl"> {
  const { token: _token, apiBaseUrl: _apiBaseUrl, ...rest } = session;
  return rest;
}

// The token is deliberately kept OUT of the cloned repo. That repo holds server-provided code the
// candidate runs (`test`/`dev`/build scripts, dependencies), so a token sitting in `.hi/session.json`
// could be read and exfiltrated by any of it. Instead it lives under the user's own config dir, 0600,
// in a file keyed by a hash of the repo path.
// The per-user config dir for this tool. Home of the credentials store and the session registry.
// Respects XDG_CONFIG_HOME, falls back to ~/.config.
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "hellointerview-ai-coding");
}

function credentialsDir(): string {
  return join(configDir(), "credentials");
}

function credentialsPathFor(repoDir: string): string {
  const key = createHash("sha256").update(resolve(repoDir)).digest("hex").slice(0, 32);
  return join(credentialsDir(), `${key}.json`);
}

async function writeCredentials(repoDir: string, creds: Credentials): Promise<void> {
  await mkdir(credentialsDir(), { recursive: true });
  await writeProtectedFile(credentialsPathFor(repoDir), JSON.stringify(creds, null, 2) + "\n");
}

// Recover the out-of-repo credentials for a repo path. Exported so the command layer can attach a
// token to a best-effort "wrong directory" telemetry event after discovery — the only place a token
// leaves the 0600 store, and it stays in-memory (never copied to the registry or any new file).
export async function readCredentials(repoDir: string): Promise<Credentials | undefined> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPathFor(repoDir), "utf8")) as Partial<Credentials>;
    if (parsed.token && parsed.apiBaseUrl) return { token: parsed.token, apiBaseUrl: parsed.apiBaseUrl };
  } catch {
    // No stored credentials (offline session, moved repo, or a legacy session created before tokens
    // moved out of the repo). Callers fall back to whatever the repo file carries.
  }
  return undefined;
}

// Create `.hi` for the session, refusing to write through a symlinked `.hi` planted by a seed repo
// (which O_NOFOLLOW on the file alone wouldn't catch, since it only guards the final path component).
async function ensureHiDir(repoDir: string): Promise<string> {
  const hiDir = hiDirFor(repoDir);
  const existing = await lstat(hiDir).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to use .hi: it is a symlink (${hiDir}).`);
  }
  await mkdir(hiDir, { recursive: true });
  return hiDir;
}

function hiDirFor(repoDir: string): string {
  return join(repoDir, ".hi");
}

function sessionPathFor(repoDir: string): string {
  return join(hiDirFor(repoDir), SESSION_FILE);
}

// Cheap existence check used by the registry's read-time pruning (a folder can be deleted out from
// under a stale registry entry).
export function sessionFileExists(repoDir: string): boolean {
  return existsSync(sessionPathFor(repoDir));
}

export async function writeSession(repoDir: string, session: Session): Promise<string> {
  await ensureHiDir(repoDir);
  const path = sessionPathFor(repoDir);
  await writeProtectedFile(path, JSON.stringify(withoutSecrets(session), null, 2) + "\n");
  if (session.token && session.apiBaseUrl) {
    await writeCredentials(repoDir, { token: session.token, apiBaseUrl: session.apiBaseUrl });
  }
  return path;
}

export function recorderPidPath(hiDir: string): string {
  return join(hiDir, "recorder.pid");
}

export function timelineLogPath(hiDir: string): string {
  return join(hiDir, "timeline.jsonl");
}

export function recorderLogPath(hiDir: string): string {
  return join(hiDir, "recorder.log");
}

// A discovered session location. Non-secret locators ONLY — never a token, never a full Session.
export interface SessionCandidate {
  repoDir: string;
  task: string;
  lang: string;
  startedAt?: string;
  deadline?: string;
}

// Thrown when no session folder contains cwd. Carries discovered candidates so the command layer can
// print an exact `cd … && <command>` hint, and `telemetryTarget` — the one candidate we can
// unambiguously attribute a "wrong directory" event to (a unique downward-scan hit, or a single
// known session). Undefined when attribution would be a guess.
export class SessionNotFoundError extends Error {
  constructor(
    message: string,
    readonly candidates: SessionCandidate[],
    readonly telemetryTarget?: SessionCandidate,
  ) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

const SCAN_MAX_DEPTH = 2;
const SCAN_MAX_DIRS = 200;
const SCAN_MAX_HITS = 10;
const SKIP_DIRS = new Set(["node_modules", ".git", ".hi"]);

// Read a candidate's session.json WITHOUT following symlinks: a sibling folder we scan into is
// untrusted, so a symlinked `.hi` or `session.json` must not redirect the read outside the tree
// (mirrors the O_NOFOLLOW stance the write path takes). lstat reports the link itself, so a symlinked
// `.hi`/file fails the isDirectory()/isFile() check and is skipped. repoDir is the real scanned path
// (never a link target), so it's safe to surface in the hint.
async function readCandidate(repoDir: string): Promise<SessionCandidate | undefined> {
  try {
    const hiStat = await lstat(hiDirFor(repoDir)).catch(() => null);
    if (!hiStat || !hiStat.isDirectory()) return undefined;
    const filePath = sessionPathFor(repoDir);
    const fileStat = await lstat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) return undefined;
    const s = JSON.parse(await readFile(filePath, "utf8")) as Partial<Session>;
    if (typeof s.task !== "string" || typeof s.lang !== "string") return undefined;
    return { repoDir, task: s.task, lang: s.lang, startedAt: s.startedAt, deadline: s.deadline };
  } catch {
    return undefined;
  }
}

// Bounded downward scan from startDir for `*/.hi/session.json`. Depth-, dir-, and hit-capped; skips
// node_modules/.git/dotdirs and never follows symlinks (no traversal escape, no symlink loops). Pure
// best-effort: any error yields fewer hits, never a throw.
async function scanDown(startDir: string): Promise<SessionCandidate[]> {
  const hits: SessionCandidate[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > SCAN_MAX_DEPTH || visited >= SCAN_MAX_DIRS || hits.length >= SCAN_MAX_HITS) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= SCAN_MAX_HITS || visited >= SCAN_MAX_DIRS) return;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      visited += 1;
      const candidate = await readCandidate(child);
      if (candidate) hits.push(candidate);
      await walk(child, depth + 1);
    }
  }

  await walk(startDir, 1);
  return hits;
}

function entryToCandidate(entry: RegistryEntry): SessionCandidate {
  return { repoDir: entry.repoDir, task: entry.task, lang: entry.lang, startedAt: entry.startedAt, deadline: entry.deadline };
}

// Strip control characters (incl. ESC) from anything we echo to the terminal. The scanned session
// files and registry are local but untrusted, and a path/field can carry newlines or ANSI escapes
// that would spoof or corrupt the printed hint.
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, "");
}

// Shell-literal quoting, per shell, so a path with spaces (or `$`/backtick) pastes correctly.
// POSIX + PowerShell single-quote (fully literal); cmd double-quotes (paths can't contain `"`).
function squotePosix(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
function squotePwsh(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

// Platform-correct, copy-pasteable `cd` line(s). On Windows we can't know whether the user is in cmd
// or PowerShell, so give both as real commands (cmd needs `/d` to change drive; PowerShell needs
// -LiteralPath with single quotes so `$`/backtick aren't interpreted).
function cdLines(repoDir: string): string[] {
  const path = sanitize(repoDir);
  if (platform() === "win32") {
    return [`  cmd:        cd /d "${path}"`, `  PowerShell: Set-Location -LiteralPath ${squotePwsh(path)}`];
  }
  return [`  cd ${squotePosix(path)}`];
}

function startedLabel(candidate: SessionCandidate): string {
  const base = `${sanitize(candidate.task)} / ${sanitize(candidate.lang)}`;
  if (!candidate.startedAt) return base;
  const when = new Date(candidate.startedAt);
  if (Number.isNaN(when.getTime())) return base;
  return `${base}, started ${when.toLocaleString()}`;
}

const GENERIC_NOT_FOUND =
  "No Hello Interview session found. Run this command from inside a session folder " +
  "(one created by `npx @hellointerview/ai-coding start`).";

function formatNotFound(candidates: SessionCandidate[], command: string): string {
  if (candidates.length === 0) return GENERIC_NOT_FOUND;

  const run = `npx @hellointerview/ai-coding ${command}`;
  const lead =
    candidates.length === 1 ? "No session in this folder. Found yours here:" : "No session in this folder. Found these:";
  const blocks = candidates.map((c) => [...cdLines(c.repoDir), `  ${run}`, `  (${startedLabel(c)})`].join("\n"));
  return `${lead}\n\n${blocks.join("\n\n")}`;
}

// Discover candidate session folders when cwd isn't inside one: a bounded downward scan (catches "I'm
// one dir up", and legacy sessions predating the registry) merged with the registry (catches "I'm
// nowhere near the repo"). Deduped by repoDir, scan hits first so most-relevant lead the list.
async function discover(startDir: string): Promise<{ candidates: SessionCandidate[]; telemetryTarget?: SessionCandidate }> {
  const scanned = await scanDown(startDir).catch(() => [] as SessionCandidate[]);
  const registered = (await listSessions().catch(() => [] as RegistryEntry[])).map(entryToCandidate);

  const byDir = new Map<string, SessionCandidate>();
  for (const c of [...scanned, ...registered]) {
    if (!byDir.has(c.repoDir)) byDir.set(c.repoDir, c);
  }
  const candidates = [...byDir.values()];

  // Attribute telemetry only when it's unambiguous: a single downward-scan hit (the folder is right
  // here), or exactly one known candidate overall. Otherwise picking one would be a guess — skip it.
  const telemetryTarget =
    scanned.length === 1 ? scanned[0] : candidates.length === 1 ? candidates[0] : undefined;

  return { candidates, telemetryTarget };
}

export async function findSession(
  startDir: string,
  opts?: { command?: string },
): Promise<FoundSession> {
  let current = startDir;
  const { root } = parse(current);

  while (true) {
    const candidate = sessionPathFor(current);
    if (existsSync(candidate)) {
      const raw = await readFile(candidate, "utf8");
      const fileSession = JSON.parse(raw) as Session;
      // Secrets live in the out-of-repo credentials store; the store wins, but fall back to a token
      // embedded in the repo file so sessions created by an older CLI still work.
      const creds = await readCredentials(current);
      const session: Session = creds ? { ...fileSession, ...creds } : fileSession;
      return { session, hiDir: hiDirFor(current), repoDir: current };
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const { candidates, telemetryTarget } = await discover(startDir);
  throw new SessionNotFoundError(formatNotFound(candidates, opts?.command ?? "submit"), candidates, telemetryTarget);
}

export async function updateSession(
  repoDir: string,
  patch: Partial<Session>,
): Promise<Session> {
  const path = sessionPathFor(repoDir);
  const raw = await readFile(path, "utf8");
  // Re-merge secrets from the store (or a legacy file token) so we never strip a still-needed token,
  // and re-persist them through writeCredentials — which migrates a legacy session to the secure store.
  const creds = await readCredentials(repoDir);
  const session: Session = { ...(JSON.parse(raw) as Session), ...patch, ...(creds ?? {}) };
  await writeProtectedFile(path, JSON.stringify(withoutSecrets(session), null, 2) + "\n");
  if (session.token && session.apiBaseUrl) {
    await writeCredentials(repoDir, { token: session.token, apiBaseUrl: session.apiBaseUrl });
  }
  return session;
}
