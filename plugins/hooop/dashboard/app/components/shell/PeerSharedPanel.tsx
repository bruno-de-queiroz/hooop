"use client";
import { Users } from "lucide-react";
import { SectionTitle } from "@/app/components/ui";
import { peerCapability, useMounted } from "../lib/participant";

// Peer-only left-rail panel (mockup): a guest is locked to one session, so
// instead of the host's session list they get a "Shared session" card that
// states their access level. Capability comes from the layout-injected meta —
// mount-gated (server can't read it) to avoid a hydration mismatch.

const CAP_LABEL: Record<string, string> = {
  full: "Full co-drive",
  drive: "Drive",
  spectate: "Spectate",
};
const CAP_HINT: Record<string, string> = {
  full: "send turns, run bash, approve plans & tools",
  drive: "send turns & comment on plans — the host approves",
  spectate: "read-only — you can watch but not drive",
};

export function PeerSharedPanel() {
  const mounted = useMounted();
  const cap = mounted ? peerCapability() : null;

  return (
    <div className="flex-1 min-h-0 p-3">
      <div className="rounded-[12px] bg-sunken border border-divider p-3.5">
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-sdk" />
          <SectionTitle className="text-sdk">Shared session</SectionTitle>
        </div>
        <p className="text-[12px] text-ink-soft mt-2.5 leading-relaxed">
          You&rsquo;re a guest in the host&rsquo;s session. The full transcript is in the center; use
          the composer to co-drive if your share allows it.
        </p>

        {cap && (
          <div className="mt-3 pt-3 border-t border-divider">
            <div className="flex items-center gap-2">
              <span
                className="chip text-[10px] px-2 py-0.5"
                style={{
                  background: "color-mix(in oklab, rgb(var(--sdk)) 18%, transparent)",
                  color: "rgb(var(--sdk))",
                }}
              >
                {CAP_LABEL[cap]}
              </span>
              <span className="text-[10px] text-ink-faint">your access</span>
            </div>
            <p className="text-[11px] text-ink-faint mt-2 leading-relaxed">{CAP_HINT[cap]}</p>
          </div>
        )}
      </div>
    </div>
  );
}
