import { useSelectedSession } from "./SelectedSessionProvider";
import { useSessions } from "./SessionsProvider";

/**
 * The cwd of the currently selected session, or null when nothing is
 * selected / the selection doesn't resolve to a known session yet.
 * Shared by every data source that scopes itself to "the active
 * session's project" (commands, skills, files) so they can never drift
 * out of sync on which cwd they're reading.
 */
export function useSelectedCwd(): string | null {
  const { selectedId } = useSelectedSession();
  const { sessions } = useSessions();
  return selectedId
    ? sessions.find((s) => s.sessionId === selectedId)?.cwd ?? null
    : null;
}
