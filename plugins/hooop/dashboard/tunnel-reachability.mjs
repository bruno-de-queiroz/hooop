/**
 * A quick tunnel's hostname is not reachable the moment cloudflared prints it.
 *
 * cloudflared says so itself — "it may take some time to be reachable" — because
 * the hostname has to propagate through Cloudflare's edge before DNS answers for
 * it. In practice that is seconds to a minute. hooop used to treat the banner as
 * completion: Share returned 200 with a URL that did not yet resolve, so anyone
 * who opened it immediately got a browser-level connection failure with nothing
 * to explain it. (That gap cost a long debugging session: a hostname checked too
 * early looks exactly like a tunnel that never registered.)
 *
 * So reachability is now a state that is OBSERVED rather than assumed. This
 * module owns only the polling policy; server.mjs owns the transport and the
 * per-slot bookkeeping, exactly as auto-share.mjs splits decisions from effects.
 */

/**
 * Poll a tunnel URL until it answers, or give up.
 *
 * "Answers" means ANY HTTP response, including 401 and 404. The origin behind a
 * preview tunnel is hooop's own listener, which refuses ungranted requests — so a
 * status code is proof the edge is routing to us, and demanding a 2xx would
 * report a working tunnel as broken.
 *
 * @param {object} deps
 * @param {string} deps.url                          hostname to probe
 * @param {(url: string) => Promise<boolean>} deps.probe  true iff it answered
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {number} [deps.attempts]   probes before giving up (first is immediate)
 * @param {number} [deps.intervalMs] wait between probes
 * @param {(...args: unknown[]) => void} [deps.log]
 * @returns {Promise<{reachable: boolean, attempts: number}>}
 */
export async function waitForTunnelReachable({
  url,
  probe,
  sleep,
  attempts = 30,
  intervalMs = 3000,
  log = () => {},
}) {
  for (let i = 1; i <= attempts; i++) {
    // A throwing probe is a failed probe. DNS not resolving yet raises rather
    // than returning a status, and that is the overwhelmingly common case here —
    // it must read as "not yet", never as an error worth aborting the wait for.
    let ok = false;
    try {
      ok = await probe(url);
    } catch {
      ok = false;
    }
    if (ok) return { reachable: true, attempts: i };
    if (i < attempts) await sleep(intervalMs);
  }
  log("tunnel never became reachable:", url, `(${attempts} probes)`);
  return { reachable: false, attempts };
}
