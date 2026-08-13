"use client";
import { useCallback, useState } from "react";
import { Users, Copy, Loader2, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { SectionTitle, Button } from "@/app/components/ui";
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

  // The peer's OWN link, fetched on demand so a guest can move to their phone
  // without asking the host for anything. Held in state and never persisted: it
  // is a credential, and the join page deliberately strips it from the URL after
  // use, so the only copy that should outlive this panel is the one the person
  // deliberately carries to the other device.
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchLink = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/share/mine/link");
      if (!res.ok) {
        setError("Your access link couldn’t be re-created. Ask the host for a new one.");
        return;
      }
      const body = (await res.json()) as { link?: string };
      if (body.link) setLink(body.link);
      else setError("Your access link couldn’t be re-created. Ask the host for a new one.");
    } catch {
      setError("Network error. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }, [loading]);

  const copy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the QR is still there */ }
  }, [link]);

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

        {/* Continue on another device. Same link, same share, so the other screen
            is the SAME guest — same name on messages, same @handle, same access.
            The host still gets the admit prompt, which is the point: they always
            decide who is in the room, even when it's somebody already in it. */}
        <div className="mt-3 pt-3 border-t border-divider">
          {link ? (
            <>
              <div className="flex flex-col items-center gap-1">
                <div className="rounded-lg bg-white p-2">
                  <QRCodeSVG value={link} size={124} level="M" />
                </div>
                <p className="text-[10px] text-ink-faint text-center leading-relaxed">
                  scan to continue as <span className="text-ink-soft">you</span> —
                  the host will be asked to let you back in
                </p>
              </div>
              <Button
                variant="pill"
                size="sm"
                onClick={() => void copy()}
                className="mt-2 w-full text-[11px]"
              >
                <Copy className="w-3 h-3" />
                {copied ? "copied" : "copy link"}
              </Button>
            </>
          ) : (
            <Button
              variant="pill"
              size="sm"
              onClick={() => void fetchLink()}
              disabled={loading}
              className="w-full text-[11px]"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Smartphone className="w-3 h-3" />}
              Continue on another device
            </Button>
          )}
          {error && <p className="mt-2 text-[10px] text-fail leading-relaxed">{error}</p>}
        </div>
      </div>
    </div>
  );
}
