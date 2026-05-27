import type { Lang } from "../session.js";

export interface TestResult {
  passed: boolean;
  output: string;
}

export interface Runtime {
  lang: Lang;
  provision(repoDir: string): Promise<void>;
  runTests(repoDir: string): Promise<TestResult>;
}
