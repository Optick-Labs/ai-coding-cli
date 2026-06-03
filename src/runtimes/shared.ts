import { execa, type ExecaError } from "execa";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { TestResult } from "./types.js";

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

export async function streamRun(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await execa(command, args, {
    cwd,
    stdio: "inherit",
    env: envWithLocalBin(),
  });
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

export async function streamInstall(scriptUrl: string): Promise<void> {
  await execa("sh", ["-c", `curl -LsSf ${scriptUrl} | sh`], {
    stdio: "inherit",
    env: envWithLocalBin(),
  });
}

export async function runTestsCapture(
  command: string,
  args: string[],
  cwd: string,
): Promise<TestResult> {
  try {
    const result = await execa(command, args, {
      cwd,
      all: true,
      env: envWithLocalBin(),
      reject: false,
    });
    const output = result.all ?? "";
    process.stdout.write(output + "\n");
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
    process.stdout.write(chalk.red(output) + "\n");
    return { passed: false, output, exitCode: null };
  }
}
