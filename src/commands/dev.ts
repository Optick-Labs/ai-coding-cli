import chalk from "chalk";
import { findSession } from "../session.js";
import { getRuntime } from "../runtimes/index.js";
import { spawnStreaming } from "../runtimes/shared.js";
import { findFreePort, waitForPort } from "../net.js";
import { pingEvent } from "./events.js";

const DEFAULT_PORT = 8080;
// Generous so a cold JVM / dotnet build (Spring Boot, `dotnet run`) still binds before we give up —
// a short window would silently miss the DEV_SERVER signal for the slower-starting runtimes.
const READY_TIMEOUT_MS = 45_000;

export interface DevOptions {
  port?: string;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const trimmed = raw.trim();
  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || String(port) !== trimmed) {
    throw new Error(`--port must be a whole number (got "${raw}").`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(`--port must be between 1 and 65535 (got ${port}).`);
  }
  return port;
}

export async function devCommand(options: DevOptions): Promise<void> {
  const { session, repoDir } = await findSession(process.cwd());
  const runtime = getRuntime(session.lang);

  const requested = parsePort(options.port);
  if (requested < 1024) {
    console.log(chalk.dim(`Note: port ${requested} is privileged and may require elevated permissions.`));
  }

  const port = await findFreePort(requested);
  if (port !== requested) {
    console.log(chalk.yellow(`Port ${requested} is busy — using ${port} instead.`));
  }

  const { command, args } = runtime.devCommand();
  console.log(chalk.bold.green(`\nDev server: http://127.0.0.1:${port}`));
  console.log(chalk.dim("Press Ctrl+C to stop.\n"));

  const child = spawnStreaming(command, args, repoDir, { PORT: String(port) });

  // Only record DEV_SERVER once the port actually accepts a connection, so a spawn failure or instant
  // crash doesn't log a false "they ran the server". Race readiness against the child exiting.
  const outcome = await Promise.race<{ kind: "ready"; ok: boolean } | { kind: "exited" }>([
    waitForPort(port, READY_TIMEOUT_MS).then((ok) => ({ kind: "ready", ok })),
    child.then(() => ({ kind: "exited" })),
  ]);
  if (outcome.kind === "ready" && outcome.ok) {
    void pingEvent(session, { type: "DEV_SERVER", port });
  }

  // We deliberately don't trap SIGINT: the terminal delivers it to the whole foreground process group
  // (the child included), and execa's `cleanup` kills the child if we somehow exit first. Just wait and
  // mirror the child's exit so the shell sees the right code.
  const result = await child;
  if (result.signal === "SIGINT") {
    process.exitCode = 130;
  } else if (result.signal === "SIGTERM") {
    process.exitCode = 143;
  } else {
    process.exitCode = result.exitCode ?? 0;
  }
}
