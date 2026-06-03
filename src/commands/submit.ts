import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { fetchArtifactUrl, postSubmit, uploadBundle, type SubmitResult } from "../api.js";
import { captureChats } from "./chat.js";
import { findSession, recorderPidPath, updateSession } from "../session.js";
import { getRuntime } from "../runtimes/index.js";
import { diff, log, diffNameStatus, bundleSnapshot, snapshotCommit } from "../git.js";
import { computeRemaining } from "../time.js";

// Stop the background recorder before we snapshot so it can't run git concurrently with the submit.
// Best-effort: a missing or dead recorder is the normal case for offline/already-finished sessions.
async function stopRecorder(hiDir: string): Promise<void> {
  const pidPath = recorderPidPath(hiDir);
  if (!existsSync(pidPath)) return;
  try {
    const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone — nothing to stop.
      }
    }
  } finally {
    await rm(pidPath, { force: true });
  }
}

interface Summary {
  task: string;
  lang: string;
  submittedAt: string;
  overTime: boolean;
  elapsedMinutes: number;
  testsPassed: boolean;
}

function extractAddedTestFiles(nameStatus: string): string[] {
  return nameStatus
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("A"))
    .map((line) => line.split(/\s+/).slice(1).join(" "))
    .filter((path) => {
      const base = path.split("/").pop() ?? path;
      return (
        /(^|\/)tests?(\/|$)/.test(path) ||
        /^test_.*\.py$|_test\.py$/.test(base) ||
        /\.(test|spec)\.(t|j)s$/.test(base) ||
        /_test\.go$/.test(base) ||
        /Tests?\.cs$/.test(base)
      );
    });
}

export async function submitCommand(): Promise<void> {
  const { session, hiDir, repoDir } = await findSession(process.cwd());
  const artifactDir = join(hiDir, "artifact");
  await mkdir(artifactDir, { recursive: true });

  await stopRecorder(hiDir);

  const snapshot = await snapshotCommit(repoDir);

  const [diffText, logText, nameStatus] = await Promise.all([
    diff(repoDir, session.baselineSha, snapshot),
    log(repoDir, session.baselineSha),
    diffNameStatus(repoDir, session.baselineSha, snapshot),
  ]);

  const addedTests = extractAddedTestFiles(nameStatus);

  const bundlePath = join(artifactDir, "submission.bundle");
  await bundleSnapshot(repoDir, bundlePath, snapshot);

  await Promise.all([
    writeFile(join(artifactDir, "diff.patch"), diffText, "utf8"),
    writeFile(join(artifactDir, "git.log"), logText, "utf8"),
    writeFile(
      join(artifactDir, "added-tests.txt"),
      addedTests.length > 0 ? addedTests.join("\n") + "\n" : "",
      "utf8",
    ),
  ]);

  if (nameStatus.trim().length === 0) {
    console.log(chalk.yellow("Warning: no changes since baseline — submitting an unchanged repo."));
  }

  console.log(chalk.cyan("Re-running tests..."));
  const runtime = getRuntime(session.lang);
  const testResult = await runtime.runTests(repoDir);
  await writeFile(join(artifactDir, "test-result.txt"), testResult.output, "utf8");

  const submittedAtDate = new Date();
  const local = computeRemaining(session.deadline, session.startedAt, submittedAtDate);

  let overTime = local.overTime;
  let serverResult: SubmitResult | undefined;

  if (session.token && session.apiBaseUrl) {
    console.log(chalk.cyan("Uploading submission..."));
    const { url } = await fetchArtifactUrl(session.apiBaseUrl, session.token);
    await uploadBundle(url, bundlePath);

    // Capture AI chats BEFORE flipping the session to SUBMITTED. The cockpit stops polling once it
    // sees SUBMITTED, so if capture (which sets aiChatCaptureStatus) landed after the flip, the page
    // could flash the "paste your chat" step for a chat the candidate just uploaded here. Recording
    // while still ACTIVE closes that race. Best-effort: a capture hiccup never blocks the submit.
    try {
      await captureChats(session, repoDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.dim(`Chat capture skipped (${message}).`));
    }

    serverResult = await postSubmit(session.apiBaseUrl, session.token, {
      baselineSha: session.baselineSha,
      testsPassedLocal: testResult.passed,
      diff: diffText,
      // The done-moment stamped before the chat prompt — time spent in the picker isn't counted as
      // coding time and can't push the candidate over the deadline.
      submittedAt: submittedAtDate.toISOString(),
      metadata: { elapsedMinutes: local.elapsedMinutes, addedTests },
    });
    overTime = serverResult.overTime;
  }

  const summary: Summary = {
    task: session.task,
    lang: session.lang,
    submittedAt: serverResult?.submittedAt ?? submittedAtDate.toISOString(),
    overTime,
    elapsedMinutes: local.elapsedMinutes,
    testsPassed: testResult.passed,
  };
  await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  await updateSession(repoDir, { submittedAt: summary.submittedAt });

  console.log(chalk.bold.green("\nSubmission complete."));
  console.log(`Task:        ${session.task} (${session.lang})`);
  console.log(`Elapsed:     ${local.elapsedMinutes} min`);
  console.log(overTime ? chalk.red("Over time:   yes") : chalk.green("Over time:   no"));
  console.log(
    testResult.passed ? chalk.green("Tests:       passed (local, unverified)") : chalk.red("Tests:       FAILED (local)"),
  );
  console.log(`Added tests: ${addedTests.length > 0 ? addedTests.join(", ") : "(none)"}`);
  console.log(`Artifacts:   ${chalk.bold(artifactDir)}`);

  if (serverResult) {
    console.log(chalk.dim(`Uploaded to control plane (status: ${serverResult.status}).`));
    const nextUrl = serverResult.cockpitUrl ?? serverResult.debriefUrl;
    if (nextUrl) {
      console.log(`\n${chalk.bold("Next:")} continue your session at ${chalk.cyan(nextUrl)}`);
    }
  } else {
    console.log(chalk.dim("Offline mode — artifact saved locally, not uploaded."));
  }
}
