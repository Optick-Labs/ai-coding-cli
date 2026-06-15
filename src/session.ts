import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

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

// O_NOFOLLOW where the platform supports it (0 elsewhere, e.g. Windows) so opening the session file
// fails instead of following a symlink. Stops a seed repo that ships `.hi/session.json` as a symlink
// from redirecting the bearer-token write outside the repo.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// The session file holds the bearer token, so it's owner-only and never written through a symlink.
// The open mode applies on creation; the explicit chmod covers an overwrite of a pre-existing,
// looser-permissioned file. chmod is best-effort (a no-op on filesystems that don't support it).
async function writeSessionFile(path: string, session: Session): Promise<void> {
  const data = JSON.stringify(session, null, 2) + "\n";
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.chmod(0o600).catch(() => undefined);
  } finally {
    await handle.close();
  }
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

export async function writeSession(repoDir: string, session: Session): Promise<string> {
  await ensureHiDir(repoDir);
  const path = sessionPathFor(repoDir);
  await writeSessionFile(path, session);
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

export async function findSession(startDir: string): Promise<FoundSession> {
  let current = startDir;
  const { root } = parse(current);

  while (true) {
    const candidate = sessionPathFor(current);
    if (existsSync(candidate)) {
      const raw = await readFile(candidate, "utf8");
      const session = JSON.parse(raw) as Session;
      return { session, hiDir: hiDirFor(current), repoDir: current };
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    "No Hello Interview session found. Run this command from inside a session folder (one created by `npx @hellointerview/ai-coding start`).",
  );
}

export async function updateSession(
  repoDir: string,
  patch: Partial<Session>,
): Promise<Session> {
  const path = sessionPathFor(repoDir);
  const raw = await readFile(path, "utf8");
  const session = { ...(JSON.parse(raw) as Session), ...patch };
  await writeSessionFile(path, session);
  return session;
}
