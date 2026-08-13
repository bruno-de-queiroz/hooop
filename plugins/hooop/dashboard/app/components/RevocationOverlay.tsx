"use client";
import { useState } from "react";
import { Unplug } from "lucide-react";
import { useSSE } from "./useSSE";

/**
 * Full-screen takeover shown when the credential behind this view is revoked
 * mid-session. The live channel closes with code 4403 → useSSE dispatches a
 * "revoked" frame → this covers the (now data-starved) dashboard so nobody keeps
 * reading a frozen transcript snapshot.
 *
 * TWO people can land here, and they are not in the same situation:
 *   - a GUEST whose share was revoked. Someone else decided; the way back is to
 *     ask the host for a fresh link.
 *   - the HOST on one of their own enrolled devices, revoked from the device
 *     list. They decided, or they are on the phone they just signed out. Telling
 *     them to ask the host for a link would be telling them to ask themselves.
 *
 * The host at the machine still never gets here: their authority is the install
 * cookie, which has nothing to revoke.
 */
export function RevocationOverlay() {
  const [reason, setReason] = useState<string | null>(null);
  useSSE({
    revoked: (data) => {
      const r = (data as { reason?: string } | undefined)?.reason;
      setReason(typeof r === "string" && r ? r : "share revoked");
    },
  });

  if (!reason) return null;
  const isDevice = reason === "device revoked";
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
        {isDevice ? "This device was signed out" : "This shared session has ended"}
      </h2>
      <p className="mt-1.5 max-w-sm text-[13px] text-ink-mute leading-relaxed">
        {isDevice
          ? "It is no longer one of your devices. Add it again from the share dialog on your machine to get back in."
          : "The host revoked access. Ask them for a fresh link to rejoin."}
      </p>
      <p className="mt-4 text-[11px] text-ink-hush">Your view is now disconnected.</p>
    </div>
  );
}
