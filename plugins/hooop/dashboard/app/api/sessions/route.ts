import { client } from "@/lib/sandbox-client";
import { proxy } from "@/lib/api-helpers";
import { peerSessionId } from "@/lib/peer-auth";
import { peerShareGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const revoked = await peerShareGuard(req);
  if (revoked) return revoked;

  // A peer is bound to one session — never expose the host's full session list.
  const peerSes = peerSessionId(req);
  return proxy(() =>
    client.listSessions().then((sessions) =>
      peerSes
        ? sessions.filter(
            (s) => s.sessionId === peerSes || (s.aliases?.includes(peerSes) ?? false),
          )
        : sessions,
    ),
  );
}
