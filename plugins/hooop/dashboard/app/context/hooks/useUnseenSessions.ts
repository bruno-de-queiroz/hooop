"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types/session";

/** A session's last-activity timestamp (ms epoch), mtime as the fallback. */
function sessionTs(s: SessionInfo): number {
  return s.updatedAt ?? (Date.parse(s.mtime) || 0);
}

function keyOf(s: SessionInfo): string {
  return s.sessionId ?? s.id;
}

/**
 * Tracks which sessions have activity the viewer hasn't seen — the sidebar's
 * "unseen messages" dot (mockup). In-memory (resets on reload) and deliberately
 * quiet:
 *   - The list present at mount is seeded as already-seen, so history doesn't
 *     light up everything on load.
 *   - A session that gains newer activity — or first appears — *after* mount,
 *     while it isn't the one you're viewing, is flagged.
 *   - The selected session is continuously marked seen at its latest activity,
 *     so opening a flagged session (or receiving activity in the open one)
 *     clears it.
 */
export function useUnseenSessions(
  sessions: SessionInfo[],
  selectedId: string | null,
): (s: SessionInfo) => boolean {
  const seenRef = useRef<Record<string, number>>({});
  const initedRef = useRef(false);
  const [, force] = useState(0);

  useEffect(() => {
    const inited = initedRef.current;
    let changed = false;

    for (const s of sessions) {
      const id = keyOf(s);
      if (!(id in seenRef.current)) {
        // First non-empty pass: the existing list counts as seen. Anything that
        // shows up later (a new spawn, a peer's session) seeds unseen so it flags.
        seenRef.current[id] = inited ? 0 : sessionTs(s);
        changed = true;
      }
    }

    // Keep the open session pinned to its latest activity so it never flags.
    if (selectedId) {
      const sel = sessions.find((s) => keyOf(s) === selectedId);
      if (sel) {
        const ts = sessionTs(sel);
        if ((seenRef.current[selectedId] ?? 0) < ts) {
          seenRef.current[selectedId] = ts;
          changed = true;
        }
      }
    }

    if (!initedRef.current && sessions.length > 0) initedRef.current = true;
    if (changed) force((n) => n + 1);
  }, [sessions, selectedId]);

  return useCallback(
    (s: SessionInfo) => {
      const id = keyOf(s);
      if (id === selectedId) return false;
      return sessionTs(s) > (seenRef.current[id] ?? 0);
    },
    [selectedId, sessions],
  );
}
