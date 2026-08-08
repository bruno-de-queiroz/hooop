"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { useSSE } from "../useSSE";
import { useSessions } from "@/app/context/SessionsProvider";
import { sessionDisplayLabel, countryLabel } from "../lib/format";
import { canAdmitPeers, useMounted } from "../lib/participant";

// Peer admission popup. A redeemed share link creates a PENDING join that a
// decider must admit. Shown to the host AND to full-capability peers (who can
// admit another guest into the session they're in) — the sandbox scopes a peer
// to their own session and re-checks capability. Surfaced top-center as a
// single-row card (avatar + "X wants to join" + session · capability +
// Deny/Admit) so a guest can be let in from anywhere, without opening Settings.
// Deny revokes the share (treated as hostile, same as the sandbox). Refetches on
// PeerJoin* SSE events with a slow poll as a safety net; capability now rides on
// each pending-join row (no separate host-only /api/share call).

interface PendingJoin {
  ticketId: string;
  shareId: string;
  sessionId: string;
  peerName: string | null;
  peerIp?: string | null;
  peerCountry?: string | null;
  createdAt: number;
  capability?: string | null;
}

const CAP_LABEL: Record<string, string> = {
  full: "full co-drive",
  drive: "drive",
  spectate: "spectate",
};

const sdkAvatar = {
  background: "color-mix(in oklab, rgb(var(--sdk)) 30%, rgb(var(--elevated)))",
  color: "rgb(var(--sdk))",
};

function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function ShellAdmissionToast() {
  const { sessions } = useSessions();
  const [joins, setJoins] = useState<PendingJoin[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  // Mount-gated: the server always reads as host, so calling canAdmitPeers()
  // during render would mismatch on hydration for a peer. See useMounted.
  const mounted = useMounted();
  const canAdmit = mounted && canAdmitPeers();

  const refresh = useCallback(async () => {
    try {
      const jr = await fetch("/api/share/pending-joins");
      if (jr.ok) {
        const d = (await jr.json()) as { joins?: PendingJoin[] };
        setJoins(Array.isArray(d.joins) ? d.joins : []);
      } else {
        setJoins([]);
      }
    } catch {
      /* transient */
    }
  }, []);

  // Coalesce SSE-driven refreshes; a peer redeeming fires a PeerJoinRequest.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void refresh(), 250);
  }, [refresh]);

  useEffect(() => {
    if (!canAdmit) return;
    void refresh();
    const poll = setInterval(refresh, 5000);
    return () => {
      clearInterval(poll);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [canAdmit, refresh]);

  useSSE({
    event: (raw: unknown) => {
      if (!canAdmit) return;
      const e = raw as { hook_type?: string | null };
      if (e?.hook_type && e.hook_type.startsWith("PeerJoin")) schedule();
    },
  });

  const decide = useCallback(
    async (ticketId: string, decision: "admit" | "deny") => {
      setDeciding(ticketId);
      setJoins((cur) => cur.filter((j) => j.ticketId !== ticketId)); // optimistic
      try {
        await fetch(`/api/share/join/${encodeURIComponent(ticketId)}/${decision}`, { method: "POST" });
      } catch {
        void refresh(); // restore on failure
      } finally {
        setDeciding(null);
      }
    },
    [refresh],
  );

  if (!canAdmit || joins.length === 0) return null;

  const labelFor = (sid: string) => {
    const s = sessions.find((x) => x.sessionId === sid || (x.aliases ?? []).includes(sid));
    return s ? sessionDisplayLabel(s) : sid.slice(0, 8);
  };

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[70] w-[min(92%,27rem)] flex flex-col gap-2">
      {joins.map((j) => {
        const busy = deciding === j.ticketId;
        const name = j.peerName ?? "A guest";
        const cap = j.capability ?? undefined;
        return (
          <div
            key={j.ticketId}
            role="alert"
            className="rounded-2xl p-3.5 flex items-center gap-3 bg-elevated border border-divider shadow-overlay motion-safe:animate-modal-in"
          >
            <span className="avatar w-10 h-10 text-[12px] shrink-0" style={sdkAvatar}>
              {initials(name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5 shrink-0 text-sdk" />
                <span className="text-[13px] font-semibold text-ink truncate">{name} wants to join</span>
              </div>
              <p className="text-[11.5px] text-ink-mute mt-0.5 truncate">
                {labelFor(j.sessionId)}
                {cap && (
                  <>
                    {" · "}capability <span className="font-mono text-sdk">{CAP_LABEL[cap] ?? cap}</span>
                  </>
                )}
                {j.peerIp && (
                  <>
                    {" · "}from <span className="font-mono text-ink-soft">{j.peerIp}</span>
                    {countryLabel(j.peerCountry) && (
                      <span className="text-ink-soft"> ({countryLabel(j.peerCountry)})</span>
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => void decide(j.ticketId, "deny")}
                disabled={busy}
                className="pill-btn text-[11px] px-3 py-1.5 disabled:opacity-40"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => void decide(j.ticketId, "admit")}
                disabled={busy}
                className="accent-btn text-[11px] px-3 py-1.5 disabled:opacity-40"
              >
                {busy ? "admitting…" : "Admit"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
