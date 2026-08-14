import { headers } from "next/headers";
import { DashboardProviders } from "./context/DashboardProviders";
import { DesktopShell } from "./components/shell/DesktopShell";

export const dynamic = "force-dynamic";

export default async function DashboardHome() {
  // A peer is a guest in the host's session — hide host-only surfaces: the
  // session switcher/list and the host's authenticated identity.
  // Middleware injects the trusted header as `peer:<shareId>` (not a bare
  // "peer"), so match the prefix — an exact "peer" check never fires.
  //
  // Nothing here re-checks revocation: a revoked peer or device never reaches this
  // render, because the proxy redirects them to the signed-out page first (see
  // lib/access.ts). One place, so there is no second copy to drift.
  const isPeer = ((await headers()).get("x-hooop-participant") ?? "").startsWith("peer:");
  const port = process.env.HOOOP_PORT ?? "7842";

  return (
    <DashboardProviders>
      <DesktopShell isPeer={isPeer} port={port} />
    </DashboardProviders>
  );
}
