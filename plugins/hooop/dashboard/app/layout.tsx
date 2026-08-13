import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { headers, cookies } from "next/headers";
import "./globals.css";
import AuthBootstrap from "./components/AuthBootstrap";
import { PEER_COOKIE, HOST_DEVICE_COOKIE } from "@/lib/peer-token";

// Desktop-app type tiers (DESIGN.md): Archivo for UI/display, JetBrains Mono for
// figures/code. next/font self-hosts them and exposes CSS vars consumed by
// tailwind.config's fontFamily. `swap` avoids a blocking flash of invisible text.
const archivo = Archivo({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-archivo",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "hooop - pairing with an agent",
  description: "Being alone is not a requirement",
};

// Mobile peers open the shared session on a phone. Pin the layout viewport to
// the device width (so the UI isn't rendered at a zoomed-out ~980px desktop
// width) and let content extend under the notch/home indicator — the shell
// goes edge-to-edge below `sm`. `maximumScale` is intentionally left default so
// pinch-zoom stays available (accessibility).
//
// `interactiveWidget: "resizes-content"` makes the on-screen keyboard shrink the
// *layout* viewport (and `dvh`) on Chromium, so a `100dvh` shell sits exactly
// above the keyboard — no black gap, no JS. Browsers that ignore it (iOS Safari)
// fall back to the visualViewport hook in AppShell.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

// Read HOOOP_DASHBOARD_TOKEN at request time, not build time. The
// launcher writes it into the container env after the build is baked.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Mirror the per-participant synchronizer token into a meta tag the client
  // bundle reads to set x-dashboard-token on mutating requests (the HttpOnly
  // cookie is invisible to JS by design).
  //
  // CRITICAL: the install token must NEVER reach a peer. Middleware injects a
  // trusted `x-hooop-participant` header (it strips any client-supplied one):
  //   - "host"      → emit the install token (localhost operator).
  //   - "host:<id>" → the SAME operator on an enrolled device, reached over the
  //                   tunnel. Emit that device's OWN signed token (its cookie
  //                   value), NEVER the install token: the install token is the
  //                   one secret that must not leave the machine, which is the
  //                   whole reason a device gets a revocable credential instead
  //                   of a copy of it.
  //   - "peer:<id>" → emit the peer's OWN signed token (their cookie value),
  //                   never the install token.
  //   - anything else → emit nothing.
  const hdrs = await headers();
  const participant = hdrs.get("x-hooop-participant") ?? "none";
  let token = "";
  if (participant === "host") {
    token = process.env.HOOOP_DASHBOARD_TOKEN ?? "";
  } else if (participant.startsWith("host:")) {
    token = (await cookies()).get(HOST_DEVICE_COOKIE)?.value ?? "";
  } else if (participant.startsWith("peer:")) {
    token = (await cookies()).get(PEER_COOKIE)?.value ?? "";
  }
  // Non-secret: lets the client tailor UI (host sees Share; peer shows as a
  // guest in presence). "host" | "peer" | "none" — an enrolled device collapses
  // to plain "host", because it IS the host and every host affordance applies.
  const participantKind = participant.startsWith("peer:")
    ? "peer"
    : participant.startsWith("host:")
      ? "host"
      : participant;
  // For a peer, the session they're locked to — lets the client pin selection
  // and hide session-switching. Trusted (injected by middleware).
  const peerSession = participantKind === "peer" ? hdrs.get("x-hooop-peer-session") ?? "" : "";
  // The peer's share capability (full | drive | spectate). Non-secret; lets the
  // plan-review UI show Approve/Reject only to a peer whose share permits
  // decisions. The sandbox re-validates on every action, so this is UX-only.
  const peerCapability = participantKind === "peer" ? hdrs.get("x-hooop-peer-capability") ?? "" : "";
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${archivo.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* Resolve the theme before first paint to avoid a flash of the wrong
          * palette. "auto" follows the OS; an explicit choice is stored under
          * `hooop-theme`. Kept in sync with ThemeSwitcher. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('hooop-theme')||'auto';var dark=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',dark?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
        {token ? <meta name="x-dashboard-token" content={token} /> : null}
        <meta name="x-hooop-participant" content={participantKind} />
        {peerSession ? <meta name="x-hooop-peer-session" content={peerSession} /> : null}
        {peerCapability ? <meta name="x-hooop-peer-capability" content={peerCapability} /> : null}
      </head>
      {/* suppressHydrationWarning: browser extensions (Grammarly, password
          managers, etc.) inject attributes onto <body> before React hydrates
          (e.g. data-gr-ext-installed), which would otherwise trip a dev-only
          hydration mismatch. Same rationale as the <html> tag above. */}
      <body suppressHydrationWarning>
        <AuthBootstrap />
        {children}
      </body>
    </html>
  );
}
