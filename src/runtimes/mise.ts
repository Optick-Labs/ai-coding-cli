import type { Lang } from "../session.js";
import type { Runtime, TestResult } from "./types.js";
import { onPath, resolveBin, runTestsCapture, installScript, runCaptured, step, LANG_LABEL } from "./shared.js";

export async function ensureMise(): Promise<void> {
  if (await onPath("mise")) return;
  await installScript("https://mise.run");
  if (!(await onPath("mise"))) {
    throw new Error("mise install completed but mise is still not on PATH (~/.local/bin).");
  }
}

// Builds a Runtime for any mise-provisioned language: `mise trust` + `mise install`
// pin the toolchain, then deps/tests run through `mise exec` so the pinned runtime is
// active regardless of the candidate's shell. Each language differs only in its install
// and test commands.
export function createMiseRuntime(
  lang: Lang,
  opts: { install?: string[]; test: string[]; dev: string[] },
): Runtime {
  return {
    lang,
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
    async runTests(repoDir: string): Promise<TestResult> {
      return runTestsCapture(resolveBin("mise"), ["exec", "--", ...opts.test], repoDir);
    },
    devCommand() {
      return { command: resolveBin("mise"), args: ["exec", "--", ...opts.dev] };
    },
  };
}
