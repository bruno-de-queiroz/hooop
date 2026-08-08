"use client";
import { useEffect, useState } from "react";
import { isHostClient } from "@/app/components/lib/participant";

/**
 * Whether the host is broadcasting live: the public tunnel is running AND at
 * least one share link exists. `/api/tunnel` + `/api/share` are host-only, so a
 * peer — who is here *because* a live link admitted them — is always live and
 * never queries. Polled (there's no push channel for tunnel/share changes), on
 * a gentle cadence since the pill isn't time-critical.
 */
export function useSharingLive(): boolean {
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!isHostClient()) {
      setLive(true);
      return;
    }
    let stopped = false;

    const check = async () => {
      try {
        const [t, s] = await Promise.all([
          fetch("/api/tunnel").then((r) => (r.ok ? r.json() : null)),
          fetch("/api/share").then((r) => (r.ok ? r.json() : null)),
        ]);
        if (stopped) return;
        const running = (t as { status?: string } | null)?.status === "running";
        const shares = (s as { shares?: unknown[] } | null)?.shares;
        const hasShare = Array.isArray(shares) && shares.length > 0;
        setLive(running && hasShare);
      } catch {
        /* transient — keep the last known state, next tick retries */
      }
    };

    void check();
    const id = setInterval(check, 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  return live;
}
