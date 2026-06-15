import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, arch as osArch, platform, release } from "node:os";
import chalk from "chalk";
import { postByoeStartDiagnostic, type ByoeStartDiagnosticPayload, type ByoeStartPhase } from "../api.js";
import { CLI_VERSION } from "../version.js";

const SEND_TIMEOUT_MS = 2500;
const MAX_OUTPUT_TAIL = 8_000;
const MAX_ERROR_MESSAGE = 2_000;
const LOCAL_LOG = "ai-coding-start-debug.log";

// Operational telemetry is opt-out: honor an explicit HI_TELEMETRY=0 or the cross-tool DO_NOT_TRACK
// convention. Only gates the network report, never the local debug log (that one helps the user).
function telemetryDisabled(): boolean {
  return process.env.HI_TELEMETRY === "0" || process.env.DO_NOT_TRACK === "1";
}

// One-time marker so the telemetry notice shows once per machine, not every run.
function telemetryAckPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "hellointerview-ai-coding", "telemetry-ack");
}

// Scrub anything we wouldn't want in a telemetry payload or the local debug log: the user's home dir
// (→ ~, so a path can't leak a username), the session token, and credentials embedded in a URL.
function redact(text: string, token?: string): string {
  let out = text;
  const home = homedir();
  if (home) out = out.split(home).join("~");
  if (token && token.length > 0) out = out.split(token).join("***");
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]+)?@/g, "$1***@");
  return out;
}

// An error with a specific telemetry kind. Use for failures that are the user's environment rather
// than our setup pipeline (e.g. "DirectoryExists"), so the failure-rate dashboard can split
// our-fault from their-fault on `errorKind` instead of parsing messages.
export function namedError(kind: string, message: string): Error {
  const error = new Error(message);
  error.name = kind;
  return error;
}

interface RunErrorLike {
  name: string;
  message: string;
  output?: string;
  exitCode?: number | null;
  command?: string;
  status?: number;
}

type ErrorFields = Pick<
  ByoeStartDiagnosticPayload,
  "errorKind" | "errorMessage" | "errorCommand" | "exitCode" | "outputTail"
>;

// Tracks how far `start` got and how long each phase took, then reports the outcome exactly once.
// Construct it with the session's token to enable the network report; without a token (offline mode)
// it stays local-only. Wrap each phase with `phase()`; call `success`, `baselineFailed`, or
// `failure` exactly once at the end.
export class StartTelemetry {
  private timings: Record<string, number> = {};
  private furthest: ByoeStartPhase = "RESOLVE_SESSION";
  private readonly online: boolean;

  constructor(private readonly opts: { token?: string; apiBaseUrl?: string }) {
    this.online = Boolean(opts.token && opts.apiBaseUrl);
  }

  // Print a one-time notice that operational telemetry is on, but only when we'd actually send it
  // (online and not opted out). Marker-gated so repeat runs stay quiet; fails open — if the marker
  // can't be read or written, we just show the notice again rather than going silent.
  async announceOnce(): Promise<void> {
    if (!this.online || telemetryDisabled()) return;
    const markerPath = telemetryAckPath();
    if (existsSync(markerPath)) return;
    console.error(
      chalk.dim(
        "Sending setup diagnostics (OS, Node/CLI version, and any failure output) to hellointerview.com " +
          "to debug provisioning. They're linked to your session; the session token itself is stripped " +
          "from the report. Opt out anytime with HI_TELEMETRY=0 or DO_NOT_TRACK=1.",
      ),
    );
    try {
      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(markerPath, `${new Date().toISOString()}\n`, "utf8");
    } catch {
      // Can't persist the marker (read-only home, etc.) — fine, we'll just show the notice again.
    }
  }

  async phase<T>(phase: ByoeStartPhase, fn: () => Promise<T>): Promise<T> {
    this.furthest = phase;
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.timings[phase.toLowerCase()] = Date.now() - startedAt;
    }
  }

  // The whole start completed and the seed's baseline tests passed. Awaited by the caller like the
  // failure path: the send is bounded by SEND_TIMEOUT_MS, and a guaranteed success row is what makes
  // the failure rate a real rate (the denominator can't silently drop out).
  async success(): Promise<void> {
    await this.send({ ok: true, phase: "FINALIZE", ...this.base() });
  }

  // Start completed (session is usable) but the seed shipped a failing baseline — a seed regression we
  // want to see in the wild, distinct from a hard crash via `errorKind`. No local breadcrumb here, the
  // failure is already shown inline and the session works.
  async baselineFailed(output: string): Promise<void> {
    await this.send({
      ok: false,
      phase: "BASELINE_TESTS",
      errorKind: "BaselineTestsFailed",
      errorMessage: "seed baseline tests failed at start",
      errorCommand: null,
      exitCode: null,
      outputTail: output.trim() ? redact(output, this.opts.token).slice(-MAX_OUTPUT_TAIL) : null,
      ...this.base(),
    });
  }

  // Start threw. Records the furthest phase reached plus the error detail, and drops a local debug log
  // as a fallback for when the network report can't land (offline, or the failure is the network).
  async failure(error: unknown): Promise<void> {
    await this.report({ ok: false, phase: this.furthest, ...this.extractError(error), ...this.base() });
  }

  private base() {
    return {
      durationMs: Object.values(this.timings).reduce((a, b) => a + b, 0),
      phaseTimings: this.timings,
      cliVersion: CLI_VERSION,
      nodeVersion: process.version,
      os: `${platform()} ${release()}`,
      arch: osArch(),
    };
  }

  // errorKind taxonomy, the field dashboards GROUP BY:
  //   - "RunError"            a toolchain command failed (the real setup breaks; outputTail has the log)
  //   - "ApiError:<status>"   the control plane said no — 401/403 is a bad or expired token (user-side),
  //                           5xx is on us
  //   - "DirectoryExists"     (via namedError) user-environment errors, not pipeline failures
  //   - "BaselineTestsFailed" a seed regression (set by baselineFailed, never here)
  //   - anything else         the error's constructor/assigned name, e.g. "TypeError"
  private extractError(error: unknown): ErrorFields {
    if (error instanceof Error) {
      const e = error as Error & Partial<RunErrorLike>;
      const isRunError = e.name === "RunError";
      const isApiError = e.name === "ApiError" && typeof e.status === "number";
      return {
        errorKind: isApiError ? `ApiError:${e.status}` : e.name || "Error",
        errorMessage: redact(e.message, this.opts.token).slice(0, MAX_ERROR_MESSAGE),
        errorCommand: e.command ? redact(e.command, this.opts.token).slice(0, 200) : null,
        exitCode: typeof e.exitCode === "number" ? e.exitCode : null,
        outputTail: isRunError && e.output ? redact(e.output, this.opts.token).slice(-MAX_OUTPUT_TAIL) : null,
      };
    }
    return {
      errorKind: "Unknown",
      errorMessage: redact(String(error), this.opts.token).slice(0, MAX_ERROR_MESSAGE),
      errorCommand: null,
      exitCode: null,
      outputTail: null,
    };
  }

  // Failure path: local breadcrumb first (always useful, never tracking), then the best-effort send.
  private async report(payload: ByoeStartDiagnosticPayload): Promise<void> {
    await this.writeLocalLog(payload);
    await this.send(payload);
  }

  private async send(payload: ByoeStartDiagnosticPayload): Promise<void> {
    if (!this.online || telemetryDisabled()) return;
    try {
      await postByoeStartDiagnostic(this.opts.apiBaseUrl!, this.opts.token!, payload, SEND_TIMEOUT_MS);
    } catch {
      // best-effort — telemetry never breaks start
    }
  }

  private async writeLocalLog(payload: ByoeStartDiagnosticPayload): Promise<void> {
    const lines = [
      `[${new Date().toISOString()}] ai-coding start failed`,
      `phase: ${payload.phase}  kind: ${payload.errorKind ?? "(none)"}`,
      `cli: ${payload.cliVersion}  node: ${payload.nodeVersion}  os: ${payload.os} ${payload.arch}`,
      payload.errorCommand ? `command: ${payload.errorCommand}` : null,
      payload.exitCode !== null && payload.exitCode !== undefined ? `exitCode: ${payload.exitCode}` : null,
      `error: ${payload.errorMessage ?? "(none)"}`,
      payload.outputTail ? `--- output tail ---\n${payload.outputTail}` : null,
      "",
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
    try {
      await appendFile(join(process.cwd(), LOCAL_LOG), lines + "\n", "utf8");
    } catch {
      // can't write the breadcrumb (read-only cwd) — nothing else to do
    }
  }
}

export const LOCAL_LOG_NAME = LOCAL_LOG;
