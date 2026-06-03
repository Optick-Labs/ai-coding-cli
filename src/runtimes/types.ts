import type { Lang } from "../session.js";

export interface TestResult {
  passed: boolean;
  output: string;
  exitCode: number | null;
  signal?: string;
}

export interface Runtime {
  lang: Lang;
  provision(repoDir: string): Promise<void>;
  runTests(repoDir: string): Promise<TestResult>;
  // The resolved command to start the project's dev server. The caller injects `PORT` into the env.
  devCommand(): { command: string; args: string[] };
}
