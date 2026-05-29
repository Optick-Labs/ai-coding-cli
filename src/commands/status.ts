import chalk from "chalk";
import { fetchSession } from "../api.js";
import { findSession } from "../session.js";
import { diffStat, snapshotCommit } from "../git.js";
import { computeRemaining, labelFromSeconds } from "../time.js";

export async function statusCommand(): Promise<void> {
  const { session, repoDir } = await findSession(process.cwd());

  let remaining: { overTime: boolean; label: string };
  if (session.token && session.apiBaseUrl) {
    try {
      const remote = await fetchSession(session.apiBaseUrl, session.token);
      remaining =
        remote.remainingSeconds === null
          ? computeRemaining(session.deadline, session.startedAt, new Date())
          : labelFromSeconds(remote.remainingSeconds);
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

  // Mirror what submit captures: full working tree (committed + staged + unstaged + untracked)
  // so candidates see their actual in-progress work, not just committed changes.
  const snapshot = await snapshotCommit(repoDir);
  const stat = await diffStat(repoDir, session.baselineSha, snapshot);
  console.log(chalk.bold("\nChanges since baseline:"));
  console.log(stat.trim().length > 0 ? stat : chalk.dim("(no changes yet)"));
}
