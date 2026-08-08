/**
 * Starting a cloudflared quick tunnel is the least reliable thing hooop does,
 * and for a long time it was also the least examinable: one spawn, and whatever
 * came out of it was the answer.
 *
 * Two decisions live here, both extracted for the same reason tunnel-reachability
 * was — server.mjs boots real listeners and spawns real processes, so nothing in
 * it can be tested. This module owns the POLICY (which flags, how many attempts);
 * server.mjs owns the processes and the per-tunnel bookkeeping.
 */

/**
 * cloudflared's transport defaults assume a healthy network path. The one hooop
 * most often runs on is not that.
 *
 * QUIC (the default) rides UDP/7844. Under WSL2 that path is WSL's NAT, plus the
 * docker bridge, plus — frequently — a corporate VPN, and the stack silently
 * drops datagrams larger than its smallest MTU. The tunnel registers, then the
 * data plane dies with "failed to run the datagram handler" and nothing that
 * says why. `http2` is plain TCP/443 and survives that path.
 *
 * Edge IP selection fails the same way: `auto` will happily pick an IPv6 edge,
 * and the docker bridge is IPv4-only unless the daemon was configured otherwise,
 * so the dial hangs until it times out.
 *
 * Both stay overridable. On a healthy network QUIC really is the better default,
 * and someone running hooop on one should be able to have it back.
 *
 * @param {string} localUrl origin the tunnel fronts
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]} argv for `cloudflared`
 */
export function cloudflaredArgs(localUrl, env = process.env) {
  return [
    "tunnel",
    "--no-autoupdate",
    "--protocol", env.HOOOP_TUNNEL_PROTOCOL || "http2",
    "--edge-ip-version", env.HOOOP_TUNNEL_EDGE_IP_VERSION || "4",
    "--url", localUrl,
  ];
}

/**
 * Run `attempt` until a tunnel registers, or until retrying stops being worth it.
 *
 * A quick tunnel begins with one HTTPS call to api.trycloudflare.com, and on a
 * filtered or flaky resolver that call fails often enough that a single spawn
 * reads to the user as "sharing is broken" rather than "try again". Retrying is
 * safe precisely because a failed attempt owns nothing: no hostname was handed
 * out, so no share is bound to it and there is nothing to revoke.
 *
 * An attempt result is a success iff it carries no `error`. Two fields cut the
 * loop short:
 *   - `fatal`   nothing a retry can fix (cloudflared missing from PATH)
 *   - `aborted` the host asked for no tunnel while we were mid-attempt, so a
 *               retry would be starting one nobody wants
 *
 * The deadline matters more than the attempt count. The common failure returns
 * in well under a second, so three attempts cost nothing; the case that needs
 * bounding is cloudflared hanging, where each attempt can burn its full start
 * timeout. Checked BETWEEN attempts only — an attempt already running is left to
 * finish, since its own timeout is what bounds it.
 *
 * @param {object} deps
 * @param {(n: number) => Promise<{error?: string, fatal?: boolean}>} deps.attempt
 * @param {number} [deps.attempts]    spawns before giving up (first is immediate)
 * @param {number} [deps.deadlineMs]  total wall-clock budget for all attempts
 * @param {(n: number) => number} [deps.backoffMs] wait before attempt n+1
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => number} [deps.now]
 * @param {() => boolean} [deps.aborted] true once the start is no longer wanted
 * @param {string} [deps.label]
 * @param {(...args: unknown[]) => void} [deps.log]
 * @returns {Promise<object>} the last attempt's result, `aborted: true` if cancelled
 */
export async function startTunnelWithRetry({
  attempt,
  attempts = 3,
  deadlineMs = 45_000,
  backoffMs = (n) => 1_000 * n,
  sleep,
  now = Date.now,
  aborted = () => false,
  label = "tunnel",
  log = () => {},
}) {
  const deadline = now() + deadlineMs;
  // Stands in only if `attempts` was somehow < 1, so the caller is never handed
  // an undefined result to read `.error` off.
  let last = { error: "tunnel failed to start" };

  for (let n = 1; n <= attempts; n++) {
    last = await attempt(n);
    if (!last.error) return last;
    if (aborted()) return { ...last, aborted: true };
    if (last.fatal || n === attempts || now() >= deadline) break;
    log(`tunnel[${label}] attempt ${n}/${attempts} failed:`, last.error, "— retrying");
    await sleep(backoffMs(n));
    if (aborted()) return { ...last, aborted: true };
  }
  return last;
}
