import { readFile } from "node:fs/promises";
import type { Lang } from "./session.js";

const DEFAULT_API = "https://www.hellointerview.com";

export function apiBaseUrl(override?: string): string {
  return override ?? process.env.HI_API_URL ?? DEFAULT_API;
}

export interface RemoteSession {
  task: string;
  language: Lang;
  seedRepoUrl: string;
  startedAt: string;
  deadline: string;
  remainingSeconds: number;
  status: string;
  baselineSha: string | null;
}

export interface SubmitPayload {
  baselineSha: string;
  testsPassedLocal: boolean;
  metadata?: Record<string, unknown>;
}

export interface SubmitResult {
  status: string;
  submittedAt: string;
  overTime: boolean;
  testsPassedLocal: boolean | null;
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

export async function fetchArtifactUrl(base: string, token: string): Promise<{ url: string; key: string }> {
  const res = await request(base, "/api/byoe/artifact-url", token, { method: "POST" });
  return (await res.json()) as { url: string; key: string };
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
