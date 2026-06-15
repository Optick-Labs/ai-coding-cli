import type { Runtime, TestResult } from "./types.js";

// The "any" runtime backs build-from-scratch tasks: the candidate picks their own language and
// tooling, so there's nothing for us to provision and no built-in test/dev runner. The command
// handlers branch on `selfDirected` before ever touching these methods; runTests/devCommand throw
// so a future call path that forgets the branch fails loudly instead of faking a green run.
// `ai-coding submit` still captures the whole working tree as a diff.
export const anyRuntime: Runtime = {
  lang: "any",
  selfDirected: true,
  async provision(): Promise<void> {
    // Nothing to set up.
  },
  async runTests(): Promise<TestResult> {
    throw new Error("self-directed task has no built-in test runner");
  },
  devCommand(): never {
    throw new Error("self-directed task has no built-in dev server");
  },
};
