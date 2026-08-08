"use client";
import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, Power, Radio, Trash2, UserCheck } from "lucide-react";
import type { ShareRecord } from "@/lib/sandbox-types";
import { Button, StatusDot } from "../../ui";
import { cn } from "../../ui/cn";
import { countryLabel } from "../../lib/format";

// Settings → Sharing (Phase 3). Full parity with the legacy SharingPanel —
// tunnel lifecycle, pending-join admit/deny, per-share revoke, and the
// stop-sharing kill switch — restyled to the mockup's Settings section. The
// mockup only depicts the "tunnel off" resting card; the live/joins/shares
// states are rendered in the same token language.

interface TunnelStatus {
  status: "stopped" | "starting" | "running" | "error";
  url: string | null;
  error: string | null;
}

interface PendingJoin {
  ticketId: string;
  shareId: string;
  sessionId: string;
  peerName: string | null;
  peerIp?: string | null;
  peerCountry?: string | null;
  createdAt: number;
}

/**
 * Settings → Sharing. In `peerMode` (a full-capability peer) this renders only
 * what a co-driver may do — admit/deny pending joins and revoke co-guests in
 * their own session — and hides host-only surfaces (tunnel lifecycle, link
 * creation, and the revoke-all/close-tunnel kill switch). The sandbox scopes the
 * peer's share list + enforces capability, so this is presentation, not the gate.
 */
export function SettingsSharing({ peerMode = false }: { peerMode?: boolean }) {
  const [tunnel, setTunnel] = useState<TunnelStatus>({ status: "stopped", url: null, error: null });
  const [shares, setShares] = useState<ShareRecord[]>([]);
  const [joins, setJoins] = useState<PendingJoin[]>([]);
  const [decidingTicket, setDecidingTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "start" | "stop">(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // A peer can't read the host-only tunnel status; skip that fetch entirely.
      const [t, s, j] = await Promise.all([
        peerMode ? Promise.resolve(null) : fetch("/api/tunnel").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/share").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/share/pending-joins").then((r) => (r.ok ? r.json() : null)),
      ]);
      if (t) setTunnel(t as TunnelStatus);
      if (s && Array.isArray(s.shares)) setShares(s.shares as ShareRecord[]);
      if (j && Array.isArray(j.joins)) setJoins(j.joins as PendingJoin[]);
    } catch {
      /* non-fatal — next poll retries */
    }
  }, [peerMode]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const decideJoin = useCallback(
    async (ticketId: string, decision: "admit" | "deny") => {
      setDecidingTicket(ticketId);
      setJoins((cur) => cur.filter((j) => j.ticketId !== ticketId));
      try {
        await fetch(`/api/share/join/${encodeURIComponent(ticketId)}/${decision}`, {
          method: "POST",
        });
      } finally {
        setDecidingTicket(null);
        void refresh();
      }
    },
    [refresh],
  );

  const startTunnel = useCallback(async () => {
    setBusy("start");
    try {
      const r = await fetch("/api/tunnel", { method: "POST" });
      const t = (await r.json().catch(() => null)) as TunnelStatus | null;
      if (t) setTunnel(t);
    } finally {
      setBusy(null);
    }
  }, []);

  const stopSharing = useCallback(async () => {
    setBusy("stop");
    try {
      await Promise.allSettled(
        shares.map((s) =>
          fetch(`/api/share/${encodeURIComponent(s.shareId)}/revoke`, { method: "POST" }),
        ),
      );
      await fetch("/api/tunnel", { method: "DELETE" });
    } finally {
      setBusy(null);
      void refresh();
    }
  }, [shares, refresh]);

  const revoke = useCallback(
    async (shareId: string) => {
      try {
        await fetch(`/api/share/${encodeURIComponent(shareId)}/revoke`, { method: "POST" });
      } finally {
        void refresh();
      }
    },
    [refresh],
  );

  const copyUrl = useCallback(async () => {
    if (!tunnel.url) return;
    try {
      await navigator.clipboard.writeText(tunnel.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [tunnel.url]);

  const running = tunnel.status === "running";
  const dotState = running ? "wrap" : tunnel.status === "error" ? "fail" : "idle";
  const label =
    tunnel.status === "starting"
      ? "starting tunnel…"
      : running
        ? "live"
        : tunnel.status === "error"
          ? "error"
          : "off";

  return (
    <section>
      <div className="section-title mb-2 flex items-center gap-2">
        <Radio className="w-3.5 h-3.5" /> {peerMode ? "Session peers" : "Sharing"}
        {shares.length > 0 && (
          <span className="ml-1 rounded-[6px] bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
            {shares.length}
          </span>
        )}
      </div>

      {/* Pending joins — a peer is actively waiting; show first. */}
      {joins.length > 0 && (
        <div className="mb-2.5 flex flex-col gap-2">
          {joins.map((j) => (
            <div
              key={j.ticketId}
              className="rounded-control p-2.5 bg-live/[0.09] border border-live/30"
            >
              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                <UserCheck className="w-3 h-3 text-live" />
                <span className="text-ink-soft">{j.peerName ?? "someone"}</span>
                <span className="text-ink-faint">wants to join</span>
              </div>
              {j.peerIp && (
                <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                  from {j.peerIp}
                  {countryLabel(j.peerCountry) ? ` (${countryLabel(j.peerCountry)})` : ""}
                </div>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => decideJoin(j.ticketId, "deny")}
                  disabled={decidingTicket === j.ticketId}
                  title="Reject and revoke the share link"
                  className="text-fail hover:text-fail"
                >
                  deny
                </Button>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={() => decideJoin(j.ticketId, "admit")}
                  disabled={decidingTicket === j.ticketId}
                >
                  admit
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Peer mode: no tunnel to show. When there's nothing pending and no
        * co-guests, say so instead of rendering an empty section. */}
      {peerMode && joins.length === 0 && shares.length === 0 && (
        <div className="rounded-control bg-sunken border border-divider px-4 py-3 text-[11px] text-ink-faint">
          No other peers in this session yet.
        </div>
      )}

      {/* Tunnel status card — host only (the mockup's resting treatment). */}
      {!peerMode && (
      <div className="rounded-control bg-sunken border border-divider px-4 py-3 flex items-center gap-3">
        <StatusDot state={dotState} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-ink-soft">
            Tunnel <span className="text-ink-faint">{label}</span>
          </div>
          {running && tunnel.url ? (
            <div className="mt-1 flex items-center gap-2">
              <code
                className="flex-1 truncate rounded bg-window px-1.5 py-0.5 font-mono text-[10px] text-ink-soft"
                title={tunnel.url}
              >
                {tunnel.url}
              </code>
              <button
                onClick={copyUrl}
                className="shrink-0 rounded p-1 text-ink-mute hover:bg-elevated hover:text-ink"
                aria-label="Copy tunnel URL"
              >
                <Copy className="w-3 h-3" />
              </button>
              {copied && <span className="font-mono text-[10px] text-wrap">copied</span>}
            </div>
          ) : (
            <div className="text-[11px] text-ink-faint">
              {tunnel.status === "error" && tunnel.error
                ? tunnel.error
                : "No active shares. Start a tunnel to invite a peer to a session."}
            </div>
          )}
        </div>
        {!running && tunnel.status !== "starting" && (
          <Button variant="accent" size="sm" onClick={startTunnel} disabled={busy != null} className="shrink-0">
            {busy === "start" ? "starting…" : "Start tunnel"}
          </Button>
        )}
      </div>
      )}

      {/* Active shares */}
      {shares.length > 0 && (
        <ul className="space-y-1 mt-2.5">
          {shares.map((s) => (
            <li
              key={s.shareId}
              className="flex items-center gap-2 px-1 font-mono text-[11px] text-ink-soft"
            >
              <span className="truncate" title={`${s.publicHost} · session ${s.sessionId}`}>
                {s.peerName ?? "guest"}
              </span>
              <span className="ml-auto shrink-0 text-ink-faint">
                {s.expiresAt ? new Date(s.expiresAt).toLocaleTimeString() : "no expiry"}
              </span>
              <button
                onClick={() => revoke(s.shareId)}
                className="shrink-0 rounded p-1 text-fail hover:bg-elevated"
                aria-label={`Revoke share for ${s.peerName ?? "guest"}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Kill switch — host only (revokes ALL shares + closes the tunnel). */}
      {!peerMode && (running || shares.length > 0) && (
        <button
          type="button"
          onClick={stopSharing}
          disabled={busy != null}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-control border border-fail/40 px-3 py-1.5 font-mono text-[11px] text-fail hover:bg-fail/10 disabled:opacity-40"
        >
          {busy === "stop" ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Power className="w-3 h-3" />
          )}
          stop sharing (revoke all + close tunnel)
        </button>
      )}
    </section>
  );
}
