import chalk from "chalk";
import type { Lang } from "../session.js";
import type { Runtime, TestResult } from "./types.js";
import { onPath, resolveBin, runTestsCapture, streamInstall, streamRun } from "./shared.js";

export async function ensureMise(): Promise<void> {
  if (await onPath("mise")) return;
  console.log(chalk.yellow("mise not found. Installing mise..."));
  await streamInstall("https://mise.run");
  if (!(await onPath("mise"))) {
    throw new Error("mise install completed but mise is still not on PATH (~/.local/bin).");
  }
}

// Builds a Runtime for any mise-provisioned language: `mise trust` + `mise install`
// pin the toolchain, then deps/tests run through `mise exec` so the pinned runtime is
// active regardless of the candidate's shell. Each language differs only in its install
// and test commands.
export function createMiseRuntime(lang: Lang, opts: { install?: string[]; test: string[] }): Runtime {
  return {
    lang,
    async provision(repoDir: string): Promise<void> {
      await ensureMise();
      const mise = resolveBin("mise");
      console.log(chalk.cyan("Trusting repo .mise.toml..."));
      await streamRun(mise, ["trust"], repoDir);
      console.log(chalk.cyan("Running `mise install`..."));
      await streamRun(mise, ["install"], repoDir);
      if (opts.install) {
        console.log(chalk.cyan(`Running \`mise exec -- ${opts.install.join(" ")}\`...`));
        await streamRun(mise, ["exec", "--", ...opts.install], repoDir);
      }
    },
    async runTests(repoDir: string): Promise<TestResult> {
      console.log(chalk.cyan(`Running \`mise exec -- ${opts.test.join(" ")}\`...`));
      return runTestsCapture(resolveBin("mise"), ["exec", "--", ...opts.test], repoDir);
    },
  };
}
