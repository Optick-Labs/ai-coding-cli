import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import chalk from "chalk";
import { apiBaseUrl, fetchSession } from "../api.js";
import { resolveSeed } from "../seeds.js";
import { getRuntime } from "../runtimes/index.js";
import { clone, headSha } from "../git.js";
import { writeSession, type Lang, type Session } from "../session.js";

const DEADLINE_MINUTES = 90;

export interface StartOptions {
  token?: string;
  lang?: string;
  seed?: string;
}

function assertLang(lang: string): Lang {
  if (lang === "python" || lang === "java") return lang;
  throw new Error(`language must be "python" or "java" (got "${lang}").`);
}

function assertSafeRemoteSeed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Server returned an unusable seed URL (${url}). Aborting.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Refusing to clone a non-https seed URL from the server (${url}). ` +
        "Use --seed to point at a trusted source if you're working offline.",
    );
  }
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
  const startedAt = new Date();
  const deadline = new Date(startedAt.getTime() + DEADLINE_MINUTES * 60_000);

  await bootstrap({
    task: taskArg,
    lang,
    source,
    session: {
      task: taskArg,
      lang,
      startedAt: startedAt.toISOString(),
      deadlineMinutes: DEADLINE_MINUTES,
      deadline: deadline.toISOString(),
      baselineSha: "",
    },
  });
}

async function startOnline(token: string, seedOverride?: string): Promise<void> {
  const base = apiBaseUrl();
  console.log(chalk.cyan("Resolving session from hellointerview.com..."));
  const remote = await fetchSession(base, token);
  const lang = assertLang(remote.language);
  const deadlineMinutes = Math.max(
    1,
    Math.round((new Date(remote.deadline).getTime() - new Date(remote.startedAt).getTime()) / 60_000),
  );

  const override = seedOverride?.trim();
  let source: string;
  if (override && override.length > 0) {
    source = override;
  } else {
    assertSafeRemoteSeed(remote.seedRepoUrl);
    source = remote.seedRepoUrl;
  }

  await bootstrap({
    task: remote.task,
    lang,
    source,
    session: {
      task: remote.task,
      lang,
      startedAt: remote.startedAt,
      deadlineMinutes,
      deadline: remote.deadline,
      baselineSha: "",
      token,
      apiBaseUrl: base,
    },
  });
}

async function bootstrap(args: { task: string; lang: Lang; source: string; session: Session }): Promise<void> {
  const { task, lang, source, session } = args;
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

  await writeSession(repoDir, { ...session, baselineSha });

  const readme = ["README.md", "readme.md", "README"].find((f) => existsSync(join(repoDir, f)));
  const deadline = new Date(session.deadline);

  console.log(chalk.bold.green("\nSession ready."));
  console.log(`Folder:   ${chalk.bold(repoDir)}`);
  console.log(`README:   ${readme ? join(repoDir, readme) : "(no README found in seed)"}`);
  console.log(`Budget:   ${session.deadlineMinutes} minutes (deadline ${deadline.toLocaleTimeString()})`);
  console.log(chalk.cyan("\nWhen you're done, from inside the folder run:"));
  console.log(chalk.bold(`  cd ${dirName} && hello-interview submit`));
}
