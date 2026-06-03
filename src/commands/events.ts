import { postByoeEvent, type ByoeEventPayload } from "../api.js";
import type { Session } from "../session.js";

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
