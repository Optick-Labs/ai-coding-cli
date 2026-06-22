import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { arch as osArch, platform, release } from "node:os";
import { managedBinDir, onPath } from "./runtimes/install.js";
import { namedError } from "./commands/start-telemetry.js";
import { CLI_VERSION } from "./version.js";

const NODE_MIN_MAJOR = 22;

export interface CheckResult {
  // A user-facing label, e.g. "Git installed".
  label: string;
  ok: boolean;
  // One line of context: where the tool was found, the detected version, or the failure + fix hint.
  detail: string;
  // Set on failure; becomes the telemetry errorKind (a user-environment bucket, like DirectoryExists).
  errorKind?: string;
}

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
}

async function checkGit(): Promise<CheckResult> {
  const ok = await onPath("git");
  return {
    label: "Git installed",
    ok,
    detail: ok
      ? "found on PATH"
      : "Git is required to set up a session. Install it from https://git-scm.com/downloads, then reopen your terminal.",
    errorKind: "GitMissing",
  };
}

function checkNode(): CheckResult {
  const major = nodeMajor();
  const ok = major >= NODE_MIN_MAJOR;
  return {
    label: `Node ${NODE_MIN_MAJOR}+`,
    ok,
    detail: ok
      ? `running Node ${process.versions.node}`
      : `Node ${process.versions.node} is too old. Install Node ${NODE_MIN_MAJOR}+ from https://nodejs.org and retry.`,
    errorKind: "NodeTooOld",
  };
}

async function checkWritable(dir: string, label: string, errorKind: string, hint: string): Promise<CheckResult> {
  try {
    await access(dir, constants.W_OK);
    return { label, ok: true, detail: `writable (${dir})` };
  } catch {
    return { label, ok: false, detail: `${hint} (${dir})`, errorKind };
  }
}

async function checkBinDirWritable(): Promise<CheckResult> {
  const dir = managedBinDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // fall through to the access check, which produces the user-facing failure
  }
  return checkWritable(
    dir,
    "Toolchain dir writable",
    "BinDirNotWritable",
    "Can't write the toolchain directory. Check its permissions or free space",
  );
}

async function checkCwdWritable(): Promise<CheckResult> {
  return checkWritable(
    process.cwd(),
    "Current folder writable",
    "CwdNotWritable",
    "This folder isn't writable. cd into a directory you own and retry",
  );
}

function firstFailure(results: CheckResult[]): void {
  const failed = results.find((r) => !r.ok);
  if (failed) throw namedError(failed.errorKind ?? "PreflightFailed", failed.detail);
}

// Run before session resolution on every `start`. Cheap, deterministic, host-only checks — NO network
// reachability probes (a blocked HEAD with a working GET would only produce false failures; the real
// download / API call is the honest test). Throws the first failure as a namedError so it lands in its
// own telemetry bucket and prints an actionable message.
export async function preflightGeneric(): Promise<void> {
  firstFailure([await checkGit(), checkNode(), await checkCwdWritable()]);
}

// Run after the language is known, only for tasks that provision a managed toolchain ("any" tasks build
// from scratch and never touch the managed bin dir, so this is skipped for them).
export async function preflightRuntime(opts: { selfDirected: boolean }): Promise<void> {
  if (opts.selfDirected) return;
  firstFailure([await checkBinDirWritable()]);
}

// Report-all (never throws): backs the `doctor` command. Includes the environment context rows up top so
// a support paste shows os/arch/node/cli at a glance.
export async function runDoctorChecks(): Promise<CheckResult[]> {
  return [
    { label: "Environment", ok: true, detail: `${platform()} ${release()} ${osArch()}` },
    { label: "CLI version", ok: true, detail: CLI_VERSION },
    await checkGit(),
    checkNode(),
    await checkCwdWritable(),
    await checkBinDirWritable(),
    await toolRow("mise"),
    await toolRow("uv"),
  ];
}

async function toolRow(tool: "mise" | "uv"): Promise<CheckResult> {
  const ok = await onPath(tool);
  return {
    label: `${tool} available`,
    ok,
    detail: ok ? "resolved" : `not installed yet (will be set up on first ${tool}-backed session)`,
  };
}
