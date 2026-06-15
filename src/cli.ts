import { Command } from "commander";
import chalk from "chalk";
import { CLI_VERSION } from "./version.js";
import { chatCommand } from "./commands/chat.js";
import { devCommand } from "./commands/dev.js";
import { recordCommand } from "./commands/record.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { submitCommand } from "./commands/submit.js";
import { testCommand } from "./commands/test.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("byoe")
    .description("Local coding-practice bootstrap CLI for Hello Interview")
    .version(CLI_VERSION);

  program
    .command("start")
    .description("Clone a seed repo, provision the runtime, and start a timed session")
    .argument("[task]", "task slug for offline mode (e.g. booking); omit when using --token")
    .option("--token <token>", "session token from hellointerview.com")
    .option("--token-stdin", "read the session token from stdin (keeps it out of shell history)")
    .option("--lang <lang>", "language: python | java | typescript | go | csharp | any (offline mode)")
    .option("--seed <url-or-path>", "override seed repo source (offline mode)")
    .option("--verbose", "show full runtime provisioning output")
    .action(
      async (
        task: string | undefined,
        options: { token?: string; tokenStdin?: boolean; lang?: string; seed?: string; verbose?: boolean },
      ) => {
        await startCommand(task, options);
      },
    );

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
    .command("test")
    .description("Run the project's tests")
    .action(async () => {
      await testCommand();
    });

  program
    .command("dev")
    .description("Start the project's dev server (auto-picks a free port if the default is busy)")
    .option("--port <port>", "port to bind (default 8080)")
    .action(async (options: { port?: string }) => {
      await devCommand(options);
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
