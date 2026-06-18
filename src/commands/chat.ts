import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { checkbox, confirm } from "@inquirer/prompts";
import { fetchChatUploadUrl, postChatCapture, uploadChatRaw, type ChatCapturePayload } from "../api.js";
import { discoverChats, type DiscoveredChat } from "../chats/index.js";
import { findSession } from "../session.js";
import type { Session } from "../session.js";

// Skip anything larger than this — a single session log shouldn't be tens of MB, and we don't want a
// pathological file bloating the upload.
const MAX_CHAT_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURES = 20;

const PROVIDER_LABEL: Record<DiscoveredChat["provider"], string> = {
  CLAUDE: "Claude",
  CODEX: "Codex",
  CURSOR: "Cursor",
};

function humanAge(mtimeMs: number): string {
  const sec = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function rowLabel(chat: DiscoveredChat): string {
  const title = chat.title ?? "(untitled)";
  const trimmed = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  return `${PROVIDER_LABEL[chat.provider]} · ${trimmed} · ${humanAge(chat.mtimeMs)} · ${chat.messageCount} msgs`;
}

// Discover AI chats for this repo, let the candidate pick which to attach, upload the raw logs to S3,
// and record them. Reused by `submit` and the standalone `chat` command. Best-effort: any failure
// here is logged and swallowed so it never blocks a submission.
export async function captureChats(session: Session, repoDir: string): Promise<void> {
  if (!session.token || !session.apiBaseUrl) {
    return; // offline session — nothing to upload to
  }

  let chats: DiscoveredChat[];
  try {
    chats = await discoverChats(repoDir);
  } catch {
    return;
  }

  const underSize = chats.filter((c) => c.byteSize <= MAX_CHAT_BYTES);
  const eligible = underSize.slice(0, MAX_CAPTURES);
  const skippedForSize = chats.length - underSize.length;

  if (eligible.length === 0) {
    console.log(
      chalk.dim(
        "No Claude Code, Codex, or Cursor chats found for this folder. If you used another tool (ChatGPT, etc.), you can paste your chat from the session page in your browser.",
      ),
    );
    return;
  }

  // No interactive terminal (CI, piped stdin): don't prompt, don't hang, leave capture status as-is.
  if (!process.stdin.isTTY) {
    console.log(chalk.dim("AI chats found, but no interactive terminal — skipping chat capture."));
    return;
  }

  console.log(chalk.bold("\nAttach your AI chat(s) from this session"));
  console.log(chalk.dim("These full logs are shared with your grader. Space toggles, enter confirms."));
  if (skippedForSize > 0) {
    console.log(chalk.dim(`(${skippedForSize} chat(s) skipped — over ${humanBytes(MAX_CHAT_BYTES)}.)`));
  }

  // Pre-check only chats from this session. A reused session directory (repeat practice, a stable
  // dev checkout) surfaces older chats that share the same cwd — leave those unchecked so hitting
  // enter on the defaults never ships a prior session's (or unrelated) AI logs to the grader.
  const startedAtMs = new Date(session.startedAt).getTime();
  const SESSION_GRACE_MS = 5 * 60_000;
  const selected = await checkbox<DiscoveredChat>({
    message: "Select chats to include:",
    choices: eligible.map((chat) => ({
      name: rowLabel(chat),
      value: chat,
      checked: chat.mtimeMs >= startedAtMs - SESSION_GRACE_MS,
    })),
    pageSize: 12,
  });

  if (selected.length === 0) {
    // Explicit "include nothing" — record SKIPPED so the cockpit doesn't keep asking.
    await postChatCapture(session.apiBaseUrl, session.token, []).catch(() => undefined);
    console.log(chalk.dim("No chats attached."));
    return;
  }

  const totalBytes = selected.reduce((sum, c) => sum + c.byteSize, 0);
  const proceed = await confirm({
    message: `Upload ${selected.length} chat(s) (${humanBytes(totalBytes)}) with your submission?`,
    default: true,
  });
  if (!proceed) {
    console.log(chalk.dim("Skipped chat capture."));
    return;
  }

  console.log(chalk.cyan("Uploading chats..."));
  const payloads: ChatCapturePayload[] = [];
  let failed = 0;
  // Isolate each upload so a single transient failure (an S3 blip on chat #3) doesn't discard the
  // chats that already uploaded — we register whatever succeeded and report an honest "N of M".
  for (const chat of selected) {
    try {
      const captureId = randomUUID();
      const { url, key } = await fetchChatUploadUrl(session.apiBaseUrl, session.token, captureId);
      await uploadChatRaw(url, chat.path);
      payloads.push({
        provider: chat.provider,
        title: chat.title,
        key,
        byteSize: chat.byteSize,
        messageCount: chat.messageCount,
        sourceMtime: new Date(chat.mtimeMs).toISOString(),
      });
    } catch {
      failed++;
    }
  }

  if (payloads.length === 0) {
    console.log(chalk.yellow("Couldn't upload any chats — skipping AI chat capture."));
    return;
  }

  await postChatCapture(session.apiBaseUrl, session.token, payloads);
  if (failed > 0) {
    console.log(
      chalk.yellow(`Attached ${payloads.length} of ${selected.length} chat(s) — ${failed} failed to upload.`),
    );
  } else {
    console.log(chalk.green(`Attached ${payloads.length} chat(s).`));
  }
}

export async function chatCommand(): Promise<void> {
  const { session, repoDir } = await findSession(process.cwd(), { command: "chat" });
  await captureChats(session, repoDir);
}
