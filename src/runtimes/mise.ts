import type { Lang } from "../session.js";
import type { Runtime, TestResult } from "./types.js";
import { resolveBin, runTestsCapture, runCaptured, step, LANG_LABEL, managedBinDir, onPath } from "./shared.js";
import { installTool } from "./install.js";

export async function ensureMise(): Promise<void> {
  await installTool("mise");
  if (!(await onPath("mise"))) {
    throw new Error(`mise install completed but mise is still not runnable (${managedBinDir()}).`);
  }
}

// Builds a Runtime for any mise-provisioned language: `mise trust` + `mise install`
// pin the toolchain, then deps/tests run through `mise exec` so the pinned runtime is
// active regardless of the candidate's shell. Each language differs only in its install
// and test commands.
export function createMiseRuntime(
  lang: Lang,
  opts: {
    install?: string[];
    test: string[] | ((repoDir: string) => string[]);
    dev: string[] | ((repoDir: string) => string[]);
  },
): Runtime {
  return {
    lang,
    selfDirected: false,
    async provision(repoDir: string): Promise<void> {
      await step("Toolchain manager ready", ensureMise);
      const mise = resolveBin("mise");
      await step(`${LANG_LABEL[lang]} toolchain installed`, async () => {
        await runCaptured(mise, ["trust"], repoDir);
        await runCaptured(mise, ["install"], repoDir);
      });
      const installCmd = opts.install;
      if (installCmd) {
        await step("Dependencies installed", () =>
          runCaptured(mise, ["exec", "--", ...installCmd], repoDir),
        );
      }
    },
    async runTests(repoDir: string, timeoutMs?: number): Promise<TestResult> {
      const test = typeof opts.test === "function" ? opts.test(repoDir) : opts.test;
      return runTestsCapture(resolveBin("mise"), ["exec", "--", ...test], repoDir, timeoutMs);
    },
    devCommand(repoDir: string) {
      const dev = typeof opts.dev === "function" ? opts.dev(repoDir) : opts.dev;
      return { command: resolveBin("mise"), args: ["exec", "--", ...dev] };
    },
  };
}
