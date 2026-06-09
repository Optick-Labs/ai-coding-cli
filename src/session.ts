import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

function hiDirFor(repoDir: string): string {
  return join(repoDir, ".hi");
}

function sessionPathFor(repoDir: string): string {
  return join(hiDirFor(repoDir), SESSION_FILE);
}

export async function writeSession(repoDir: string, session: Session): Promise<string> {
  const hiDir = hiDirFor(repoDir);
  await mkdir(hiDir, { recursive: true });
  const path = sessionPathFor(repoDir);
  await writeFile(path, JSON.stringify(session, null, 2) + "\n", "utf8");
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
    "No Hello Interview session found. Run this command from inside a session folder (one created by `npx @hellointerview/byoe start`).",
  );
}

export async function updateSession(
  repoDir: string,
  patch: Partial<Session>,
): Promise<Session> {
  const raw = await readFile(sessionPathFor(repoDir), "utf8");
  const session = { ...(JSON.parse(raw) as Session), ...patch };
  await writeFile(sessionPathFor(repoDir), JSON.stringify(session, null, 2) + "\n", "utf8");
  return session;
}
