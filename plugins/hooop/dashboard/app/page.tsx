import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DashboardProviders } from "./context/DashboardProviders";
import { DesktopShell } from "./components/shell/DesktopShell";
import { hostDeviceIdOf } from "@/lib/peer-auth";
import { client } from "@/lib/sandbox-client";

export const dynamic = "force-dynamic";

export default async function DashboardHome() {
  // A peer is a guest in the host's session — hide host-only surfaces: the
  // session switcher/list and the host's authenticated identity.
  // Middleware injects the trusted header as `peer:<shareId>` (not a bare
  // "peer"), so match the prefix — an exact "peer" check never fires.
  const participant = (await headers()).get("x-hooop-participant") ?? "";
  const isPeer = participant.startsWith("peer:");

  // A revoked DEVICE must not be handed a shell at all.
  //
  // Middleware runs on the edge with no way to reach the sandbox, so it can only
  // check the token's signature — which stays perfectly valid after revocation.
  // The result was a phone that still rendered the whole dashboard while every
  // request behind it 403'd: it came up as the host's empty "Start a session"
  // form, which reads as the app being broken rather than as access having ended.
  //
  // This is the node-side half of the same two-gate arrangement everything else
  // here uses, and it costs one (TTL-cached) round trip per full page load.
  const deviceId = hostDeviceIdOf(participant);
  if (deviceId) {
    let live = true;
    try {
      live = !!(await client.hostDeviceLive(deviceId));
    } catch {
      // Sandbox blip: fail open, exactly as the read guard does. The API calls
      // this page makes re-check within seconds regardless.
    }
    if (!live) redirect("/left?as=device");
  }

  const port = process.env.HOOOP_PORT ?? "7842";

  return (
    <DashboardProviders>
      <DesktopShell isPeer={isPeer} port={port} />
    </DashboardProviders>
  );
}
