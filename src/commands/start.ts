import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import chalk from "chalk";
import { apiBaseUrl, downloadBundle, fetchSeedUrl, fetchSession, startSessionClock } from "../api.js";
import { resolveSeed } from "../seeds.js";
import { getRuntime, setVerbose, isVerbose, startSpinner, LANG_LABEL, type Runtime } from "../runtimes/index.js";
import { clone, headSha } from "../git.js";
import { writeSession, recorderPidPath, LANGS, type Lang, type Session } from "../session.js";

const DEADLINE_MINUTES = 60;

export interface StartOptions {
  token?: string;
  lang?: string;
  seed?: string;
  verbose?: boolean;
}

function assertLang(lang: string): Lang {
  if ((LANGS as readonly string[]).includes(lang)) return lang as Lang;
  throw new Error(`language must be one of ${LANGS.join(", ")} (got "${lang}").`);
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
  if (options.token) {
    await startOnline(options.token, options.seed);
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

  const { repoDir, dirName, baselineSha } = await bootstrap({ task: taskArg, lang, source });

  const startedAt = new Date();
  const deadline = new Date(startedAt.getTime() + DEADLINE_MINUTES * 60_000);
  await finalize({
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
  });
}

async function startOnline(token: string, seedOverride?: string): Promise<void> {
  const base = apiBaseUrl();
  console.log(chalk.cyan("Resolving session from hellointerview.com..."));
  const remote = await fetchSession(base, token);
  const lang = assertLang(remote.language);

  const override = seedOverride?.trim();
  let source: string;
  let tempSeedDir: string | undefined;
  if (override && override.length > 0) {
    source = override;
  } else {
    console.log(chalk.cyan("Downloading seed..."));
    const { url } = await fetchSeedUrl(base, token);
    tempSeedDir = await mkdtemp(join(tmpdir(), "hi-byoe-seed-"));
    source = join(tempSeedDir, "baseline.bundle");
    await downloadBundle(url, source);
  }

  try {
    const { repoDir, dirName, baselineSha } = await bootstrap({ task: remote.task, lang, source });

    console.log(chalk.cyan("\nStarting session clock..."));
    const clock = await startSessionClock(base, token);
    const deadlineMinutes = Math.max(
      1,
      Math.round((new Date(clock.deadline).getTime() - new Date(clock.startedAt).getTime()) / 60_000),
    );

    await finalize({
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
    });

    if (clock.thinkAloudConsent) {
      console.log(
        chalk.cyan("\n🎙  Think-aloud recording is on in your browser tab. Keep that tab open while you work."),
      );
    }
  } finally {
    if (tempSeedDir) {
      await rm(tempSeedDir, { recursive: true, force: true });
    }
  }
}

async function bootstrap(args: {
  task: string;
  lang: Lang;
  source: string;
}): Promise<{ repoDir: string; dirName: string; baselineSha: string }> {
  const { task, lang, source } = args;
  const dirName = `${task}-${lang}`;
  const repoDir = resolve(process.cwd(), dirName);

  if (existsSync(repoDir)) {
    throw new Error(
      `Directory ${chalk.bold(dirName)} already exists. Remove it or start in a clean location.`,
    );
  }

  console.log(chalk.cyan(`Cloning seed for ${task} (${lang}) from ${source}...`));
  await clone(source, repoDir);

  const baselineSha = await headSha(repoDir);
  console.log(chalk.dim(`Baseline commit: ${baselineSha}`));

  await ensureHiIgnored(repoDir);

  const runtime = getRuntime(lang);
  const label = LANG_LABEL[lang];
  console.log(chalk.cyan(`\nSetting up your ${label} environment (one-time, ~30–60s the first time)…`));
  console.log(
    chalk.dim(
      `  Installs an isolated toolchain under ~/.local. It won't change your system ${label} or global PATH.`,
    ),
  );
  console.log(chalk.dim("  Re-run with --verbose to see everything.\n"));
  await runtime.provision(repoDir);

  const baseline = await runBaselineTests(runtime, repoDir);
  if (!baseline.passed) {
    console.log(
      chalk.red(
        "\nBootstrap did not produce a runnable repo: baseline tests failed. " +
          "Your session is still set up so you can investigate the clone.",
      ),
    );
  }

  return { repoDir, dirName, baselineSha };
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

// Every seed app binds 127.0.0.1 on PORT (default 8080); `byoe dev` honors that and
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
  console.log(`  ${chalk.dim("Then start working. Common commands:")}`);
  console.log(`    ${chalk.bold("npx @hellointerview/byoe test").padEnd(40)} ${chalk.dim("# run the tests")}`);
  console.log(
    `    ${chalk.bold("npx @hellointerview/byoe dev").padEnd(40)} ${chalk.dim(`# start the app (http://127.0.0.1:${APP_PORT})`)}`,
  );

  console.log(chalk.cyan(`\nWhen you're done, from inside ${dirName}:`));
  console.log(chalk.bold("  npx @hellointerview/byoe submit"));
}
