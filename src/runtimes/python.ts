import type { Runtime, TestResult } from "./types.js";
import { onPath, resolveBin, runTestsCapture, installScript, runCaptured, step } from "./shared.js";

// Pinned so a fresh install gets a known, reviewed uv rather than whatever is latest the day a
// candidate runs it. Only affects machines without uv already on PATH. Bump periodically.
const UV_VERSION = "0.11.21";

async function ensureUv(): Promise<void> {
  if (await onPath("uv")) return;
  await installScript(`https://astral.sh/uv/${UV_VERSION}/install.sh`);
  if (!(await onPath("uv"))) {
    throw new Error("uv install completed but uv is still not on PATH (~/.local/bin).");
  }
}

export const pythonRuntime: Runtime = {
  lang: "python",
  selfDirected: false,
  async provision(repoDir: string): Promise<void> {
    await step("Toolchain manager ready", ensureUv);
    await step("Python toolchain + dependencies installed", () =>
      runCaptured(resolveBin("uv"), ["sync"], repoDir),
    );
  },
  async runTests(repoDir: string, timeoutMs?: number): Promise<TestResult> {
    return runTestsCapture(resolveBin("uv"), ["run", "pytest", "-q"], repoDir, timeoutMs);
  },
  devCommand() {
    return { command: resolveBin("uv"), args: ["run", "python", "app.py"] };
  },
};
