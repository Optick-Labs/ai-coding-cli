import { execa, type ExecaError } from "execa";
import chalk from "chalk";
import type { Lang } from "../session.js";
import type { TestResult } from "./types.js";
import { envWithManagedBin } from "./install.js";
import { mvnwPathFor } from "./platform.js";

// The cross-platform toolchain path helpers live in install.ts (next to the installer that populates the
// managed bin dir). Re-exported here so the runtimes keep importing them from one place.
export { managedBinDir, onPath, resolveBin } from "./install.js";

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
  any: "Any language",
};

// The Maven wrapper ships as a POSIX shell script (`mvnw`) and a Windows batch file (`mvnw.cmd`); both
// live in the seed. Resolve the right one as an explicit absolute path in the repo so what we invoke is
// obvious from the call site (rather than relying on cross-spawn's cwd resolution).
export function mvnwPath(repoDir: string): string {
  return mvnwPathFor(process.platform, repoDir);
}

// Carries the captured output of a failed command so a step can surface it for debugging.
export class RunError extends Error {
  readonly output: string;
  readonly exitCode: number | null;
  // The signal that killed the command, if any (e.g. "SIGKILL"). Null on a normal non-zero exit. A
  // SIGKILL during provisioning is the macOS endpoint-security failure mode, so carrying it makes that
  // class legible in the message and in start telemetry instead of surfacing as "exited with code unknown".
  readonly signal: string | null;
  // The command that failed (e.g. `uv sync`). Carried so start telemetry can point at the exact step
  // that broke, which is almost always a provisioning command.
  readonly command: string;
  constructor(output: string, exitCode: number | null, command: string, signal: string | null = null) {
    super(signal ? `command was killed by ${signal}` : `command exited with code ${exitCode ?? "unknown"}`);
    this.name = "RunError";
    this.output = output;
    this.exitCode = exitCode;
    this.signal = signal;
    this.command = command;
  }
}

// Run a command capturing its output. In --verbose mode it streams straight through; otherwise the
// output is buffered and only surfaced (via RunError) when the command fails, so provisioning stays
// quiet on the happy path. `envOverrides` is merged on top of the local-bin PATH env (used to pin the
// toolchain installer version, e.g. MISE_VERSION).
export async function runCaptured(
  command: string,
  args: string[],
  cwd: string,
  envOverrides?: NodeJS.ProcessEnv,
): Promise<void> {
  const env = { ...envWithManagedBin(), ...envOverrides };
  const commandLine = `${command} ${args.join(" ")}`.trim();
  if (isVerbose()) {
    // Streamed to the user, but still convert a failure to a RunError so the signal (e.g. SIGKILL) and
    // its dedicated UX survive --verbose. Output isn't captured here — the user already saw it live.
    try {
      await execa(command, args, { cwd, stdio: "inherit", env });
    } catch (error) {
      const e = error as ExecaError;
      throw new RunError("", e.exitCode ?? null, commandLine, e.signal ?? null);
    }
    return;
  }
  const result = await execa(command, args, { cwd, all: true, reject: false, env });
  if (result.exitCode !== 0 || result.signal) {
    throw new RunError(result.all ?? "", result.exitCode ?? null, commandLine, result.signal ?? null);
  }
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
    if (error instanceof RunError && error.signal === "SIGKILL") {
      process.stdout.write(
        chalk.yellow(
          "\nThat setup step was killed by the system (SIGKILL). This is usually endpoint-security software,\n" +
            "antivirus, or macOS Gatekeeper interfering with a freshly downloaded tool — not a bug in the tool.\n",
        ) +
          chalk.dim(
            "  Try re-running the command. If it keeps happening, allowlist the toolchain (or ask IT), then retry.\n" +
              "  Re-run with --verbose for the full log.\n\n",
          ),
      );
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
    env: { ...envWithManagedBin(), ...envOverrides },
  });
}

// Capture a test run without printing — callers decide how to surface it (full output for `ai-coding test`
// and `submit`, a quiet ✓/✗ for the baseline run during `start`). Unbounded by default; pass
// `timeoutMs` only where a hang would block something (the submit path), so a runaway suite is killed
// and reported as a clean timeout instead of stalling. Other call sites (start, `ai-coding test`) stay
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
      env: envWithManagedBin(),
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
