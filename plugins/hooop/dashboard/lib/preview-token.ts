/**
 * HMAC-signed grants for reaching a live preview.
 *
 * Same construction and the same secret as `peer-token.ts` — deliberately, so
 * there is one signing story in the dashboard rather than two — but a separate
 * payload and a separate cookie, because a preview grant answers a different
 * question: "may this browser load the app running on slot N", not "may this
 * browser co-drive session X".
 *
 * WHAT THIS TOKEN DOES NOT DO. It is not the authorization. Every preview
 * request re-checks the underlying SHARE against the sandbox (`shareLive`), so
 * revoking a peer's share cuts their preview access within seconds even though
 * they still hold a perfectly valid signed token. The token only proves the
 * dashboard issued a grant, for this preview, on this hostname.
 *
 * That split is why a mid-session joiner needs no re-approval: a grant is
 * minted on demand for anyone who already passes the session's own scope check,
 * so joining the session is what gets you the preview.
 */

export interface PreviewTokenPayload {
  /** Preview id this grant is for. A grant is never portable to another. */
  pv: string;
  /** Canonical session id the preview belongs to. */
  ses: string;
  /**
   * Share id backing this grant, or "host" for the local operator. This is the
   * revocation key: the front process asks the sandbox whether it is still live
   * on every request.
   */
  sid: string;
  /** Bare hostname the browser must present (tunnel host, or 127.0.0.1). */
  host: string;
  /** Expiry, epoch ms. */
  exp: number;
}

/** Cookie the preview origin sets after redeeming a grant. */
export const PREVIEW_COOKIE = "hooop_preview";

/**
 * Path prefix the preview listener serves itself and NEVER forwards to the app.
 *
 * Chosen to be implausible in a real project rather than pretty. Any path an
 * app might genuinely use would be shadowed, and this is the one place hooop
 * takes a URL away from the thing it is proxying.
 */
export const PREVIEW_AUTH_PREFIX = "/__hooop";

/** Grants are short-lived; a peer re-mints by reloading from the dashboard. */
export const PREVIEW_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

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
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signPreviewToken(payload: PreviewTokenPayload, secret: string): Promise<string> {
  const payloadB64 = toBase64Url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
  return `${payloadB64}.${toBase64Url(sig)}`;
}

/**
 * Verify signature + expiry. Does NOT check the host binding or revocation —
 * both are the caller's job, and both are enforced on every request.
 */
export async function verifyPreviewToken(token: string, secret: string): Promise<PreviewTokenPayload | null> {
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
  try { providedSig = fromBase64Url(sigB64); } catch { return null; }
  if (!timingSafeEqualBytes(providedSig, expectedSig)) return null;

  let payload: PreviewTokenPayload;
  try { payload = JSON.parse(dec.decode(fromBase64Url(payloadB64))); } catch { return null; }
  if (!payload || typeof payload.pv !== "string" || typeof payload.host !== "string") return null;
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

/** Normalize a Host header to a bare hostname (no port, IPv6-safe). */
export function normalizePreviewHost(hostHeader: string | null | undefined): string {
  if (!hostHeader) return "";
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  return colon >= 0 ? h.slice(0, colon) : h;
}
