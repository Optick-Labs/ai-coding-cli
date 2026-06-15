import type { Lang } from "../session.js";

export interface TestResult {
  passed: boolean;
  output: string;
  exitCode: number | null;
  signal?: string;
  timedOut?: boolean;
}

export interface Runtime {
  lang: Lang;
  // True only on the "any" runtime: a build-from-scratch task with no managed toolchain. The command
  // handlers branch on this to skip provisioning and to tell the candidate to use their own
  // test/dev tools rather than pretending there's a built-in runner. Required (not optional) so
  // every new runtime declares it explicitly instead of silently defaulting.
  selfDirected: boolean;
  provision(repoDir: string): Promise<void>;
  // `timeoutMs` bounds the run (used on submit so a hanging suite can't stall it); omit for an
  // unbounded run during local iteration.
  runTests(repoDir: string, timeoutMs?: number): Promise<TestResult>;
  // The resolved command to start the project's dev server. The caller injects `PORT` into the env.
  // Receives the repo dir so a runtime can resolve a per-seed entrypoint (e.g. the C# startup project,
  // whose name differs per problem) instead of hardcoding one seed's layout.
  devCommand(repoDir: string): { command: string; args: string[] };
}
