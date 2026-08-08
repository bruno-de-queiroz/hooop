"use client";
import { useState } from "react";
import { Unplug } from "lucide-react";
import { useSSE } from "./useSSE";

/**
 * Full-screen takeover shown to a peer when their share is revoked mid-session.
 * The live channel closes with code 4403 → useSSE dispatches a "revoked" frame
 * → this covers the (now data-starved) dashboard so the peer can't keep reading
 * the frozen transcript snapshot. Host never receives 4403, so this never
 * fires for the host.
 */
export function RevocationOverlay() {
  const [revoked, setRevoked] = useState(false);
  useSSE({ revoked: () => setRevoked(true) });

  if (!revoked) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="revocation-title"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center text-center p-6 bg-fail/10 backdrop-blur-sm"
    >
      <span className="w-14 h-14 rounded-full flex items-center justify-center bg-fail/[.18] text-fail">
        <Unplug className="w-7 h-7" aria-hidden />
      </span>
      <h2 id="revocation-title" className="mt-4 font-display text-[18px] font-semibold text-ink">
        This shared session has ended
      </h2>
      <p className="mt-1.5 max-w-sm text-[13px] text-ink-mute leading-relaxed">
        The host revoked access. Ask them for a fresh link to rejoin.
      </p>
      <p className="mt-4 text-[11px] text-ink-hush">Your view is now disconnected.</p>
    </div>
  );
}
