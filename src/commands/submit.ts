import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { fetchArtifactUrl, fetchSession, postSubmit, uploadBundle, type SubmitResult } from "../api.js";
import { captureChats } from "./chat.js";
import { pingEvent } from "./events.js";
import { findSession, recorderPidPath, updateSession } from "../session.js";
import { getRuntime } from "../runtimes/index.js";
import { diff, log, diffNameStatus, bundleSnapshot, snapshotCommit } from "../git.js";
import { computeRemaining } from "../time.js";

// Cap the post-submission test re-run. The submission is already recorded by the time this runs, so
// this only bounds how long we wait to show the candidate a local pass/fail before the CLI exits.
const SUBMIT_TEST_TIMEOUT_MS = 20_000;

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
  // null for self-directed (build-from-scratch) tasks: there is no managed test runner, so a
  // pass/fail simply doesn't apply.
  testsPassed: boolean | null;
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

// When the candidate runs `submit` a second time the server has already flipped the session to
// SUBMITTED, so every write call (artifact-url, submit) 409s with a raw "session is not active".
// Catch that early — before re-running tests and snapshotting — and point them at their debrief
// instead of dumping a stack-traced HTTP error.
function printSessionNotActive(base: string, sessionId: string, status: string, submittedAt: string | null): void {
  const cockpitUrl = `${base}/practice/ai-coding/byoe/${sessionId}`;
  if (status === "SUBMITTED") {
    console.log(chalk.red.bold("\nThis session has already been submitted."));
    if (submittedAt) {
      const when = new Date(submittedAt);
      if (!Number.isNaN(when.getTime())) {
        console.log(chalk.red(`You submitted at ${when.toLocaleString()}.`));
      }
    }
    console.log(`\nHead to your debrief and feedback: ${chalk.cyan(cockpitUrl)}`);
    console.log(chalk.dim(`To attach AI chats you forgot, run ${chalk.bold("npx @hellointerview/byoe chat")}.`));
    return;
  }

  console.log(chalk.red.bold(`\nThis session is no longer active (status: ${status}) and can't be submitted.`));
  console.log(`\nSee your session at ${chalk.cyan(cockpitUrl)}`);
}

export async function submitCommand(): Promise<void> {
  const { session, hiDir, repoDir } = await findSession(process.cwd());

  if (session.token && session.apiBaseUrl) {
    const remote = await fetchSession(session.apiBaseUrl, session.token);
    if (remote.status !== "ACTIVE") {
      printSessionNotActive(session.apiBaseUrl, remote.id, remote.status, remote.submittedAt);
      return;
    }
  }

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

  const submittedAtDate = new Date();
  const local = computeRemaining(session.deadline, session.startedAt, submittedAtDate);

  let overTime = local.overTime;
  let serverResult: SubmitResult | undefined;

  // Record the submission FIRST, without waiting for tests. Tests are re-run below for the candidate's
  // benefit, but a slow or hanging suite must never block (or delay) the submission landing on the
  // server. The test outcome is reported afterward via a TEST_RUN event.
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
      diff: diffText,
      // The done-moment stamped before the chat prompt — time spent in the picker isn't counted as
      // coding time and can't push the candidate over the deadline.
      submittedAt: submittedAtDate.toISOString(),
      metadata: { elapsedMinutes: local.elapsedMinutes, addedTests },
    });
    overTime = serverResult.overTime;
  }

  await updateSession(repoDir, { submittedAt: serverResult?.submittedAt ?? submittedAtDate.toISOString() });

  console.log(chalk.bold.green("\nSubmission complete."));
  console.log(`Task:        ${session.task} (${session.lang})`);
  console.log(`Elapsed:     ${local.elapsedMinutes} min`);
  console.log(overTime ? chalk.red("Over time:   yes") : chalk.green("Over time:   no"));
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

  const runtime = getRuntime(session.lang);

  // Build-from-scratch tasks have no managed test runner — there's nothing to re-run. The full diff
  // is already captured above; just record the summary and tell the candidate so.
  if (runtime.selfDirected) {
    const summary: Summary = {
      task: session.task,
      lang: session.lang,
      submittedAt: serverResult?.submittedAt ?? submittedAtDate.toISOString(),
      overTime,
      elapsedMinutes: local.elapsedMinutes,
      testsPassed: null,
    };
    await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(chalk.dim("\nNo built-in test runner for this task — your full diff was captured."));
    return;
  }

  // Now run tests for the candidate's reference and report the result separately. Bounded so a hang
  // can't strand the CLI — the submission above is already recorded either way.
  console.log(chalk.cyan("\nRunning tests..."));
  const startedAt = Date.now();
  const testResult = await runtime.runTests(repoDir, SUBMIT_TEST_TIMEOUT_MS);
  const durationMs = Date.now() - startedAt;
  if (testResult.output.trim().length > 0) {
    process.stdout.write(testResult.output.trim() + "\n");
  }
  await writeFile(join(artifactDir, "test-result.txt"), testResult.output, "utf8");

  const summary: Summary = {
    task: session.task,
    lang: session.lang,
    submittedAt: serverResult?.submittedAt ?? submittedAtDate.toISOString(),
    overTime,
    elapsedMinutes: local.elapsedMinutes,
    testsPassed: testResult.passed,
  };
  await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");

  await pingEvent(session, {
    type: "TEST_RUN",
    passed: testResult.passed,
    exitCode: testResult.exitCode ?? undefined,
    durationMs,
    timedOut: testResult.timedOut,
  });

  if (testResult.timedOut) {
    console.log(chalk.yellow("Tests:       timed out (local) — submission already recorded."));
  } else {
    console.log(
      testResult.passed
        ? chalk.green("Tests:       passed (local, unverified)")
        : chalk.red("Tests:       FAILED (local)"),
    );
  }
}
