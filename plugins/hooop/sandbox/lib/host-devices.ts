import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomUUID, randomInt, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./paths";
import { log } from "@shared/logger";

/**
 * Host device registry — the durable, AUTHORITATIVE source of truth for "this
 * browser on the tunnel host IS the host", and the single point of revocation.
 *
 * Why this exists at all. The host is normally identified by HOSTNAME: hitting
 * the dashboard on the localhost allowlist mints the install cookie, so the
 * trust boundary is "you are already on this machine" (see dashboard/proxy.ts).
 * That works exactly once — on the machine. Open the tunnel URL on your own
 * phone and there is no host path at all, because handing the install token to
 * anything reachable from the internet would make the tunnel URL itself a
 * credential. The only way in was to mint yourself a peer share, which comes
 * back as a DIFFERENT participant: another id, a "guest joined" marker, a peer
 * name on your own turns.
 *
 * So a host device is a per-device credential for an identity that used to have
 * none. The ceremony is deliberately the reverse of the peer flow:
 *   - a PEER arrives holding a link and waits for the host to admit them;
 *   - a DEVICE is enrolled BY the host, from the machine, and the enrollment
 *     code it redeems is proof the host was standing there. There is nothing
 *     left to admit, so there is no admit gate.
 *
 * Auth split mirrors shares.ts exactly, and for the same reason:
 *   - The DASHBOARD mints a stateless, HMAC-signed device token carrying
 *     {kind:"host", did, host, exp}. Edge middleware verifies the signature to
 *     authenticate the device cheaply, with no shared state.
 *   - The SANDBOX owns the device record and is the revocation authority: the
 *     forwarded participant is `host:<deviceId>`, and every host-context call
 *     re-validates it here before acting. Revoking a device cuts it off
 *     instantly, and a compromised dashboard cannot invent one — it can only
 *     present a deviceId the sandbox still holds.
 *
 * The sandbox never sees the raw device token (the dashboard signs it), so
 * there is nothing secret to store here — only grant metadata, keyed by
 * deviceId. Enrollment CODES are secret, and they live in memory only.
 */

export interface HostDeviceRecord {
  deviceId: string;
  /** Human label for the revoke list ("Pixel 8", "iPad"). Host-chosen. */
  label: string;
  /** Exact bare Host the device's browser must present (the tunnel hostname). */
  publicHost: string;
  createdAt: number;
  /** epoch ms; null = no expiry (bounded in practice by the tunnel's life). */
  expiresAt: number | null;
  revoked: boolean;
  /** Last time this device was seen on a validated call; null until first use.
   * Informational, for the host's device list. */
  lastSeenAt: number | null;
}

const DEVICES_FILE = join(STATE_DIR, "host-devices.json");
const DEVICES_TMP = DEVICES_FILE + ".tmp";

/** Default lifetime of an enrolled device, matching the peer cookie's 12h. */
export const DEFAULT_DEVICE_TTL_MS = 12 * 60 * 60 * 1000;
/** Ceiling on a caller-supplied lifetime. A month of standing host authority on
 *  a public URL is not a thing we let anyone ask for by typo. */
export const MAX_DEVICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How many live devices one install may hold. A backstop on the file, not a
 *  meaningful product limit — nobody pairs eight phones. */
const MAX_DEVICES = 8;

/** Thrown when the host asks for a code with the device list already full. A
 *  distinct type so the route can answer this ONE case honestly (409 + "revoke
 *  one first"); every failure on the redeem side stays deliberately opaque. */
export class HostDeviceCapError extends Error {
  constructor() {
    super(`already holding the maximum of ${MAX_DEVICES} devices; revoke one first`);
    this.name = "HostDeviceCapError";
  }
}

/** An enrollment code is single-use and dies fast: it is a bearer secret that
 *  briefly grants HOST authority, so its window is the walk from the laptop to
 *  the phone, not a coffee break. */
const CODE_TTL_MS = 2 * 60_000;
/** Backstop so repeatedly hitting "add a device" can't grow the map. */
const MAX_CODES = 20;

/**
 * Revocation observers. Same arrangement (and same reasoning) as shares.ts: a
 * device dying has consequences beyond this registry — the push subscription it
 * registered must die with it, or a revoked phone keeps being delivered session
 * content, message bodies included, with no way for the host to stop it.
 *
 * A listener rather than a direct call into push.ts, so that every path which
 * kills a device (one revoke, revoke-all, tunnel down, shutdown) cleans up by
 * construction, and a fifth path added later cannot forget to.
 */
type DevicesRevokedListener = (deviceIds: readonly string[]) => void;
const revokedListeners: DevicesRevokedListener[] = [];

export function onHostDevicesRevoked(fn: DevicesRevokedListener): void {
  revokedListeners.push(fn);
}

function emitRevoked(deviceIds: readonly string[]): void {
  if (deviceIds.length === 0) return;
  for (const fn of revokedListeners) {
    // A misbehaving observer must never block revocation itself.
    try { fn(deviceIds); } catch (err) { log.error("host-devices", "revocation listener failed", { err: String(err) }); }
  }
}

/** deviceId -> record. Loaded once at boot, mutated in-process. */
const devices = new Map<string, HostDeviceRecord>();
let _loaded = false;

/** `lastSeenAt` moves on every single validated request, and persisting each
 *  one would turn a header check into a file write. Coalesce: update memory
 *  always, touch the disk at most this often. Losing a few minutes of
 *  "last seen" on a hard crash costs nothing (the records themselves do not
 *  survive a restart anyway). */
const LAST_SEEN_PERSIST_MS = 60_000;
let lastSeenPersistedAt = 0;

interface DevicesFile {
  version: 1;
  savedAt: string;
  devices: HostDeviceRecord[];
}

export function bootHostDevices(): void {
  if (_loaded) return;
  _loaded = true;
  // Same reasoning as bootShares(): a device is bound to a specific tunnel
  // hostname, and the quick tunnel mints a NEW random hostname on every start.
  // So ANY device persisted from a previous run is dangling by definition. We
  // discard the file rather than trusting it, which is also the belt-and-braces
  // guarantee after a SIGKILL where the shutdown drainer never ran: a stale
  // grant can never be revived. The cost is one QR scan per sandbox restart,
  // which is the honest price of a hostname that changes every run.
  const hadFile = existsSync(DEVICES_FILE);
  devices.clear();
  codes.clear();
  if (hadFile) {
    log.info("host-devices", "discarding devices from previous run (tunnel host is per-run)");
  }
  persist();
}

function pruneDead(): void {
  const now = Date.now();
  for (const [id, d] of devices) {
    if (d.revoked || (d.expiresAt != null && d.expiresAt <= now)) devices.delete(id);
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(DEVICES_FILE), { recursive: true });
    const body: DevicesFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      devices: [...devices.values()],
    };
    writeFileSync(DEVICES_TMP, JSON.stringify(body, null, 2), "utf-8");
    renameSync(DEVICES_TMP, DEVICES_FILE);
    lastSeenPersistedAt = Date.now();
  } catch (err) {
    log.error("host-devices", "persist failed", { err: String(err) });
  }
}

/** Normalize a Host header to a bare lowercase hostname (strip port/brackets).
 *  Same rules as shares.normalizeHost — kept local so this module stands alone. */
function normalizeHost(hostHeader: string): string {
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  if (colon >= 0) h = h.slice(0, colon);
  return h;
}

// ── Enrollment codes ─────────────────────────────────────────────────────────

interface EnrollCode {
  code: string;
  publicHost: string;
  label: string | null;
  ttlMs: number;
  createdAt: number;
  /**
   * The session the host was looking at when they minted this, carried so the
   * device can LAND there instead of on the new-session form.
   *
   * Not part of the grant: a device is install-wide and can switch sessions
   * freely afterwards. Purely "which session did you mean", which is otherwise
   * lost — a peer gets redirected to the one session their share binds them to,
   * and a device, having no such binding, arrived nowhere in particular.
   */
  sessionId: string | null;
}

const codes = new Map<string, EnrollCode>();

/** Alphabet with no look-alikes (no O/0, no I/1/L). The code rides in a QR, but
 *  it has to survive being read off a screen and typed on a phone too. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

function generateCode(): string {
  let out = "";
  // randomInt (not Math.random) — this string is a bearer credential for host
  // authority, so it comes from the CSPRNG like every other secret here.
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function sweepCodes(): void {
  const now = Date.now();
  for (const [c, e] of codes) {
    if (now - e.createdAt > CODE_TTL_MS) codes.delete(c);
  }
}

/**
 * Mint a single-use enrollment code for the CURRENT tunnel host. Host-only —
 * the caller must already be the host (enforced at the route), which is the
 * entire security argument for this flow: the code exists because somebody with
 * host authority asked for it.
 */
export function createEnrollCode(opts: {
  publicHost: string;
  label?: string | null;
  ttlMs?: number | null;
  /** Where the device should land. Caller resolves it to a canonical id. */
  sessionId?: string | null;
}): { code: string; expiresAt: number; deviceTtlMs: number } {
  bootHostDevices();
  sweepCodes();
  // Refuse at MINT time when the device list is full, not at redeem.
  //
  // The redeem side has to answer every failure with one opaque message, or it
  // becomes an oracle for "was that code real?" — which would have told the host
  // "invalid, expired or already used" on their phone when the real problem was a
  // full list. Here the caller is the authenticated host, so the truth is both
  // safe to say and actionable, and it is said before they walk to the other
  // device.
  pruneDead();
  if (devices.size >= MAX_DEVICES) {
    throw new HostDeviceCapError();
  }
  if (codes.size >= MAX_CODES) {
    const oldest = [...codes.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) codes.delete(oldest.code);
  }
  const ttlMs = Math.min(
    Math.max(1, opts.ttlMs ?? DEFAULT_DEVICE_TTL_MS),
    MAX_DEVICE_TTL_MS,
  );
  const now = Date.now();
  const code = generateCode();
  codes.set(code, {
    code,
    publicHost: normalizeHost(opts.publicHost),
    label: opts.label?.trim()?.slice(0, 60) || null,
    ttlMs,
    createdAt: now,
    sessionId: opts.sessionId?.trim() || null,
  });
  return { code, expiresAt: now + CODE_TTL_MS, deviceTtlMs: ttlMs };
}

/**
 * Redeem a code into a durable device record. Single-use: the code is deleted
 * whether or not the rest succeeds, so a guessed-then-retried code gets exactly
 * one attempt at each value.
 *
 * The host claim is re-checked here even though the dashboard already checked
 * it, because this is the trust boundary: a device bound to a hostname it did
 * not arrive on would be a grant with no tunnel to die with.
 */
export function redeemEnrollCode(
  rawCode: string,
  publicHost: string,
  label?: string | null,
): { ok: true; device: HostDeviceRecord; sessionId: string | null } | { ok: false; reason: string } {
  bootHostDevices();
  sweepCodes();
  const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
  if (!code) return { ok: false, reason: "invalid code" };

  // Constant-time lookup. A plain Map.get() leaks nothing by itself, but the
  // codes are short and low-entropy enough that we don't hand out any timing
  // signal at all: compare against every live code with a fixed-cost compare.
  let entry: EnrollCode | null = null;
  for (const e of codes.values()) {
    if (constantTimeEquals(e.code, code)) entry = e;
  }
  if (!entry) return { ok: false, reason: "invalid or expired code" };
  codes.delete(entry.code); // single-use, consumed on ANY attempt that found it

  const host = normalizeHost(publicHost);
  if (entry.publicHost !== host) return { ok: false, reason: "invalid or expired code" };

  pruneDead();
  if (devices.size >= MAX_DEVICES) {
    return { ok: false, reason: "too many enrolled devices; revoke one first" };
  }

  const now = Date.now();
  const device: HostDeviceRecord = {
    deviceId: randomUUID(),
    label: (label?.trim()?.slice(0, 60) || entry.label || "Device"),
    publicHost: host,
    createdAt: now,
    expiresAt: now + entry.ttlMs,
    revoked: false,
    // Redeeming the code IS the device talking to us, and it lands in the
    // dashboard immediately afterwards. Starting at null meant the list opened on
    // "not used yet" about a device that had just walked in.
    lastSeenAt: now,
  };
  devices.set(device.deviceId, device);
  persist();
  log.info("host-devices", "device enrolled", { deviceId: device.deviceId, label: device.label });
  return { ok: true, device, sessionId: entry.sessionId };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/** Live enrollment codes still awaiting a scan, for the host's own UI. Returns
 *  metadata only — never the code itself, which exists in exactly one place
 *  (the QR the host is looking at). */
export function pendingEnrollCount(): number {
  bootHostDevices();
  sweepCodes();
  return codes.size;
}

/** Drop every outstanding code (e.g. the host closed the add-device dialog). */
export function clearEnrollCodes(): { cleared: number } {
  const cleared = codes.size;
  codes.clear();
  return { cleared };
}

// ── Device lifecycle ─────────────────────────────────────────────────────────

export function listHostDevices(): HostDeviceRecord[] {
  bootHostDevices();
  pruneDead();
  return [...devices.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Look up a live device by id (null if missing/revoked/expired). */
export function getHostDevice(deviceId: string): HostDeviceRecord | null {
  bootHostDevices();
  const d = devices.get(deviceId);
  if (!d || d.revoked) return null;
  if (d.expiresAt != null && d.expiresAt <= Date.now()) return null;
  return d;
}

export interface HostDeviceValidation {
  ok: boolean;
  reason?: string;
  record?: HostDeviceRecord;
}

/**
 * Authoritative revocation/binding check, run sandbox-side on every call that
 * arrives as `host:<deviceId>`. The dashboard has already verified the token
 * signature; this confirms the device is still enrolled and still bound to the
 * hostname it claims.
 */
export function validateHostDevice(
  deviceId: string,
  opts: { host?: string } = {},
): HostDeviceValidation {
  const d = getHostDevice(deviceId);
  if (!d) return { ok: false, reason: "revoked or expired" };
  if (opts.host && d.publicHost !== normalizeHost(opts.host)) {
    return { ok: false, reason: "host mismatch" };
  }
  const now = Date.now();
  d.lastSeenAt = now;
  if (now - lastSeenPersistedAt > LAST_SEEN_PERSIST_MS) persist();
  return { ok: true, record: d };
}

export function revokeHostDevice(deviceId: string): { ok: boolean } {
  bootHostDevices();
  if (!devices.has(deviceId)) return { ok: false };
  devices.delete(deviceId);
  persist();
  emitRevoked([deviceId]);
  log.info("host-devices", "device revoked", { deviceId });
  return { ok: true };
}

/**
 * Revoke EVERY enrolled device at once. Called from the same places
 * revokeAllShares() is: the tunnel going down or stopping, and shutdown. Every
 * device is bound to the (now-gone) tunnel host, so the grants are dangling —
 * and unlike a share, a dangling one here would be dangling HOST authority.
 * Outstanding enrollment codes go with them, since they name the dead host too.
 */
export function revokeAllHostDevices(): { revoked: string[] } {
  bootHostDevices();
  clearEnrollCodes();
  const revoked = [...devices.keys()];
  if (revoked.length === 0) return { revoked };
  devices.clear();
  persist();
  emitRevoked(revoked);
  log.info("host-devices", "all devices revoked", { count: revoked.length });
  return { revoked };
}
