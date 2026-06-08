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
  provision(repoDir: string): Promise<void>;
  // `timeoutMs` bounds the run (used on submit so a hanging suite can't stall it); omit for an
  // unbounded run during local iteration.
  runTests(repoDir: string, timeoutMs?: number): Promise<TestResult>;
  // The resolved command to start the project's dev server. The caller injects `PORT` into the env.
  devCommand(): { command: string; args: string[] };
}
