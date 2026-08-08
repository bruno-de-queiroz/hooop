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

export async function signPeerToken(payload: PeerTokenPayload, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadB64 = toBase64Url(enc.encode(json));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
  return `${payloadB64}.${toBase64Url(sig)}`;
}

/**
 * Verify signature + expiry and return the payload, or null if invalid. Does
 * NOT check revocation or host — callers enforce host (`payload.host === Host`)
 * and the sandbox enforces revocation by `sid`.
 */
export async function verifyPeerToken(token: string, secret: string): Promise<PeerTokenPayload | null> {
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

  let payload: PeerTokenPayload;
  try {
    payload = JSON.parse(dec.decode(fromBase64Url(payloadB64)));
  } catch {
    return null;
  }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

export const PEER_COOKIE = "hooop_peer";

/** Short-lived cookie set at redemption while a join awaits host admission. It
 * carries the ticket secret that binds the pending join to this browser, so
 * only the party that redeemed can claim the ticket once the host admits.
 * Swapped for {@link PEER_COOKIE} by the claim step; never grants app access. */
export const PEER_PENDING_COOKIE = "hooop_pending";

/** Read the dashboard's peer-token signing secret (set by the launcher). */
export function peerSigningSecret(): string | null {
  const s = process.env.HOOOP_PEER_SIGNING_SECRET;
  return s && s.trim().length >= 16 ? s.trim() : null;
}
