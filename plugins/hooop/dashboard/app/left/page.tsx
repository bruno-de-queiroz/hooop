import { LogOut, Smartphone, Lock } from "lucide-react";
import { HooopMark } from "../components/shell/HooopLogo";

export const dynamic = "force-dynamic";

/**
 * Terminal "you're signed out of this browser" landing.
 *
 * Three ways in, all of them "you are looking at a public URL you have no
 * credential for":
 *   - a PEER clicking "Leave session" (`?as=peer`);
 *   - the HOST on a device that has been revoked (`?as=device`);
 *   - anybody who opens the tunnel URL without a link at all (no param).
 * Sending any of them to `/` renders the host new-session onboarding backed by a
 * credential they do not have: every request 403s and the shell looks broken. This
 * page is cookie-agnostic and deliberately has no action.
 *
 * The copy branches because the situations are not the same. A guest has to be
 * re-invited and re-admitted by somebody else. The host just signed out one of
 * their own screens and can add it back themselves. A passer-by needs to be given
 * a link before any of this concerns them.
 */
export default async function LeftPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>;
}) {
  const { as } = await searchParams;
  const kind = as === "device" ? "device" : as === "peer" ? "peer" : "none";

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-bg text-ink-soft p-6">
      {/* hooop logotype — mirrors the /join screen so leaving bookends joining */}
      <div className="flex items-center gap-1.5 mb-8">
        <HooopMark size={22} />
        <span className="font-display text-[20px] font-bold tracking-tight text-ink">hooop</span>
      </div>

      <div className="w-full max-w-sm rounded-card bg-window border border-divider p-6 shadow-overlay">
        <div className="flex flex-col items-center text-center py-4">
          <span className="w-9 h-9 rounded-full flex items-center justify-center bg-sdk/[.18] text-sdk">
            {kind === "device"
              ? <Smartphone className="w-5 h-5" aria-hidden />
              : kind === "peer"
                ? <LogOut className="w-5 h-5" aria-hidden />
                : <Lock className="w-5 h-5" aria-hidden />}
          </span>
          <h2 className="mt-3 font-display text-[16px] font-semibold text-ink">
            {kind === "device"
              ? "This device is signed out"
              : kind === "peer"
                ? "You’ve left the session"
                : "You need an invite to open this"}
          </h2>
          <p className="mt-1 text-[12px] text-ink-mute leading-relaxed">
            {kind === "device"
              ? "It is no longer one of your devices. To use it again, open the share dialog on your machine and add a device — you’ll get a fresh code to scan."
              : kind === "peer"
                ? "Your access has ended and this device is signed out of the shared session. To rejoin, ask the host for a fresh invite link — they’ll need to admit you again."
                : "This address only opens with a share link or an enrolled device. Ask whoever runs this hooop for one."}
          </p>
        </div>
      </div>

      <p className="mt-6 text-[10px] text-ink-hush">You can close this tab.</p>
    </main>
  );
}
