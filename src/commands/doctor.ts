import chalk from "chalk";
import { runDoctorChecks } from "../preflight.js";

// `npx @hellointerview/ai-coding doctor` — the support tool. Runs the same checks as `start`'s preflight
// but in report-all mode, printing a ✓/✗ table plus environment context. Sends no telemetry (it's a
// diagnostic, often run offline) and exits non-zero if any hard check failed.
export async function doctorCommand(): Promise<void> {
  const results = await runDoctorChecks();
  console.log(chalk.bold("\nHello Interview AI-coding — environment check\n"));
  for (const r of results) {
    const mark = r.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${mark} ${r.label.padEnd(24)} ${chalk.dim(r.detail)}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(chalk.red(`\n${failed.length} check(s) failed. Fix the above and re-run.\n`));
    process.exitCode = 1;
  } else {
    console.log(chalk.green("\nAll checks passed — you're ready to start a session.\n"));
  }
}
