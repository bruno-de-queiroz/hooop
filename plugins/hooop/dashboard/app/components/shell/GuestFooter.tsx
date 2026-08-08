"use client";
import { myDisplayName, useMounted } from "../lib/participant";

// Guest identity footer (peer-only, mockup). A peer isn't the authenticated
// host, so instead of the host's /api/identity profile we show the name they
// picked at join + a "guest" tag. Mount-gated: myDisplayName() reads
// sessionStorage, which the server can't see (it would hydrate as "Guest" then
// swap) — see useMounted.

function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const sdkAvatar = {
  background: "color-mix(in oklab, rgb(var(--sdk)) 30%, rgb(var(--elevated)))",
  color: "rgb(var(--sdk))",
};

export function GuestFooter() {
  const mounted = useMounted();
  const name = mounted ? myDisplayName() : "Guest";
  return (
    <div className="border-t border-divider p-2.5 px-4 flex items-center gap-2.5 shrink-0">
      <span className="avatar w-8 h-8 text-[11px] shrink-0" style={sdkAvatar}>
        {initials(name)}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[12px] font-semibold text-ink">{name}</span>
        <span className="block truncate text-[10px] font-mono uppercase tracking-wide text-sdk">
          guest
        </span>
      </span>
    </div>
  );
}
