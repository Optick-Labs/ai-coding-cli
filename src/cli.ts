import { Command } from "commander";
import chalk from "chalk";
import { chatCommand } from "./commands/chat.js";
import { recordCommand } from "./commands/record.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { submitCommand } from "./commands/submit.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("hello-interview")
    .description("Local coding-practice bootstrap CLI for Hello Interview")
    .version("0.1.0");

  program
    .command("start")
    .description("Clone a seed repo, provision the runtime, and start a timed session")
    .argument("[task]", "task slug for offline mode (e.g. booking); omit when using --token")
    .option("--token <token>", "session token from hellointerview.com")
    .option("--lang <lang>", "language: python | java | typescript | go | csharp (offline mode)")
    .option("--seed <url-or-path>", "override seed repo source (offline mode)")
    .action(async (task: string | undefined, options: { token?: string; lang?: string; seed?: string }) => {
      await startCommand(task, options);
    });

  program
    .command("status")
    .description("Show time remaining and changes since baseline for the current session")
    .action(async () => {
      await statusCommand();
    });

  program
    .command("submit")
    .description("Bundle the diff, re-run tests, and finalize the session")
    .action(async () => {
      await submitCommand();
    });

  program
    .command("chat")
    .description("Attach AI chat logs (Claude Code, Codex) from this session")
    .action(async () => {
      await chatCommand();
    });

  // Internal: the background timeline recorder, spawned detached by `start`. Not for direct use.
  program
    .command("__record", { hidden: true })
    .action(async () => {
      await recordCommand();
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`\nError: ${message}`));
  process.exitCode = 1;
});
