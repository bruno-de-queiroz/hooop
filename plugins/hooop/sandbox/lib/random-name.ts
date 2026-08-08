/**
 * Haiku-style 3-word session names: <adjective>-<gerund>-<surname>.
 *
 * Matches the plan-file naming convention (~/.claude/plans/cryptic-honking-abelson.md),
 * so the dashboard's sidebar looks familiar to anyone who's seen those.
 *
 * Combinatorics: ~60 × 60 × 60 ≈ 216 000. Far more than the working set of
 * sessions a single user would carry concurrently. The id (uuid) is what
 * the registry keys off; this is only a label, so a collision wouldn't
 * cause a system fault — at worst two sessions would look the same in the
 * sidebar until one was renamed.
 */

const ADJECTIVES = [
  "amber", "brisk", "calm", "cosmic", "crisp", "cryptic", "curious",
  "dapper", "deft", "drowsy", "dusty", "eager", "earnest", "earthy",
  "eerie", "fabled", "fearless", "feisty", "fluent", "frosty", "gentle",
  "glossy", "golden", "graceful", "grumpy", "hazy", "humble", "icy",
  "idle", "jovial", "keen", "kind", "lanky", "lively", "lucky",
  "merry", "mighty", "misty", "modest", "nimble", "noble", "perky",
  "placid", "plucky", "quiet", "ragged", "rapid", "restless", "rowdy",
  "rustic", "sandy", "savvy", "shiny", "silent", "silky", "sleepy",
  "sly", "snug", "sober", "sprightly", "stoic", "stormy", "subtle",
  "sunny", "swift", "tame", "tepid", "tidy", "vivid", "wary", "wise",
];

const GERUNDS = [
  "ambling", "babbling", "barking", "beaming", "blooming", "blowing",
  "boiling", "brewing", "buzzing", "carving", "chasing", "chirping",
  "climbing", "coasting", "crawling", "creeping", "dancing", "darting",
  "diving", "dozing", "drifting", "drumming", "echoing", "fading",
  "fishing", "flashing", "fleeing", "flowing", "flying", "frolicking",
  "galloping", "gazing", "gliding", "glowing", "grazing", "growing",
  "hopping", "humming", "hunting", "jogging", "jumping", "laughing",
  "leaning", "leaping", "lingering", "listening", "marching", "meandering",
  "musing", "nesting", "padding", "perching", "plodding", "pondering",
  "prancing", "purring", "questing", "racing", "raining", "reading",
  "resting", "roaming", "rolling", "rustling", "scampering", "skating",
  "skipping", "sleeping", "sliding", "soaring", "sparring", "spinning",
  "splashing", "stalking", "strolling", "tumbling", "wandering", "weaving",
  "whirling", "whistling", "wondering", "writing",
];

const SURNAMES = [
  "abelson", "ada", "babbage", "bell", "boole", "carmack", "chomsky",
  "church", "codd", "curie", "darwin", "deming", "dijkstra", "edison",
  "einstein", "euler", "feynman", "fermi", "fourier", "gauss", "godel",
  "hamilton", "hopper", "hopf", "huffman", "joule", "kelvin", "kernighan",
  "knuth", "lamport", "leibniz", "lovelace", "mandelbrot", "marconi",
  "maxwell", "mccarthy", "mendel", "minsky", "newton", "noether", "ohm",
  "pascal", "pasteur", "pauling", "peano", "perlis", "planck", "poincare",
  "ramanujan", "ritchie", "russell", "shannon", "shockley", "stallman",
  "stroustrup", "tesla", "thompson", "torvalds", "turing", "vonneumann",
  "wirth", "yates", "yoda",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomSessionName(): string {
  return `${pick(ADJECTIVES)}-${pick(GERUNDS)}-${pick(SURNAMES)}`;
}
