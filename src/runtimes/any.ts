import type { Runtime, TestResult } from "./types.js";

// The "any" runtime backs build-from-scratch tasks: the candidate picks their own language and
// tooling, so there's nothing for us to provision and no built-in test/dev runner. The command
// handlers branch on `selfDirected` and never actually call these methods — they exist only to
// satisfy the Runtime interface. `byoe submit` still captures the whole working tree as a diff.
export const anyRuntime: Runtime = {
  lang: "any",
  selfDirected: true,
  async provision(): Promise<void> {
    // Nothing to set up.
  },
  async runTests(): Promise<TestResult> {
    return { passed: true, output: "", exitCode: null };
  },
  devCommand() {
    return { command: "true", args: [] };
  },
};
