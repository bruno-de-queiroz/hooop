/**
 * Node-side helpers for reading the trusted participant identity that
 * middleware injected (`x-hooop-participant`), and for host-only route
 * guards. Middleware strips any client-supplied value and re-sets it after
 * authenticating, so route handlers can trust this header.
 */

const PARTICIPANT_HEADER = "x-hooop-participant";
const PEER_SESSION_HEADER = "x-hooop-peer-session";
const PEER_CAP_HEADER = "x-hooop-peer-capability";

export type ShareCapability = "full" | "drive" | "spectate";

export type Participant =
  /** The operator. `deviceId` is set when they arrived on one of their own
   *  enrolled devices over the tunnel rather than on the machine itself — same
   *  identity and same powers either way, so nothing downstream should branch on
   *  it except a UI that wants to say "you're on your phone". */
  | { kind: "host"; deviceId?: string }
  | { kind: "peer"; shareId: string }
  | { kind: "none" };

export function participantOf(req: Request): Participant {
  const raw = req.headers.get(PARTICIPANT_HEADER) ?? "none";
  if (raw === "host") return { kind: "host" };
  // `host:<deviceId>` — the host on an enrolled device. The proxy only emits
  // this after verifying the device token's signature and host binding, and the
  // sandbox re-validates the id against its device registry on every call, so
  // treating it as the host here is not a shortcut: it is the same two-gate
  // arrangement the peer path uses.
  if (raw.startsWith("host:")) {
    const deviceId = raw.slice("host:".length);
    if (deviceId) return { kind: "host", deviceId };
    return { kind: "none" };
  }
  if (raw.startsWith("peer:")) return { kind: "peer", shareId: raw.slice("peer:".length) };
  return { kind: "none" };
}

/** The enrolled device this request came from, or null when the host is on the
 *  machine (or the caller isn't the host). */
export function hostDeviceId(req: Request): string | null {
  const p = participantOf(req);
  return p.kind === "host" ? p.deviceId ?? null : null;
}

/** Same answer from a raw participant string, for server components that already
 *  read the header themselves (there is no Request to hand around there). */
export function hostDeviceIdOf(participant: string | null | undefined): string | null {
  if (!participant || !participant.startsWith("host:")) return null;
  return participant.slice("host:".length) || null;
}

/** True only for the local operator (install-token auth). */
export function isHost(req: Request): boolean {
  return participantOf(req).kind === "host";
}

export function isPeer(req: Request): boolean {
  return participantOf(req).kind === "peer";
}

/** The canonical session id a peer is bound to (null for host/none). Trusted:
 * injected by middleware, inbound value stripped. */
export function peerSessionId(req: Request): string | null {
  if (participantOf(req).kind !== "peer") return null;
  const v = req.headers.get(PEER_SESSION_HEADER);
  return v && v.length > 0 ? v : null;
}

/** May the caller touch this session? Host: always. Peer: only their bound
 * session. (Used to scope per-session read routes.) */
export function canAccessSession(req: Request, sessionId: string): boolean {
  const p = participantOf(req);
  if (p.kind !== "peer") return true;
  return peerSessionId(req) === sessionId;
}

/** The middleware-injected participant value to forward to the sandbox so it
 * can re-validate the share + capability and attribute the action. Returns
 * undefined when absent (treated as host/no-op by the sandbox). */
export function forwardedParticipant(req: Request): string | undefined {
  return req.headers.get(PARTICIPANT_HEADER) ?? undefined;
}

/** The peer's share capability from the trusted, middleware-injected header
 * (null for host/none). UX/authz hint only — the sandbox re-validates against
 * its durable share registry on every action. */
export function peerCapabilityOf(req: Request): ShareCapability | null {
  if (participantOf(req).kind !== "peer") return null;
  const v = req.headers.get(PEER_CAP_HEADER);
  return v === "full" || v === "drive" || v === "spectate" ? v : null;
}

/** May the caller admit/deny pending peer joins? The host always can; a peer
 * only with a "full" share (drive/spectate cannot). This is the first-line
 * gate; the sandbox enforces the same rule authoritatively (and additionally
 * scopes a peer to admitting only into their own session). */
export function canAdmitPeers(req: Request): boolean {
  const p = participantOf(req);
  if (p.kind === "host") return true;
  if (p.kind === "peer") return peerCapabilityOf(req) === "full";
  return false;
}
