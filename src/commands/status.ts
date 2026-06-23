import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import chalk from "chalk";
import { fetchSession } from "../api.js";
import { findSession, recorderPidPath, timelineLogPath } from "../session.js";
import { diffStat, snapshotCommit } from "../git.js";
import { computeRemaining, labelFromSeconds } from "../time.js";

async function recorderStatus(hiDir: string): Promise<{ alive: boolean; ticks: number }> {
  const pidPath = recorderPidPath(hiDir);
  let alive = false;
  if (existsSync(pidPath)) {
    try {
      const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  let ticks = 0;
  const logPath = timelineLogPath(hiDir);
  if (existsSync(logPath)) {
    const raw = await readFile(logPath, "utf8");
    ticks = raw.split("\n").filter((line) => line.trim().length > 0).length;
  }
  return { alive, ticks };
}

export async function statusCommand(): Promise<void> {
  const { session, hiDir, repoDir } = await findSession(process.cwd(), { command: "status" });

  let remaining: { overTime: boolean; label: string };
  // The interviewer chat lives in the cockpit and only accepts questions while the session is ACTIVE,
  // so we only surface its link when the server confirms the session is still live.
  let interviewerChatUrl: string | undefined;
  if (session.token && session.apiBaseUrl) {
    try {
      const remote = await fetchSession(session.apiBaseUrl, session.token);
      remaining =
        remote.remainingSeconds === null
          ? computeRemaining(session.deadline, session.startedAt, new Date())
          : labelFromSeconds(remote.remainingSeconds);
      if (remote.status === "ACTIVE") {
        interviewerChatUrl = `${session.apiBaseUrl}/practice/ai-coding/byoe/${remote.id}`;
      }
    } catch {
      console.log(chalk.dim("(could not reach server; showing local time)"));
      remaining = computeRemaining(session.deadline, session.startedAt, new Date());
    }
  } else {
    remaining = computeRemaining(session.deadline, session.startedAt, new Date());
  }

  console.log(chalk.bold(`Task:   ${session.task} (${session.lang})`));
  if (remaining.overTime) {
    console.log(chalk.red(`Time:   ${remaining.label}`));
  } else {
    console.log(`Time:   ${chalk.bold(remaining.label)} remaining`);
  }
  if (session.submittedAt) {
    console.log(chalk.dim(`Submitted at ${session.submittedAt}`));
  }
  if (interviewerChatUrl) {
    console.log(chalk.dim(`Ask your interviewer clarifying questions: ${chalk.cyan(interviewerChatUrl)}`));
  }

  const recorder = await recorderStatus(hiDir);
  console.log(
    chalk.dim(
      `Recorder: ${recorder.alive ? "running" : "stopped"} (${recorder.ticks} snapshot${recorder.ticks === 1 ? "" : "s"})`,
    ),
  );

  // Mirror what submit captures: full working tree (committed + staged + unstaged + untracked)
  // so candidates see their actual in-progress work, not just committed changes.
  const snapshot = await snapshotCommit(repoDir);
  const stat = await diffStat(repoDir, session.baselineSha, snapshot);
  console.log(chalk.bold("\nChanges since baseline:"));
  console.log(stat.trim().length > 0 ? stat : chalk.dim("(no changes yet)"));
}
