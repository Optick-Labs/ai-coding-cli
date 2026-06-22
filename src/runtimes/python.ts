import type { Runtime, TestResult } from "./types.js";
import { onPath, resolveBin, runTestsCapture, runCaptured, step, managedBinDir } from "./shared.js";
import { installTool } from "./install.js";

async function ensureUv(): Promise<void> {
  await installTool("uv");
  if (!(await onPath("uv"))) {
    throw new Error(`uv install completed but uv is still not runnable (${managedBinDir()}).`);
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
