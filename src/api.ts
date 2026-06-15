import { readFile, writeFile } from "node:fs/promises";
import chalk from "chalk";
import type { Lang } from "./session.js";

const DEFAULT_API = "https://www.hellointerview.com";

// Bounds the bulk seed/artifact/chat transfers so a stalled socket can't hang the CLI forever.
// Generous (and overridable) so a slow-but-live connection on a big bundle isn't cut off.
function transferTimeoutMs(): number {
  const override = Number.parseInt(process.env.HI_TRANSFER_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(override) && override > 0 ? override : 120_000;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

// Resolves the control-plane base URL, defaulting to production. An override (flag or HI_API_URL) is
// honored for staging/local dev, but guarded: the bearer token rides on every request, so we refuse to
// send it over plaintext http to anywhere but loopback, and we warn loudly if a poisoned environment
// has redirected it off hellointerview.com. A bad URL fails fast instead of silently misbehaving.
export function apiBaseUrl(override?: string): string {
  const raw = (override ?? process.env.HI_API_URL ?? DEFAULT_API).trim();
  if (!raw || raw === DEFAULT_API) return DEFAULT_API;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid API base URL "${raw}". Set HI_API_URL to a full https:// URL.`);
  }

  const loopback = isLoopback(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      `Refusing to use insecure API base URL "${raw}". The session token is only sent over https:// ` +
        `(http:// is allowed for localhost only).`,
    );
  }

  const host = url.hostname.toLowerCase();
  if (host !== "hellointerview.com" && !host.endsWith(".hellointerview.com") && !loopback) {
    console.error(
      chalk.yellow(
        `⚠  HI_API_URL points at ${url.host}, not hellointerview.com — your session token will be sent there.`,
      ),
    );
  }

  return raw.replace(/\/+$/, "");
}

export interface RemoteSession {
  id: string;
  task: string;
  // Folder name to clone into, matching the problem the candidate sees (e.g. "schedulr"). Optional so an
  // older server that doesn't send it still works — the CLI falls back to the task slug.
  repoName?: string;
  language: Lang;
  startedAt: string | null;
  deadline: string | null;
  remainingSeconds: number | null;
  status: string;
  baselineSha: string | null;
  submittedAt: string | null;
}

export interface SessionClock {
  startedAt: string;
  deadline: string;
  remainingSeconds: number;
  status: string;
  thinkAloudConsent?: boolean;
}

export interface SubmitPayload {
  baselineSha: string;
  // Omitted now that tests run after the submission is recorded — the result lands later via a
  // TEST_RUN event so a slow/hanging suite can't block the submit.
  testsPassedLocal?: boolean;
  diff?: string;
  submittedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SubmitResult {
  status: string;
  submittedAt: string;
  overTime: boolean;
  testsPassedLocal: boolean | null;
  debriefUrl?: string;
  cockpitUrl?: string;
}

// A non-2xx from the control plane. Typed (rather than a bare Error) so start telemetry can split
// user-side failures (401/403 — a bad or expired token) from server-side ones (5xx) by status.
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(path: string, status: number, body: string) {
    super(`${path} failed (${status})${body ? `: ${body}` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

async function request(base: string, path: string, token: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(path, res.status, text);
  }
  return res;
}

export async function fetchSession(base: string, token: string): Promise<RemoteSession> {
  const res = await request(base, "/api/byoe/session", token, { method: "GET" });
  return (await res.json()) as RemoteSession;
}

export async function startSessionClock(base: string, token: string): Promise<SessionClock> {
  const res = await request(base, "/api/byoe/session/start", token, { method: "POST" });
  return (await res.json()) as SessionClock;
}

export async function fetchSeedUrl(base: string, token: string): Promise<{ url: string }> {
  const res = await request(base, "/api/byoe/seed", token, { method: "POST" });
  return (await res.json()) as { url: string };
}

export async function downloadBundle(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(transferTimeoutMs()) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`seed download failed (${res.status})${text ? `: ${text}` : ""}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buffer);
}

export async function fetchArtifactUrl(base: string, token: string): Promise<{ url: string; key: string }> {
  const res = await request(base, "/api/byoe/artifact-url", token, { method: "POST" });
  return (await res.json()) as { url: string; key: string };
}

export async function fetchChatUploadUrl(
  base: string,
  token: string,
  captureId: string,
): Promise<{ url: string; key: string }> {
  const res = await request(base, "/api/byoe/chat-url", token, {
    method: "POST",
    body: JSON.stringify({ captureId }),
  });
  return (await res.json()) as { url: string; key: string };
}

export interface ChatCapturePayload {
  provider: "CLAUDE" | "CODEX";
  title: string | null;
  key: string;
  byteSize: number;
  messageCount: number | null;
  sourceMtime: string | null;
}

export async function postChatCapture(
  base: string,
  token: string,
  captures: ChatCapturePayload[],
): Promise<{ status: string; count: number }> {
  const res = await request(base, "/api/byoe/chat-capture", token, {
    method: "POST",
    body: JSON.stringify({ captures }),
  });
  return (await res.json()) as { status: string; count: number };
}

export interface ByoeEventPayload {
  type: "TEST_RUN" | "DEV_SERVER";
  passed?: boolean;
  exitCode?: number;
  port?: number;
  durationMs?: number;
  timedOut?: boolean;
}

// Reports a process event (a test run / dev-server start). Best-effort by design: a short timeout so a
// hung server can't hang the CLI; callers swallow failures. Scoped timeout only — the shared `request`
// helper stays untouched so seed downloads etc. keep their own behavior.
export async function postByoeEvent(base: string, token: string, event: ByoeEventPayload): Promise<void> {
  await request(base, "/api/byoe/event", token, {
    method: "POST",
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(2000),
  });
}

export type ByoeStartPhase =
  | "RESOLVE_SESSION"
  | "DOWNLOAD_SEED"
  | "CLONE"
  | "PROVISION"
  | "BASELINE_TESTS"
  | "START_CLOCK"
  | "FINALIZE";

export interface ByoeStartDiagnosticPayload {
  ok: boolean;
  phase: ByoeStartPhase;
  durationMs?: number;
  phaseTimings?: Record<string, number>;
  errorKind?: string | null;
  errorMessage?: string | null;
  errorCommand?: string | null;
  exitCode?: number | null;
  outputTail?: string | null;
  cliVersion?: string;
  nodeVersion?: string;
  os?: string;
  arch?: string;
}

// Reports a `start` outcome (success or failure). Best-effort: a short timeout so a slow/down server
// can't hang setup, and the caller swallows failures. On the failure path the caller awaits this
// (within the timeout) so the event actually flushes before the process exits.
export async function postByoeStartDiagnostic(
  base: string,
  token: string,
  payload: ByoeStartDiagnosticPayload,
  timeoutMs = 2500,
): Promise<void> {
  await request(base, "/api/byoe/diagnostics", token, {
    method: "POST",
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function uploadChatRaw(url: string, filePath: string): Promise<void> {
  const body = await readFile(filePath);
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/x-ndjson" },
    signal: AbortSignal.timeout(transferTimeoutMs()),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`chat upload failed (${res.status})${text ? `: ${text}` : ""}`);
  }
}

export async function postSubmit(base: string, token: string, payload: SubmitPayload): Promise<SubmitResult> {
  const res = await request(base, "/api/byoe/submit", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return (await res.json()) as SubmitResult;
}

export async function uploadBundle(url: string, filePath: string): Promise<void> {
  const body = await readFile(filePath);
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream" },
    signal: AbortSignal.timeout(transferTimeoutMs()),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`artifact upload failed (${res.status})${text ? `: ${text}` : ""}`);
  }
}
