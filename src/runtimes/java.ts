import chalk from "chalk";
import type { Runtime, TestResult } from "./types.js";
import { onPath, resolveBin, runTestsCapture, streamInstall, streamRun } from "./shared.js";

async function ensureMise(): Promise<void> {
  if (await onPath("mise")) return;
  console.log(chalk.yellow("mise not found. Installing mise..."));
  await streamInstall("https://mise.run", "curl");
  if (!(await onPath("mise"))) {
    throw new Error("mise install completed but mise is still not on PATH (~/.local/bin).");
  }
}

export const javaRuntime: Runtime = {
  lang: "java",
  async provision(repoDir: string): Promise<void> {
    await ensureMise();
    console.log(chalk.cyan("Trusting repo .mise.toml..."));
    await streamRun(resolveBin("mise"), ["trust"], repoDir);
    console.log(chalk.cyan("Running `mise install`..."));
    await streamRun(resolveBin("mise"), ["install"], repoDir);
  },
  async runTests(repoDir: string): Promise<TestResult> {
    console.log(chalk.cyan("Running `mise exec -- ./mvnw -q test`..."));
    return runTestsCapture(resolveBin("mise"), ["exec", "--", "./mvnw", "-q", "test"], repoDir);
  },
};
