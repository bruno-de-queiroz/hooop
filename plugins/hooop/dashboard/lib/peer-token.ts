/**
 * Stateless, HMAC-signed peer tokens for session sharing.
 *
 * Edge-safe: uses only WebCrypto (`crypto.subtle`) and Text(En|De)coder, no
 * `node:` imports — so the same verify path runs in edge middleware and in node
 * route handlers. The dashboard SIGNS a token when a share is created and
 * VERIFIES it on every peer request; the sandbox is the durable revocation
 * authority (it re-checks the shareId), so this token only has to prove "the
 * dashboard issued a grant with these claims and it hasn't expired."
 *
 * Format: `base64url(payloadJson).base64url(hmacSha256(payloadJson))`.
 */

export interface PeerTokenPayload {
  /** Token kind. Absent means "peer" (every peer token ever signed omits it).
   * Present and "host" means a HOST DEVICE token, which must never be accepted
   * on a peer code path — see verifyPeerToken. */
  kind?: "host";
  /** Share id — the sandbox's revocation key. */
  sid: string;
  /** Canonical session id this grant co-drives. */
  ses: string;
  /** Capability: "full" | "drive" | "spectate". */
  cap: string;
  /** Bare hostname the peer must present (the tunnel host). */
  host: string;
  /** Optional display name. */
  name?: string | null;
  /** Expiry, epoch ms; 0/absent = no expiry. */
  exp?: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Constant-time byte compare. */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function signPayload(payload: object, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadB64 = toBase64Url(enc.encode(json));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
  return `${payloadB64}.${toBase64Url(sig)}`;
}

/**
 * Verify the signature and return the raw payload, or null. Shared by both token
 * kinds — the CALLER is responsible for checking `kind`, because a valid
 * signature only proves we issued the thing, not what it was issued for.
 */
async function verifySigned(token: string, secret: string): Promise<Record<string, unknown> | null> {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let expectedSig: Uint8Array;
  try {
    const key = await hmacKey(secret);
    expectedSig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
  } catch {
    return null;
  }
  let providedSig: Uint8Array;
  try {
    providedSig = fromBase64Url(sigB64);
  } catch {
    return null;
  }
  if (!timingSafeEqualBytes(providedSig, expectedSig)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dec.decode(fromBase64Url(payloadB64)));
  } catch {
    return null;
  }
  if (payload && typeof payload === "object") return payload;
  return null;
}

export async function signPeerToken(payload: PeerTokenPayload, secret: string): Promise<string> {
  return signPayload(payload, secret);
}

/**
 * Verify signature + expiry and return the payload, or null if invalid. Does
 * NOT check revocation or host — callers enforce host (`payload.host === Host`)
 * and the sandbox enforces revocation by `sid`.
 */
export async function verifyPeerToken(token: string, secret: string): Promise<PeerTokenPayload | null> {
  const payload = await verifySigned(token, secret);
  if (!payload) return null;
  // DOMAIN SEPARATION. Both kinds are signed with the same secret, so a valid
  // signature is not an answer to "what is this?". A host device token presented
  // as a peer cookie must not resolve to a peer (it has no share to scope
  // against, so it would be a peer bound to nothing), and more importantly the
  // reverse must not happen — see verifyHostDeviceToken. Rejecting the wrong
  // kind on BOTH sides means neither can ever be replayed as the other.
  if (payload.kind === "host") return null;
  if (typeof payload.sid !== "string" || typeof payload.ses !== "string") return null;
  const exp = payload.exp;
  if (typeof exp === "number" && exp && Date.now() > exp) return null;
  return payload as unknown as PeerTokenPayload;
}

/**
 * A host device token: the credential a phone or tablet holds so it can be the
 * HOST over the public tunnel rather than a guest with a nickname.
 *
 * Claims deliberately do NOT include a session or a capability. A device is not
 * scoped to one session and has no capability ceiling — the chosen model is
 * "full host, revocable per device" — so there is nothing to put there, and an
 * empty `cap` field would only invite somebody to start trusting it.
 */
export interface HostDeviceTokenPayload {
  kind: "host";
  /** Device id — the sandbox's revocation key. */
  did: string;
  /** Bare hostname the device must present (the tunnel host). */
  host: string;
  /** Expiry, epoch ms; 0/absent = no expiry. */
  exp?: number;
}

export async function signHostDeviceToken(
  payload: Omit<HostDeviceTokenPayload, "kind">,
  secret: string,
): Promise<string> {
  return signPayload({ kind: "host", ...payload }, secret);
}

/**
 * Verify signature + expiry and return the device payload, or null. Requires
 * `kind === "host"`, so a peer token (which never carries `kind`) can never come
 * back from here — the difference between "a guest of this session" and "the
 * operator of this machine" must not rest on a field being absent.
 *
 * Does NOT check revocation or host: callers enforce host (`payload.host ===
 * Host`) and the sandbox enforces revocation by `did`.
 */
export async function verifyHostDeviceToken(
  token: string,
  secret: string,
): Promise<HostDeviceTokenPayload | null> {
  const payload = await verifySigned(token, secret);
  if (!payload) return null;
  if (payload.kind !== "host") return null;
  if (typeof payload.did !== "string" || !payload.did) return null;
  if (typeof payload.host !== "string" || !payload.host) return null;
  const exp = payload.exp;
  if (typeof exp === "number" && exp && Date.now() > exp) return null;
  return payload as unknown as HostDeviceTokenPayload;
}

export const PEER_COOKIE = "hooop_peer";

/** Short-lived cookie set at redemption while a join awaits host admission. It
 * carries the ticket secret that binds the pending join to this browser, so
 * only the party that redeemed can claim the ticket once the host admits.
 * Swapped for {@link PEER_COOKIE} by the claim step; never grants app access. */
export const PEER_PENDING_COOKIE = "hooop_pending";

/** The durable cookie an enrolled host device holds on the tunnel host. Separate
 * from {@link PEER_COOKIE} so the two credentials can never be confused by a
 * cookie read: a browser may legitimately hold both (you paired yourself into a
 * session before enrolling the same phone), and which one it is decides whether
 * the viewer is the operator or a guest. */
export const HOST_DEVICE_COOKIE = "hooop_host_device";

/** Read the dashboard's peer-token signing secret (set by the launcher). */
export function peerSigningSecret(): string | null {
  const s = process.env.HOOOP_PEER_SIGNING_SECRET;
  return s && s.trim().length >= 16 ? s.trim() : null;
}
