"use client";
import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, Smartphone, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { HostDeviceRecord } from "@/lib/sandbox-types";
import { Button, IconButton } from "../ui";

/**
 * "Your devices" — the host's own phone or tablet, added as THEM.
 *
 * Lives next to share links because that is where people look for "get this on my
 * phone", but it is deliberately the opposite feature. A share link invites
 * somebody else in as a guest: they pick a nickname, you admit them, their turns
 * are attributed to them. A device is you. Same participant, same name on
 * messages, same `@handle`, same powers, no admit prompt — because there is
 * nobody to vet, only a code you minted seconds ago at this machine.
 *
 * The trade that buys is stated plainly in the UI: it is host authority on a
 * public URL, so it is revocable per device and dies with the tunnel.
 */

/** Rough "3m 20s" for the enrollment window, which is short enough that a bare
 *  timestamp would read as noise. */
function countdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function relative(ts: number | null): string {
  if (!ts) return "not used yet";
  const ms = Date.now() - ts;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

interface Enrollment {
  link: string;
  code: string;
  expiresAt: number;
}

export function HostDevicesSection({
  publicBaseUrl,
  enabled,
}: {
  /** The live tunnel URL. Devices are bound to it, so with no tunnel there is
   *  nothing to enroll against. */
  publicBaseUrl: string | null;
  /** False while the tunnel isn't running — the button explains itself rather
   *  than failing on click. */
  enabled: boolean;
}) {
  const [devices, setDevices] = useState<HostDeviceRecord[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/host-device");
      if (r.ok) {
        const d = (await r.json()) as { devices: HostDeviceRecord[]; thisDevice: string | null };
        setDevices(d.devices);
        setThisDevice(d.thisDevice);
      }
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Tick only while a code is live — the label counts down, and a permanent timer
  // would re-render this panel forever for no reason. On the tick that crosses the
  // deadline we also re-list, because the most likely reason a code stopped being
  // useful is that it was USED and the new device is now in the list.
  useEffect(() => {
    if (!enrollment) return;
    const iv = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= enrollment.expiresAt) {
        clearInterval(iv);
        void refresh();
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [enrollment, refresh]);

  // Derived, not mirrored into state: an expired code is a fact about the clock,
  // and keeping a second copy of it only creates a moment where the two disagree
  // and a dead QR is still on screen.
  const expired = !!enrollment && now >= enrollment.expiresAt;

  const mint = useCallback(async () => {
    if (!publicBaseUrl) {
      setError("start the tunnel first — a device is tied to it");
      return;
    }
    setMinting(true);
    setError(null);
    try {
      const res = await fetch("/api/host-device/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicBaseUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `could not mint a code (HTTP ${res.status})`);
        return;
      }
      setEnrollment(data as Enrollment);
      setNow(Date.now());
    } catch (e) {
      setError(`network error: ${e}`);
    } finally {
      setMinting(false);
    }
  }, [publicBaseUrl]);

  const copyLink = useCallback(async () => {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the QR is still there */ }
  }, [enrollment]);

  const revoke = useCallback(async (deviceId: string) => {
    try {
      await fetch(`/api/host-device/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" });
      // Revoking the device you are ON logs this browser out, so reload rather
      // than leaving a shell that will 401 on its next click.
      if (deviceId === thisDevice) {
        window.location.reload();
        return;
      }
      void refresh();
    } catch { /* non-fatal */ }
  }, [thisDevice, refresh]);

  return (
    <div>
      <div className="section-title mb-2">Your devices{devices.length > 0 ? ` (${devices.length})` : ""}</div>
      <p className="text-[11px] leading-relaxed text-ink-mute">
        Add your own phone and it acts as <span className="text-ink-soft">you</span>, not as a
        guest — same name on your messages, nothing to admit. Revoke it here any time; all devices
        drop when the tunnel stops.
      </p>

      {enrollment && !expired ? (
        <div className="mt-3 rounded-card border border-accent/30 bg-accent/[0.06] p-3">
          <div className="flex flex-col items-center gap-1.5">
            <div className="rounded-lg bg-white p-2">
              <QRCodeSVG value={enrollment.link} size={148} level="M" />
            </div>
            <p className="text-[10px] text-ink-faint">scan on the device you want to add</p>
            <code className="mt-1 rounded bg-sunken px-2 py-1 font-mono text-[13px] tracking-[0.2em] text-ink">
              {enrollment.code}
            </code>
            <p className="text-[10px] text-ink-faint" aria-live="polite">
              expires in {countdown(enrollment.expiresAt - now)} · single use
            </p>
          </div>
          <Button variant="pill" size="sm" onClick={() => void copyLink()} className="mt-2.5 w-full text-[11px]">
            <Copy className="w-3 h-3" />
            {copied ? "copied" : "copy link"}
          </Button>
        </div>
      ) : (
        <Button
          variant="pill"
          size="sm"
          onClick={() => void mint()}
          disabled={minting || !enabled}
          className="mt-2.5 w-full text-[11px]"
          title={enabled ? undefined : "start the tunnel first"}
        >
          {minting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Smartphone className="w-3 h-3" />}
          Add a device
        </Button>
      )}

      {expired && (
        <p className="mt-2 text-[11px] text-ink-faint leading-relaxed">
          That code expired. Add a device again if you still need one.
        </p>
      )}

      {error && <p className="mt-2 text-[11px] text-fail leading-relaxed">{error}</p>}

      {devices.length > 0 && (
        <ul className="mt-3 space-y-1">
          {devices.map((d) => (
            <li key={d.deviceId} className="flex items-center gap-2 text-[11px] text-ink-soft">
              <Smartphone className="w-3 h-3 shrink-0 text-ink-faint" aria-hidden />
              <span className="truncate" title={d.label}>{d.label}</span>
              {d.deviceId === thisDevice && (
                <span className="chip shrink-0 px-1.5 py-0.5 text-[10px]">this device</span>
              )}
              <span className="ml-auto shrink-0 text-ink-faint" title="last seen">
                {relative(d.lastSeenAt)}
              </span>
              <IconButton
                label={d.deviceId === thisDevice ? "Sign this device out" : `Revoke ${d.label}`}
                size="sm"
                className="shrink-0 hover:text-fail"
                onClick={() => void revoke(d.deviceId)}
              >
                <Trash2 className="w-3 h-3" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
