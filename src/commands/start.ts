import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import chalk from "chalk";
import { apiBaseUrl, downloadBundle, fetchSeedUrl, fetchSession, startSessionClock } from "../api.js";
import { resolveSeed } from "../seeds.js";
import { getRuntime } from "../runtimes/index.js";
import { clone, headSha } from "../git.js";
import { writeSession, type Lang, type Session } from "../session.js";

const DEADLINE_MINUTES = 60;

export interface StartOptions {
  token?: string;
  lang?: string;
  seed?: string;
}

function assertLang(lang: string): Lang {
  if (lang === "python" || lang === "java") return lang;
  throw new Error(`language must be "python" or "java" (got "${lang}").`);
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
  console.log(chalk.cyan("\nProvisioning runtime..."));
  await runtime.provision(repoDir);

  console.log(chalk.cyan("\nRunning baseline tests..."));
  const baseline = await runtime.runTests(repoDir);
  if (!baseline.passed) {
    console.log(
      chalk.red(
        "\nBootstrap did not produce a runnable repo: baseline tests failed. " +
          "Your session is still set up so you can investigate the clone.",
      ),
    );
  } else {
    console.log(chalk.green("Baseline tests passed."));
  }

  return { repoDir, dirName, baselineSha };
}

const NEXT_STEPS: Record<Lang, { test: string; run: string; port: number }> = {
  python: { test: "uv run pytest", run: "uv run python app.py", port: 5000 },
  java: { test: "./mvnw test", run: "./mvnw spring-boot:run", port: 5000 },
};

async function finalize(args: { repoDir: string; dirName: string; session: Session }): Promise<void> {
  const { repoDir, dirName, session } = args;
  await writeSession(repoDir, session);

  const readme = ["README.md", "readme.md", "README"].find((f) => existsSync(join(repoDir, f)));
  const deadline = new Date(session.deadline);
  const { test, run, port } = NEXT_STEPS[session.lang];

  console.log(chalk.bold.green("\nSession ready."));
  console.log(`Folder:   ${chalk.bold(repoDir)}`);
  console.log(
    `README:   ${readme ? join(repoDir, readme) : "(no README found in seed)"}  ${chalk.dim("← read this first")}`,
  );
  console.log(`Budget:   ${session.deadlineMinutes} minutes (deadline ${deadline.toLocaleTimeString()})`);

  console.log(chalk.cyan("\nNext steps:"));
  console.log(`  ${chalk.bold(`cd ${dirName}`)}`);
  console.log(`  ${chalk.dim("Open the README in your editor and read the task brief.")}`);
  console.log(`  ${chalk.dim(`Then start working. Common commands:`)}`);
  console.log(`    ${chalk.bold(test).padEnd(40)} ${chalk.dim("# run tests")}`);
  console.log(`    ${chalk.bold(run).padEnd(40)} ${chalk.dim(`# run the app (localhost:${port})`)}`);

  console.log(chalk.cyan(`\nWhen you're done, from inside ${dirName}:`));
  console.log(chalk.bold("  hello-interview submit"));
}
