import { readFile, writeFile } from "node:fs/promises";
import type { Lang } from "./session.js";

const DEFAULT_API = "https://www.hellointerview.com";

export function apiBaseUrl(override?: string): string {
  return override ?? process.env.HI_API_URL ?? DEFAULT_API;
}

export interface RemoteSession {
  task: string;
  language: Lang;
  startedAt: string | null;
  deadline: string | null;
  remainingSeconds: number | null;
  status: string;
  baselineSha: string | null;
}

export interface SessionClock {
  startedAt: string;
  deadline: string;
  remainingSeconds: number;
  status: string;
}

export interface SubmitPayload {
  baselineSha: string;
  testsPassedLocal: boolean;
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
    throw new Error(`${path} failed (${res.status})${text ? `: ${text}` : ""}`);
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
  const res = await fetch(url);
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

export async function uploadChatRaw(url: string, filePath: string): Promise<void> {
  const body = await readFile(filePath);
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/x-ndjson" },
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
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`artifact upload failed (${res.status})${text ? `: ${text}` : ""}`);
  }
}
