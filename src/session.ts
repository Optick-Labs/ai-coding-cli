import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

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
function credentialsDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "hellointerview-ai-coding", "credentials");
}

function credentialsPathFor(repoDir: string): string {
  const key = createHash("sha256").update(resolve(repoDir)).digest("hex").slice(0, 32);
  return join(credentialsDir(), `${key}.json`);
}

async function writeCredentials(repoDir: string, creds: Credentials): Promise<void> {
  await mkdir(credentialsDir(), { recursive: true });
  await writeProtectedFile(credentialsPathFor(repoDir), JSON.stringify(creds, null, 2) + "\n");
}

async function readCredentials(repoDir: string): Promise<Credentials | undefined> {
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

export async function findSession(startDir: string): Promise<FoundSession> {
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
