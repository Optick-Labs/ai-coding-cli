import { execa, type ExecaError } from "execa";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Lang } from "../session.js";
import type { TestResult } from "./types.js";

let VERBOSE = false;
export function setVerbose(value: boolean): void {
  VERBOSE = value;
}
export function isVerbose(): boolean {
  return VERBOSE;
}

export const LANG_LABEL: Record<Lang, string> = {
  python: "Python",
  java: "Java",
  typescript: "TypeScript",
  go: "Go",
  csharp: "C#",
};

export function localBinDir(): string {
  return join(homedir(), ".local", "bin");
}

export async function onPath(binary: string): Promise<boolean> {
  try {
    await execa("which", [binary]);
    return true;
  } catch {
    return existsSync(join(localBinDir(), binary));
  }
}

export function resolveBin(binary: string): string {
  const local = join(localBinDir(), binary);
  if (existsSync(local)) return local;
  return binary;
}

function envWithLocalBin(): NodeJS.ProcessEnv {
  const local = localBinDir();
  const existing = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: existing.includes(local) ? existing : `${local}:${existing}`,
  };
}

// Carries the captured output of a failed command so a step can surface it for debugging.
export class RunError extends Error {
  readonly output: string;
  readonly exitCode: number | null;
  constructor(output: string, exitCode: number | null) {
    super(`command exited with code ${exitCode ?? "unknown"}`);
    this.name = "RunError";
    this.output = output;
    this.exitCode = exitCode;
  }
}

// Run a command capturing its output. In --verbose mode it streams straight through; otherwise the
// output is buffered and only surfaced (via RunError) when the command fails, so provisioning stays
// quiet on the happy path.
export async function runCaptured(command: string, args: string[], cwd: string): Promise<void> {
  if (isVerbose()) {
    await execa(command, args, { cwd, stdio: "inherit", env: envWithLocalBin() });
    return;
  }
  const result = await execa(command, args, { cwd, all: true, reject: false, env: envWithLocalBin() });
  if (result.exitCode !== 0) {
    throw new RunError(result.all ?? "", result.exitCode ?? null);
  }
}

// Bootstrap a toolchain manager (uv / mise) by piping its official install script into sh. Captured
// like any other step unless --verbose.
export async function installScript(scriptUrl: string): Promise<void> {
  await runCaptured("sh", ["-c", `curl -LsSf ${scriptUrl} | sh`], process.cwd());
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// ESC[K — clears from the cursor to end of line. Built from the char code to keep a raw escape byte
// out of the source.
const ERASE_LINE = String.fromCharCode(27) + "[K";

export interface Spinner {
  succeed(): void;
  fail(): void;
}

// A single-line progress indicator that collapses to a ✓/✗ line when done. Falls back to plain lines
// when stdout isn't a TTY (CI, piped output) so logs stay readable.
export function startSpinner(label: string): Spinner {
  if (!process.stdout.isTTY) {
    return {
      succeed: () => console.log(`  ${chalk.green("✓")} ${label}`),
      fail: () => console.log(`  ${chalk.red("✗")} ${label}`),
    };
  }
  let i = 0;
  process.stdout.write(`  ${chalk.cyan(SPINNER_FRAMES[0] ?? "")} ${label}`);
  const timer = setInterval(() => {
    i = (i + 1) % SPINNER_FRAMES.length;
    process.stdout.write(`\r  ${chalk.cyan(SPINNER_FRAMES[i] ?? "")} ${label}`);
  }, 80);
  const stop = () => {
    clearInterval(timer);
    process.stdout.write(`\r${ERASE_LINE}`);
  };
  return {
    succeed: () => {
      stop();
      console.log(`  ${chalk.green("✓")} ${label}`);
    },
    fail: () => {
      stop();
      console.log(`  ${chalk.red("✗")} ${label}`);
    },
  };
}

// Run an async step under a spinner. On failure, surface the captured command output (if any) so the
// candidate can still debug, then rethrow. In --verbose mode the work streams under a plain header.
export async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (isVerbose()) {
    console.log(chalk.cyan(`▸ ${label}…`));
    return fn();
  }
  const spinner = startSpinner(label);
  try {
    const result = await fn();
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail();
    if (error instanceof RunError && error.output.trim().length > 0) {
      process.stdout.write("\n" + chalk.dim(error.output.trim()) + "\n\n");
    }
    throw error;
  }
}

// Spawns a long-running foreground process (the dev server) and returns the execa child handle so the
// caller can await it, read its exit code/signal, and kill it. `reject: false` so a non-zero/ signalled
// exit resolves rather than throwing; `cleanup: true` (execa default) kills the child if we exit first.
export function spawnStreaming(
  command: string,
  args: string[],
  cwd: string,
  envOverrides?: NodeJS.ProcessEnv,
) {
  return execa(command, args, {
    cwd,
    stdio: "inherit",
    reject: false,
    env: { ...envWithLocalBin(), ...envOverrides },
  });
}

// Capture a test run without printing — callers decide how to surface it (full output for `byoe test`
// and `submit`, a quiet ✓/✗ for the baseline run during `start`). Unbounded by default; pass
// `timeoutMs` only where a hang would block something (the submit path), so a runaway suite is killed
// and reported as a clean timeout instead of stalling. Other call sites (start, `byoe test`) stay
// unbounded — a candidate iterating locally can take as long as they want.
export async function runTestsCapture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<TestResult> {
  try {
    const result = await execa(command, args, {
      cwd,
      all: true,
      env: envWithLocalBin(),
      reject: false,
      timeout: timeoutMs,
    });
    const output = result.all ?? "";
    if (result.timedOut && timeoutMs) {
      const seconds = Math.round(timeoutMs / 1000);
      const notice = `\n\nTest run timed out after ${seconds}s and was stopped.`;
      return {
        passed: false,
        output: output.trim().length > 0 ? output + notice : notice.trimStart(),
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? undefined,
        timedOut: true,
      };
    }
    return {
      passed: result.exitCode === 0,
      output,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? undefined,
    };
  } catch (error) {
    const execaError = error as ExecaError;
    const output =
      (typeof execaError.all === "string" ? execaError.all : undefined) ??
      execaError.message ??
      String(error);
    return { passed: false, output, exitCode: null };
  }
}
