/**
 * Pull a quick tunnel's hostname out of cloudflared's output.
 *
 * Looks trivial, and was, until it silently handed out a URL that could never
 * work. cloudflared registers a quick tunnel by POSTing to its control plane at
 * `https://api.trycloudflare.com/tunnel` (the `--quick-service` default). When
 * that request fails, it reports the failure with the endpoint embedded in the
 * message:
 *
 *   failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": ...
 *
 * A plain `https://<label>.trycloudflare.com` match happily reads the CONTROL
 * PLANE out of that error and calls it the tunnel. Everything downstream then
 * behaves as though the tunnel came up: Share returns 200, the host gets a link,
 * and the link goes to Cloudflare's API rather than to this machine. The only
 * hint is cloudflared exiting a moment later, which reads as a tunnel that died
 * rather than one that was never born.
 *
 * The invariant that makes this safe: a quick tunnel hostname is a RANDOM label
 * assigned per tunnel, and it is never the service that assigns it. So the
 * service host is excluded by name, and any line that reads as a failure is
 * refused outright — an error mentioning a hostname is not the same as a banner
 * announcing one.
 */

/** Hosts that belong to the quick tunnel control plane, never to a tunnel. */
const SERVICE_HOSTS = new Set(["api.trycloudflare.com"]);

const CANDIDATE_RE = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/gi;

/**
 * cloudflared's own vocabulary for "this went wrong". A hostname quoted inside
 * one of these is being blamed, not announced, so the whole line is discarded.
 * Belt and braces next to SERVICE_HOSTS: it also covers a future release that
 * mentions some other trycloudflare.com host while failing.
 */
const FAILURE_RE = /\b(ERR|FTL)\b|error=|failed|unable to|refused|timeout/i;

/**
 * @param {string} text  a chunk of cloudflared stdout/stderr
 * @returns {string|null} the tunnel URL, or null if this chunk announces none
 */
export function parseQuickTunnelUrl(text) {
  if (!text) return null;
  // Line by line: a chunk can carry the banner and an unrelated warning at once,
  // and rejecting the whole chunk over the warning would lose a live tunnel.
  for (const line of String(text).split("\n")) {
    if (FAILURE_RE.test(line)) continue;
    for (const [url, host] of line.matchAll(CANDIDATE_RE)) {
      if (!SERVICE_HOSTS.has(host.toLowerCase())) return url;
    }
  }
  return null;
}
