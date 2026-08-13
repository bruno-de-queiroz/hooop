"use client";
import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Loader2, QrCode, Trash2, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { ShareRecord } from "@/lib/sandbox-types";
import { IconButton } from "../ui";
import { Modal } from "../ui/Overlay";
import { HostDevicesSection } from "./HostDevicesSection";
import { cn } from "../ui/cn";

// Shell-native port of the legacy ShareDialog (per-session peer sharing).
// Server-managed cloudflared tunnel, mint/list/revoke share links, QR to scan —
// rendered on the Modal primitive with design tokens.
//
// `peerMode`: a full-capability peer (co-host) may mint/list/revoke links for the
// session they're in, but CANNOT start/stop the tunnel (host-only). A peer is
// already connected THROUGH the tunnel, so window.location.origin IS the public
// base URL — no need to read the host-only /api/tunnel. The routes + sandbox
// re-check capability and session scope; this flag only shapes the UI.

interface CreateResult {
  shareId: string;
  link: string;
  capability: string;
  publicHost: string;
  expiresAt: number | null;
}

interface TunnelStatus {
  status: "stopped" | "starting" | "running" | "error";
  url: string | null;
  error: string | null;
}

const EXPIRY_OPTIONS: Array<{ label: string; ms: number | null }> = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "12 hours", ms: 12 * 60 * 60 * 1000 },
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "No expiry", ms: null },
];

type Capability = "full" | "drive" | "spectate";
// Mirrors the sandbox capabilityAllows() gate: full = turns + !bash + approvals;
// drive = turns + comments (no approvals); spectate = read-only.
const CAPABILITY_OPTIONS: Array<{ value: Capability; label: string; hint: string }> = [
  { value: "full", label: "Full co-drive", hint: "turns, !bash, and plan/tool approvals" },
  { value: "drive", label: "Drive", hint: "send turns & comment on plans — no approvals" },
  { value: "spectate", label: "Spectate", hint: "read-only — watch the session" },
];

export function ShellShareModal({
  open,
  sessionId,
  onClose,
  peerMode = false,
}: {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  peerMode?: boolean;
}) {
  const [tunnel, setTunnel] = useState<TunnelStatus>({ status: "stopped", url: null, error: null });
  const [startingTunnel, setStartingTunnel] = useState(false);
  const [peerName, setPeerName] = useState("");
  const [expiryMs, setExpiryMs] = useState<number | null>(EXPIRY_OPTIONS[1].ms);
  const [capability, setCapability] = useState<Capability>("full");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [shares, setShares] = useState<ShareRecord[]>([]);

  const refreshShares = useCallback(async () => {
    try {
      const r = await fetch("/api/share");
      if (r.ok) {
        const d = (await r.json()) as { shares: ShareRecord[] };
        setShares(d.shares.filter((s) => s.sessionId === sessionId));
      }
    } catch {
      /* non-fatal */
    }
  }, [sessionId]);

  const refreshTunnel = useCallback(async () => {
    try {
      const r = await fetch("/api/tunnel");
      if (r.ok) setTunnel((await r.json()) as TunnelStatus);
    } catch {
      /* non-fatal */
    }
  }, []);

  // Load shares whenever the modal opens; a peer can't read the host-only tunnel
  // status (and doesn't need it — its own origin is the public base URL).
  useEffect(() => {
    if (!open) return;
    void refreshShares();
    if (!peerMode) void refreshTunnel();
  }, [open, peerMode, refreshShares, refreshTunnel]);

  // Closing the modal drops the minted link + QR from memory. The link embeds
  // the per-run tunnel host and a signed token, so a cached QR goes stale the
  // moment the tunnel stops or the share is revoked (both tear the grant down
  // server-side). Clearing on close means reopening never flashes a dead QR —
  // it re-derives on demand via the "show QR" button off the live share list.
  useEffect(() => {
    if (open) return;
    setCreated(null);
    setCopied(false);
    setError(null);
  }, [open]);

  // Belt-and-suspenders for a modal left open across a tunnel stop: the host's
  // link is only valid while the tunnel is running, so drop the cached link/QR
  // the instant we observe the tunnel down (peers ride the host tunnel and have
  // no local tunnel state to gate on).
  useEffect(() => {
    if (peerMode) return;
    if (tunnel.status !== "running" && created) setCreated(null);
  }, [peerMode, tunnel.status, created]);

  // In peerMode the public base URL is the origin the peer is already using
  // (they reached this dashboard through the host's tunnel); otherwise it's the
  // host's live tunnel URL.
  const publicBaseUrl = peerMode
    ? (typeof window !== "undefined" ? window.location.origin : null)
    : tunnel.url;
  const canCreate = peerMode ? Boolean(publicBaseUrl) : tunnel.status === "running";

  const startTunnel = useCallback(async () => {
    setStartingTunnel(true);
    setError(null);
    try {
      const r = await fetch("/api/tunnel", { method: "POST" });
      const t = (await r.json().catch(() => null)) as TunnelStatus | null;
      if (t) setTunnel(t);
      if (t && t.status !== "running") setError(t.error ?? "tunnel failed to start");
    } catch (e) {
      setError(`could not start tunnel: ${e}`);
    } finally {
      setStartingTunnel(false);
    }
  }, []);

  const create = useCallback(async () => {
    if (!publicBaseUrl) {
      setError(peerMode ? "sharing is unavailable" : "start the tunnel first");
      return;
    }
    setError(null);
    setCreating(true);
    setCreated(null);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          publicBaseUrl,
          capability,
          expiresInMs: expiryMs,
          peerName: peerName.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `failed (HTTP ${res.status})`);
        return;
      }
      setCreated(data as CreateResult);
      void refreshShares();
    } catch (e) {
      setError(`network error: ${e}`);
    } finally {
      setCreating(false);
    }
  }, [sessionId, publicBaseUrl, peerMode, expiryMs, peerName, capability, refreshShares]);

  const copyLink = useCallback(async () => {
    if (!created?.link) return;
    try {
      await navigator.clipboard.writeText(created.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [created]);

  // Re-show the QR / link for an existing share — the token isn't stored, so the
  // server re-signs it deterministically from the grant.
  const showLink = useCallback(async (shareId: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(shareId)}/link`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `could not load link (HTTP ${res.status})`);
        return;
      }
      setCreated(data as CreateResult);
    } catch (e) {
      setError(`network error: ${e}`);
    }
  }, []);

  const revoke = useCallback(
    async (shareId: string) => {
      try {
        await fetch(`/api/share/${encodeURIComponent(shareId)}/revoke`, { method: "POST" });
        if (created?.shareId === shareId) setCreated(null);
        void refreshShares();
      } catch {
        /* ignore */
      }
    },
    [created, refreshShares],
  );

  const running = tunnel.status === "running";

  return (
    <Modal open={open} onClose={onClose} label="Share this session" className="max-w-3xl">
      <div className="flex items-center gap-2 px-5 h-14 shrink-0 border-b border-divider">
        <Link2 className="w-4 h-4 text-ink-mute" />
        <span className="font-sans text-[14px] font-semibold text-ink">Share this session</span>
        <IconButton label="Close" size="sm" className="ml-auto" onClick={onClose}>
          <X className="w-4 h-4" />
        </IconButton>
      </div>

      {/*
        Three bands, because the dialog answers three questions in order and used
        to mix them: is the tunnel up, which of MY devices are on it, and who else
        is in. The tunnel spans the top since both columns depend on it — nothing
        below works without it — and the two audiences sit side by side underneath,
        deliberately adjacent so the contrast is legible: on the left, screens that
        are YOU; on the right, guests who are not.
      */}
      <div className="p-5 flex flex-col gap-5 overflow-y-auto max-h-[calc(85vh-3.5rem)]">
        {/* ── TOP: the tunnel everything else hangs off ─────────────────────── */}
        <div>
          <div className="section-title mb-1.5">{peerMode ? "Public URL" : "Public tunnel"}</div>
          {peerMode ? (
            // A peer can't control the tunnel — it's the host's. Show the origin
            // links will point to (the one the peer is connected through).
            <div className="flex items-center gap-2 rounded-control bg-sunken border border-divider px-2.5 py-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-wrap" />
              <code className="flex-1 truncate font-mono text-[11px] text-ink-soft" title={publicBaseUrl ?? ""}>
                {publicBaseUrl ?? "unavailable"}
              </code>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-control bg-sunken border border-divider px-2.5 py-2">
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  running ? "bg-wrap" : tunnel.status === "error" ? "bg-fail" : "bg-ink-hush",
                )}
              />
              {running && tunnel.url ? (
                <code className="flex-1 truncate font-mono text-[11px] text-ink-soft" title={tunnel.url}>
                  {tunnel.url}
                </code>
              ) : (
                <span className="flex-1 font-mono text-[11px] text-ink-faint">
                  {tunnel.status === "starting" || startingTunnel ? "starting tunnel…" : "tunnel is off"}
                </span>
              )}
              {!running && (
                <button
                  type="button"
                  onClick={startTunnel}
                  disabled={startingTunnel || tunnel.status === "starting"}
                  className="pill-btn shrink-0 text-[11px] px-2.5 py-1 disabled:opacity-40"
                >
                  {startingTunnel || tunnel.status === "starting" ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    "start tunnel"
                  )}
                </button>
              )}
            </div>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            {peerMode
              ? "You reached this session through the host's tunnel. Links you create point at the same URL."
              : "hooop exposes the dashboard over a managed public tunnel — nothing to install. Everything below needs it running."}
          </p>
        </div>

        {/* ── BELOW: your screens on the left, other people on the right ────── */}
        <div className={cn("grid gap-6 items-start", !peerMode && "sm:grid-cols-2")}>
          {/* LEFT — your own devices. Host only: a peer cannot enroll devices
             (that would hand out host authority from a guest seat) and the routes
             refuse it regardless, so showing it to them would be a dead end. Their
             own "continue on another device" affordance lives in the
             shared-session panel, where it re-uses their existing share instead of
             creating anything. */}
          {!peerMode && (
            <HostDevicesSection publicBaseUrl={publicBaseUrl} enabled={running} sessionId={sessionId} />
          )}

          {/* RIGHT — peers: the form, then whatever it produced, then who's in. */}
          <div className="flex flex-col gap-4 min-w-0">
            <div>
              <div className="section-title mb-2">Peers{shares.length > 0 ? ` (${shares.length})` : ""}</div>
              <p className="text-[11px] leading-relaxed text-ink-mute">
                Invite someone <span className="text-ink-soft">else</span> in as a guest. They pick
                their own name, you admit them, and their messages are attributed to them.
              </p>
            </div>

            <div className="flex gap-3">
              <label className="flex-1">
                <span className="section-title">Suggested name</span>
                <input
                  type="text"
                  value={peerName}
                  onChange={(e) => setPeerName(e.target.value)}
                  placeholder="optional — guest names themselves"
                  title="The guest picks their own name when joining; this is just a fallback."
                  className="field w-full text-[12px] px-2.5 py-2 mt-1.5"
                />
              </label>
              <label className="flex-1">
                <span className="section-title">Expires</span>
                <select
                  value={String(expiryMs)}
                  onChange={(e) => setExpiryMs(e.target.value === "null" ? null : Number(e.target.value))}
                  className="field w-full text-[12px] px-2.5 py-2 mt-1.5"
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.label} value={String(o.ms)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block">
              <span className="section-title">Capability</span>
              <select
                value={capability}
                onChange={(e) => setCapability(e.target.value as Capability)}
                className="field w-full text-[12px] px-2.5 py-2 mt-1.5"
              >
                {CAPABILITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-ink-faint">
                {CAPABILITY_OPTIONS.find((o) => o.value === capability)?.hint}
              </p>
            </label>

            <button
              onClick={create}
              disabled={creating || !canCreate}
              className="accent-btn w-full py-2.5 text-[12px] font-semibold disabled:opacity-40"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
              Create share link
            </button>

            {error && <p className="text-[11px] text-fail">{error}</p>}

            {created && (
              <div className="rounded-card border border-wrap/30 bg-wrap/[0.08] p-3">
                <div className="section-title mb-1.5 text-wrap">Share link (copy &amp; send)</div>
                <div className="flex items-center gap-2">
                  <code
                    className="flex-1 truncate rounded bg-sunken px-2 py-1 font-mono text-[11px] text-ink-soft"
                    title={created.link}
                  >
                    {created.link}
                  </code>
                  <button
                    onClick={copyLink}
                    className="icon-btn w-8 h-8 shrink-0"
                    aria-label="Copy link"
                    title="Copy link"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
                {copied && <p className="mt-1 text-[10px] text-wrap">copied</p>}
                {/* QR encodes the full link (token in the fragment), rendered locally
                   so the token never leaves the page. */}
                <div className="mt-3 flex flex-col items-center gap-1">
                  <div className="rounded-lg bg-white p-2">
                    <QRCodeSVG value={created.link} size={148} level="M" />
                  </div>
                  <p className="text-[10px] text-ink-faint">scan to join on another device</p>
                </div>
              </div>
            )}

            {shares.length > 0 && (
              <ul className="space-y-1">
                {shares.map((s) => (
                  <li
                    key={s.shareId}
                    className="flex items-center gap-2 font-mono text-[11px] text-ink-soft"
                  >
                    <span className="truncate" title={s.publicHost}>
                      {s.peerName ?? "guest"} · {s.publicHost}
                    </span>
                    <span className="chip ml-auto shrink-0 px-1.5 py-0.5 text-[10px]" title="capability">
                      {s.capability}
                    </span>
                    <span className="shrink-0 text-ink-faint">
                      {s.expiresAt ? new Date(s.expiresAt).toLocaleTimeString() : "no expiry"}
                    </span>
                    <button
                      onClick={() => showLink(s.shareId)}
                      className="icon-btn w-7 h-7 shrink-0"
                      aria-label="Show QR / link"
                      title="Show QR / link"
                    >
                      <QrCode className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => revoke(s.shareId)}
                      className="icon-btn w-7 h-7 shrink-0 hover:text-fail"
                      aria-label="Revoke"
                      title="Revoke"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
