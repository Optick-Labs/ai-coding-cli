import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, basename } from "node:path";
import chalk from "chalk";
import { apiBaseUrl, downloadBundle, fetchSeedUrl, fetchSession, startSessionClock } from "../api.js";
import { resolveSeed } from "../seeds.js";
import { getRuntime, setVerbose, isVerbose, startSpinner, LANG_LABEL, type Runtime } from "../runtimes/index.js";
import { clone, headSha } from "../git.js";
import { writeSession, recorderPidPath, LANGS, type Lang, type Session } from "../session.js";
import { StartTelemetry, LOCAL_LOG_NAME, namedError } from "./start-telemetry.js";

const DEADLINE_MINUTES = 60;

export interface StartOptions {
  token?: string;
  tokenStdin?: boolean;
  lang?: string;
  seed?: string;
  verbose?: boolean;
}

// Read a single line from stdin for `--token-stdin`. Resumes the paused stdin stream and resolves on
// the first newline (so an interactive paste + Enter proceeds immediately) or on EOF (so a piped
// `pbpaste | ai-coding start --token-stdin` works). A backstop timeout keeps it from hanging if a
// TTY is left open with no input. Listeners are always torn down so stdin doesn't keep the loop alive.
const STDIN_TOKEN_TIMEOUT_MS = 30_000;
function readTokenFromStdin(timeoutMs = STDIN_TOKEN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolveLine, reject) => {
    const stdin = process.stdin;
    let data = "";
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      stdin.pause();
    };
    const finish = (line: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveLine(line.trim());
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: string): void => {
      data += chunk;
      const nl = data.search(/\r?\n/);
      if (nl !== -1) finish(data.slice(0, nl));
    };
    const onEnd = (): void => finish(data.split(/\r?\n/)[0] ?? "");
    const onError = (err: Error): void => fail(err);
    const timer = setTimeout(
      () => fail(new Error("--token-stdin timed out waiting for a token on stdin.")),
      timeoutMs,
    );

    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

type ResolvedToken =
  | { token: string; source: "flag" | "stdin" | "env" }
  | { token: undefined; source: "none" };

// Resolve the session token, preferring the least-exposed source: an explicit --token, then
// --token-stdin, then the HI_TOKEN env var. Carries the source so the caller can tell an explicit
// online request from an ambient env var. Returns no token when none is set (offline mode).
async function resolveToken(options: StartOptions): Promise<ResolvedToken> {
  const flag = options.token?.trim();
  if (flag) return { token: flag, source: "flag" };
  if (options.tokenStdin) {
    const fromStdin = await readTokenFromStdin();
    if (fromStdin) return { token: fromStdin, source: "stdin" };
    throw new Error("--token-stdin was set but no token was read from stdin.");
  }
  const fromEnv = process.env.HI_TOKEN?.trim();
  if (fromEnv && fromEnv.length > 0) return { token: fromEnv, source: "env" };
  return { token: undefined, source: "none" };
}

function assertLang(lang: string): Lang {
  if ((LANGS as readonly string[]).includes(lang)) return lang as Lang;
  // Named for telemetry: online, this fires when the server hands back a language this build doesn't
  // know — i.e. an outdated CLI — which is worth seeing as its own bucket, not a generic Error.
  throw namedError("UnsupportedLanguage", `language must be one of ${LANGS.join(", ")} (got "${lang}").`);
}

// The clone folder is named from server- or user-supplied strings (`repoName`/`task`). Constrain it to
// a single safe path segment so a value like "../../evil" can't redirect the clone outside the cwd.
function safeDirSegment(value: string): string {
  const segment = basename(value.trim());
  if (!segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
    throw namedError("InvalidRepoName", `Refusing unsafe session folder name "${value}".`);
  }
  return segment;
}

async function ensureHiIgnored(repoDir: string): Promise<void> {
  const gitignorePath = join(repoDir, ".gitignore");
  let contents = "";
  if (existsSync(gitignorePath)) {
    contents = await readFile(gitignorePath, "utf8");
    if (contents.split(/\r?\n/).some((line) => line.trim() === ".hi" || line.trim() === ".hi/")) {
      return;
    }
  }
  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  await appendFile(gitignorePath, `${prefix}.hi/\n`, "utf8");
}

export async function startCommand(taskArg: string | undefined, options: StartOptions): Promise<void> {
  setVerbose(!!options.verbose);
  const resolved = await resolveToken(options);
  if (resolved.token) {
    // A task arg or --lang signals offline intent. If the only token came from an ambient HI_TOKEN,
    // don't silently go online and burn a real session clock — make the user resolve the conflict.
    if (resolved.source === "env" && (taskArg || options.lang)) {
      throw new Error(
        "HI_TOKEN is set (online mode) but you also passed offline arguments (a task and/or --lang). " +
          "Unset HI_TOKEN to run offline, or drop the task/--lang to start an online session.",
      );
    }
    await startOnline(resolved.token, options.seed);
    return;
  }

  if (!taskArg) {
    throw new Error("Provide --token (from hellointerview.com), or a <task> and --lang for offline mode.");
  }
  if (!options.lang) {
    throw new Error("--lang is required in offline mode.");
  }

  const lang = assertLang(options.lang);
  const source = resolveSeed({ task: taskArg, lang, seedFlag: options.seed });

  // Offline mode has no token, so telemetry is local-only (the network report no-ops). It still drops
  // a debug breadcrumb on a hard failure, which is handy while iterating on seeds.
  const telemetry = new StartTelemetry({});
  try {
    const { repoDir, dirName, baselineSha, baseline } = await bootstrap({ task: taskArg, lang, source }, telemetry);

    const startedAt = new Date();
    const deadline = new Date(startedAt.getTime() + DEADLINE_MINUTES * 60_000);
    await telemetry.phase("FINALIZE", () =>
      finalize({
        repoDir,
        dirName,
        session: {
          task: taskArg,
          lang,
          startedAt: startedAt.toISOString(),
          deadlineMinutes: DEADLINE_MINUTES,
          deadline: deadline.toISOString(),
          baselineSha,
        },
      }),
    );

    if (!baseline || baseline.passed) await telemetry.success();
    else await telemetry.baselineFailed(baseline.output);
  } catch (error) {
    await telemetry.failure(error);
    printFailureHint();
    throw error;
  }
}

async function startOnline(token: string, seedOverride?: string): Promise<void> {
  const base = apiBaseUrl();
  const telemetry = new StartTelemetry({ token, apiBaseUrl: base });
  await telemetry.announceOnce();
  let tempSeedDir: string | undefined;

  try {
    console.log(chalk.cyan("Resolving session from hellointerview.com..."));
    const remote = await telemetry.phase("RESOLVE_SESSION", () => fetchSession(base, token));
    const lang = assertLang(remote.language);

    const override = seedOverride?.trim();
    let source: string;
    if (override && override.length > 0) {
      source = override;
    } else {
      source = await telemetry.phase("DOWNLOAD_SEED", async () => {
        console.log(chalk.cyan("Downloading seed..."));
        const { url } = await fetchSeedUrl(base, token);
        tempSeedDir = await mkdtemp(join(tmpdir(), "hi-byoe-seed-"));
        const dest = join(tempSeedDir, "baseline.bundle");
        await downloadBundle(url, dest);
        return dest;
      });
    }

    const { repoDir, dirName, baselineSha, baseline } = await bootstrap(
      { task: remote.task, repoName: remote.repoName, lang, source },
      telemetry,
    );

    console.log(chalk.cyan("\nStarting session clock..."));
    const clock = await telemetry.phase("START_CLOCK", () => startSessionClock(base, token));
    const deadlineMinutes = Math.max(
      1,
      Math.round((new Date(clock.deadline).getTime() - new Date(clock.startedAt).getTime()) / 60_000),
    );

    await telemetry.phase("FINALIZE", () =>
      finalize({
        repoDir,
        dirName,
        session: {
          task: remote.task,
          lang,
          startedAt: clock.startedAt,
          deadlineMinutes,
          deadline: clock.deadline,
          baselineSha,
          token,
          apiBaseUrl: base,
        },
      }),
    );

    if (clock.thinkAloudConsent) {
      console.log(
        chalk.cyan("\n🎙  Think-aloud recording is on in your browser tab. Keep that tab open while you work."),
      );
    }

    if (!baseline || baseline.passed) await telemetry.success();
    else await telemetry.baselineFailed(baseline.output);
  } catch (error) {
    await telemetry.failure(error);
    printFailureHint();
    throw error;
  } finally {
    if (tempSeedDir) {
      await rm(tempSeedDir, { recursive: true, force: true });
    }
  }
}

function printFailureHint(): void {
  console.log(
    chalk.dim(
      `\nWe logged what went wrong. If it keeps happening, re-run with --verbose and send us ./${LOCAL_LOG_NAME}.`,
    ),
  );
}

async function bootstrap(
  args: { task: string; repoName?: string; lang: Lang; source: string },
  telemetry: StartTelemetry,
): Promise<{ repoDir: string; dirName: string; baselineSha: string; baseline?: { passed: boolean; output: string } }> {
  const { task, repoName, lang, source } = args;
  const dirName = `${safeDirSegment(repoName || task)}-${lang}`;
  const repoDir = resolve(process.cwd(), dirName);

  const baselineSha = await telemetry.phase("CLONE", async () => {
    if (existsSync(repoDir)) {
      // namedError so this lands as errorKind "DirectoryExists" — a user-environment condition, not a
      // setup-pipeline failure, and the dashboard shouldn't count it against the real failure rate.
      throw namedError(
        "DirectoryExists",
        `Directory ${chalk.bold(dirName)} already exists. Remove it or start in a clean location.`,
      );
    }
    console.log(chalk.cyan(`Cloning seed for ${task} (${lang}) from ${source}...`));
    await clone(source, repoDir);
    const sha = await headSha(repoDir);
    console.log(chalk.dim(`Baseline commit: ${sha}`));
    await ensureHiIgnored(repoDir);
    return sha;
  });

  const runtime = getRuntime(lang);

  // A self-directed (build-from-scratch) task has no managed toolchain and no baseline tests —
  // skip provisioning entirely and tell the candidate it's theirs to build in any stack.
  if (runtime.selfDirected) {
    console.log(
      chalk.cyan("\nThis is a build-from-scratch task — there's nothing to set up."),
    );
    console.log(
      chalk.dim("  Build it in whatever language and tools you want. Read the README and start."),
    );
    return { repoDir, dirName, baselineSha };
  }

  const label = LANG_LABEL[lang];
  console.log(chalk.cyan(`\nSetting up your ${label} environment (one-time, ~30–60s the first time)…`));
  console.log(
    chalk.dim(
      `  Installs an isolated toolchain under ~/.local. It won't change your system ${label} or global PATH.`,
    ),
  );
  console.log(chalk.dim("  Re-run with --verbose to see everything.\n"));
  await telemetry.phase("PROVISION", () => runtime.provision(repoDir));

  const baseline = await telemetry.phase("BASELINE_TESTS", () => runBaselineTests(runtime, repoDir));
  if (!baseline.passed) {
    console.log(
      chalk.red(
        "\nBootstrap did not produce a runnable repo: baseline tests failed. " +
          "Your session is still set up so you can investigate the clone.",
      ),
    );
  }

  return { repoDir, dirName, baselineSha, baseline: { passed: baseline.passed, output: baseline.output } };
}

// Baseline run during start: quiet ✓/✗ on the happy path (test output is noise here), with the full
// log surfaced only on failure or under --verbose.
async function runBaselineTests(runtime: Runtime, repoDir: string) {
  if (isVerbose()) {
    console.log(chalk.cyan("▸ Baseline tests…"));
    const result = await runtime.runTests(repoDir);
    if (result.output.trim().length > 0) process.stdout.write(result.output.trim() + "\n");
    console.log(
      result.passed ? chalk.green("  ✓ Baseline tests pass") : chalk.red("  ✗ Baseline tests failed"),
    );
    return result;
  }
  const spinner = startSpinner("Baseline tests pass");
  const result = await runtime.runTests(repoDir);
  if (result.passed) {
    spinner.succeed();
  } else {
    spinner.fail();
    if (result.output.trim().length > 0) {
      process.stdout.write("\n" + chalk.dim(result.output.trim()) + "\n");
    }
  }
  return result;
}

// Every seed app binds 127.0.0.1 on PORT (default 8080); `ai-coding dev` honors that and
// auto-picks a free port if it's taken. Kept as a single constant so this can't go stale per-language.
const APP_PORT = 8080;

function recorderAlreadyRunning(repoDir: string): boolean {
  const pidPath = recorderPidPath(join(repoDir, ".hi"));
  if (!existsSync(pidPath)) return false;
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (!Number.isInteger(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Spawn the background timeline recorder, detached from this process so it keeps snapshotting after
// `start` returns control to the shell. Entirely best-effort: a session is fully usable without it.
function spawnRecorder(repoDir: string): boolean {
  if (recorderAlreadyRunning(repoDir)) return true;
  const cliEntry = process.argv[1];
  if (!cliEntry) return false;
  try {
    const child = spawn(process.execPath, [cliEntry, "__record"], {
      cwd: repoDir,
      detached: true,
      stdio: "ignore",
    });
    // spawn reports failures (ENOENT, EACCES) via an async error event; an unhandled one would
    // throw and crash start, so swallow it to keep the recorder strictly best-effort.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function finalize(args: { repoDir: string; dirName: string; session: Session }): Promise<void> {
  const { repoDir, dirName, session } = args;
  await writeSession(repoDir, session);
  const recording = spawnRecorder(repoDir);

  const readme = ["README.md", "readme.md", "README"].find((f) => existsSync(join(repoDir, f)));
  const deadline = new Date(session.deadline);

  console.log(chalk.bold.green("\nSession ready."));
  console.log(`Folder:   ${chalk.bold(repoDir)}`);
  console.log(
    `README:   ${readme ? join(repoDir, readme) : "(no README found in seed)"}  ${chalk.dim("← read this first")}`,
  );
  console.log(`Budget:   ${session.deadlineMinutes} minutes (deadline ${deadline.toLocaleTimeString()})`);
  if (recording) {
    console.log(
      chalk.dim("Progress: snapshotted every 2 min so your debrief can reference how you built it."),
    );
  }

  console.log(chalk.cyan("\nNext steps:"));
  console.log(`  ${chalk.bold(`cd ${dirName}`)}`);
  console.log(`  ${chalk.dim("Open the README in your editor and read the task brief.")}`);
  if (getRuntime(session.lang).selfDirected) {
    console.log(
      `  ${chalk.dim("Then start building — in any language, with your own test/dev tools.")}`,
    );
    console.log(
      `  ${chalk.dim("There's no built-in test or dev runner for this task; `submit` captures everything you write.")}`,
    );
  } else {
    console.log(`  ${chalk.dim("Then start working. Common commands:")}`);
    console.log(`    ${chalk.bold("npx @hellointerview/ai-coding test").padEnd(40)} ${chalk.dim("# run the tests")}`);
    console.log(
      `    ${chalk.bold("npx @hellointerview/ai-coding dev").padEnd(40)} ${chalk.dim(`# start the app (http://127.0.0.1:${APP_PORT})`)}`,
    );
  }

  console.log(chalk.cyan(`\nWhen you're done, from inside ${dirName}:`));
  console.log(chalk.bold("  npx @hellointerview/ai-coding submit"));
}
