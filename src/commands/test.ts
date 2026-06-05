import chalk from "chalk";
import { findSession } from "../session.js";
import { getRuntime } from "../runtimes/index.js";
import { pingEvent } from "./events.js";

export async function testCommand(): Promise<void> {
  const { session, repoDir } = await findSession(process.cwd());
  const runtime = getRuntime(session.lang);

  const startedAt = Date.now();
  const result = await runtime.runTests(repoDir);
  const durationMs = Date.now() - startedAt;

  if (result.output.trim().length > 0) {
    process.stdout.write(result.output.trim() + "\n");
  }

  console.log(result.passed ? chalk.bold.green("\nTests passed.") : chalk.bold.red("\nTests failed."));

  await pingEvent(session, {
    type: "TEST_RUN",
    passed: result.passed,
    exitCode: result.exitCode ?? undefined,
    durationMs,
  });

  process.exitCode = result.passed ? 0 : 1;
}
