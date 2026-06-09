import type { Runtime, TestResult } from "./types.js";
import { onPath, resolveBin, runTestsCapture, installScript, runCaptured, step } from "./shared.js";

async function ensureUv(): Promise<void> {
  if (await onPath("uv")) return;
  await installScript("https://astral.sh/uv/install.sh");
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
