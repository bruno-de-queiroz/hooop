/**
 * `@handle` mention names for session participants.
 *
 * A display name is free text ("Bruno de Queiroz", "안나", "Sam O'Neill"), and
 * the composer's mention token stops at whitespace — so `@Bruno de Queiroz`
 * would only ever match "Bruno". Every participant therefore gets a slug that
 * survives being typed into a message, and the roster resolves it back.
 *
 * Shared because BOTH sides need the same answer from the same input: the
 * dashboard derives handles for the roster and the autocomplete, and the
 * sandbox derives them again to decide who a `@handle` in a turn was aimed at
 * (push notification targeting). Two implementations would drift and silently
 * stop notifying the person who was actually named.
 *
 * Deliberately NOT stored anywhere: presence is ephemeral and rebuilt from the
 * live roster on every frame, so a handle is always derived, never persisted
 * and never authoritative for identity. It's a typing convenience.
 */

/** Characters a handle may contain — kept to what the composer's mention token
 *  and the transcript's chip regex both accept without escaping. */
function slug(name: string): string {
  return name
    .normalize("NFKD")
    // Strip combining marks so "José" and "Jose" produce the same handle rather
    // than one that looks identical but can't be typed on a plain keyboard.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A name with no latin characters at all (e.g. "안나") slugs to "" — fall back
 *  to something typeable and stable rather than an empty handle. */
const FALLBACK = "peer";

/**
 * Handles for a roster, in the order given, each unique within the roster.
 *
 * Collisions get a numeric suffix in roster order, so two people called "Sam"
 * are `sam` and `sam-2`. The caller must pass a DETERMINISTICALLY ORDERED
 * roster (listPresence sorts by participantId) or the same two people would
 * swap handles between frames — and a mention typed against one frame would
 * resolve to the other.
 */
export function deriveHandles(names: readonly string[]): string[] {
  const used = new Map<string, number>();
  return names.map((name) => {
    const base = slug(name) || FALLBACK;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  });
}

/** The handle for one name, ignoring collisions. Only safe where there's no
 *  roster to disambiguate against — prefer {@link deriveHandles}. */
export function toHandle(name: string): string {
  return slug(name) || FALLBACK;
}

/**
 * The `@handle`s named in a message, lowercased and without the sigil.
 *
 * Word-boundary anchored for the same reason the composer's trigger is: without
 * it "mail bruno@example.com" would notify Bruno every time somebody wrote out
 * an address. Returns handles that MIGHT name someone — resolving them against
 * an actual roster is the caller's job, since who is present depends on who is
 * asking.
 */
export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<=^|\s)@([a-z0-9-]+)/g)) out.add(m[1]);
  return [...out];
}
