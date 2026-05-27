import chalk from "chalk";
import type { Runtime, TestResult } from "./types.js";
import { onPath, resolveBin, runTestsCapture, streamInstall, streamRun } from "./shared.js";

async function ensureUv(): Promise<void> {
  if (await onPath("uv")) return;
  console.log(chalk.yellow("uv not found. Installing uv..."));
  await streamInstall("https://astral.sh/uv/install.sh");
  if (!(await onPath("uv"))) {
    throw new Error("uv install completed but uv is still not on PATH (~/.local/bin).");
  }
}

export const pythonRuntime: Runtime = {
  lang: "python",
  async provision(repoDir: string): Promise<void> {
    await ensureUv();
    console.log(chalk.cyan("Running `uv sync`..."));
    await streamRun(resolveBin("uv"), ["sync"], repoDir);
  },
  async runTests(repoDir: string): Promise<TestResult> {
    console.log(chalk.cyan("Running `uv run pytest -q`..."));
    return runTestsCapture(resolveBin("uv"), ["run", "pytest", "-q"], repoDir);
  },
};
