import { existsSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { commitTimelineTick } from "../git.js";
import {
  findSession,
  recorderLogPath,
  recorderPidPath,
  timelineLogPath,
  type Session,
} from "../session.js";

// Internal testability hook; absent in normal use, where the cadence is a fixed 2 minutes.
function recordIntervalMs(): number {
  const override = Number.parseInt(process.env.HI_RECORD_INTERVAL_MS ?? "", 10);
  return Number.isInteger(override) && override > 0 ? override : 120_000;
}
// Keep recording through overtime work, but give up well after the deadline so an abandoned session
// can't leave a recorder running forever.
const OVERTIME_GRACE_MS = 2 * 60 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidPath: string): Promise<number | undefined> {
  if (!existsSync(pidPath)) return undefined;
  try {
    const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function logError(logPath: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  try {
    await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Logging is best-effort; never let it take down the recorder.
  }
}

async function readSessionFresh(repoDir: string): Promise<Session | undefined> {
  try {
    return (await findSession(repoDir)).session;
  } catch {
    return undefined;
  }
}

export async function recordCommand(): Promise<void> {
  let found;
  try {
    found = await findSession(process.cwd());
  } catch {
    // No session here means nothing to record. Exit quietly.
    return;
  }
  const { hiDir, repoDir, session } = found;
  const pidPath = recorderPidPath(hiDir);
  const logPath = recorderLogPath(hiDir);
  const timelinePath = timelineLogPath(hiDir);

  await writeFile(pidPath, `${process.pid}\n`, "utf8");

  const cleanup = async (): Promise<void> => {
    if ((await readPid(pidPath)) === process.pid) {
      await rm(pidPath, { force: true });
    }
  };
  const onSignal = (): void => {
    void cleanup().finally(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const startedAtMs = new Date(session.startedAt).getTime();
  const deadlineMs = new Date(session.deadline).getTime();
  const intervalMs = recordIntervalMs();
  let tick = 0;

  try {
    while (true) {
      await sleep(intervalMs);

      // Another process owns the pidfile (e.g. submit cleared it, or a newer recorder started).
      const ownerPid = await readPid(pidPath);
      if (ownerPid !== process.pid) break;

      const current = await readSessionFresh(repoDir);
      if (current?.submittedAt) break;
      if (Date.now() > deadlineMs + OVERTIME_GRACE_MS) break;

      try {
        const elapsedSec = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
        const result = await commitTimelineTick(repoDir, { tick: tick + 1, elapsedSec });
        if (result.committed) {
          tick += 1;
          const entry = {
            tick,
            ts: new Date().toISOString(),
            elapsedSec,
            treeSha: result.treeSha,
            parentSha: result.parentSha,
            commitSha: result.commitSha,
          };
          await appendFile(timelinePath, `${JSON.stringify(entry)}\n`, "utf8");
        }
      } catch (err) {
        await logError(logPath, err);
      }
    }
  } finally {
    await cleanup();
  }
}
