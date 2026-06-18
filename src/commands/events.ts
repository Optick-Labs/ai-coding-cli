import { arch as osArch, platform, release } from "node:os";
import { postByoeCliEvent, postByoeEvent, type ByoeEventPayload } from "../api.js";
import { readCredentials, SessionNotFoundError, type Session } from "../session.js";
import { telemetryDisabled } from "./start-telemetry.js";
import { CLI_VERSION } from "../version.js";

// Best-effort report of a process event to the control plane. Offline sessions have nowhere to report,
// and any failure (server down, timeout, non-2xx) is swallowed so it never breaks `test` / `dev`.
export async function pingEvent(session: Session, event: ByoeEventPayload): Promise<void> {
  if (!session.token || !session.apiBaseUrl) return;
  try {
    await postByoeEvent(session.apiBaseUrl, session.token, event);
  } catch {
    // intentionally ignored — event capture is supplementary
  }
}

// When a command fails because it ran outside the session folder, report it so we get aggregate eyes
// on the misfire — but only when we can attribute it unambiguously (a unique discovered candidate)
// and the user hasn't opted out of telemetry. The token is recovered straight from the 0600 cred
// store and used in-memory only; it never lands in the registry or any new file. Always best-effort:
// this never alters the error the caller is about to surface.
export async function reportWrongDirectory(error: unknown, command: string): Promise<void> {
  if (!(error instanceof SessionNotFoundError)) return;
  const target = error.telemetryTarget;
  if (!target || telemetryDisabled()) return;
  try {
    const creds = await readCredentials(target.repoDir);
    if (!creds?.token || !creds.apiBaseUrl) return;
    await postByoeCliEvent(creds.apiBaseUrl, creds.token, {
      kind: "WRONG_DIRECTORY",
      command,
      cliVersion: CLI_VERSION,
      nodeVersion: process.version,
      os: `${platform()} ${release()}`,
      arch: osArch(),
    });
  } catch {
    // intentionally ignored — telemetry never breaks a command
  }
}
