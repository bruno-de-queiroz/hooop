import { LogOut } from "lucide-react";
import { HooopMark } from "../components/shell/HooopLogo";

export const dynamic = "force-dynamic";

/**
 * Peer "you've left" landing. A peer who clicks "Leave session" has their peer
 * cookie cleared, so sending them to `/` would render the HOST new-session
 * onboarding — wrong. Redirect them here instead: a terminal, cookie-agnostic
 * closing view in the same centered-card layout as the /join onboarding screen.
 * There's deliberately no action — returning requires a fresh invite + admit.
 */
export default function LeftPage() {
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
            <LogOut className="w-5 h-5" aria-hidden />
          </span>
          <h2 className="mt-3 font-display text-[16px] font-semibold text-ink">You’ve left the session</h2>
          <p className="mt-1 text-[12px] text-ink-mute leading-relaxed">
            Your access has ended and this device is signed out of the shared session.
            To rejoin, ask the host for a fresh invite link — they’ll need to admit you again.
          </p>
        </div>
      </div>

      <p className="mt-6 text-[10px] text-ink-hush">You can close this tab.</p>
    </main>
  );
}
