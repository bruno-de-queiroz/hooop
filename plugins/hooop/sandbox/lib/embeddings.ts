import OpenAI from "openai";
import { log } from "@shared/logger";

let _client: OpenAI | null = null;
let _warned = false;
let _consentWarned = false;

/**
 * Semantic search is opt-in. Configure via ~/.claude/hooop/hooop.env:
 *   - EMBEDDING_BASE_URL=<local OpenAI-compatible endpoint> (recommended)
 *   - OPENAI_API_KEY=<key> with no EMBEDDING_BASE_URL (hosted; ships data to
 *     a third party; requires HOOOP_EMBED_HOSTED_CONSENT=yes).
 *
 * If neither is set, BM25 is the only search mode.
 */
export function isEmbeddingConfigured(): boolean {
  return !!(process.env.OPENAI_API_KEY || process.env.EMBEDDING_BASE_URL);
}

/**
 * Hosted means the embedding request leaves this machine and lands in a
 * third-party API. We gate this behind an explicit consent env var because
 * the text we embed includes prompts, tool inputs/outputs, transcripts, and
 * cwd paths — any of which can carry secrets.
 */
export function isHostedEmbedding(): boolean {
  return !!process.env.OPENAI_API_KEY && !process.env.EMBEDDING_BASE_URL;
}

export function hasHostedEmbeddingConsent(): boolean {
  return (process.env.HOOOP_EMBED_HOSTED_CONSENT ?? "").toLowerCase() === "yes";
}

function getClient(): OpenAI | null {
  if (_client) return _client;
  if (!isEmbeddingConfigured()) {
    if (!_warned) {
      log.warn(
        "embeddings",
        "semantic search disabled (neither OPENAI_API_KEY nor EMBEDDING_BASE_URL set); BM25 still works"
      );
      _warned = true;
    }
    return null;
  }
  if (isHostedEmbedding() && !hasHostedEmbeddingConsent()) {
    if (!_consentWarned) {
      log.warn(
        "embeddings",
        "hosted embeddings require HOOOP_EMBED_HOSTED_CONSENT=yes; falling back to BM25 only"
      );
      _consentWarned = true;
    }
    return null;
  }
  const apiKey = process.env.OPENAI_API_KEY || "not-required";
  const baseURL = process.env.EMBEDDING_BASE_URL;
  _client = new OpenAI({ apiKey, baseURL });
  return _client;
}

/**
 * Best-effort scrub of common secret patterns from text before it leaves the
 * machine. NOT a security boundary — secrets in arbitrary places (e.g.
 * embedded in tool outputs or quoted in prompts) can still slip through.
 * The point is to make casual leakage less likely; defence-in-depth.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    // bearer / api-key tokens up to 256 chars
    .replace(/\b(sk-[A-Za-z0-9_-]{16,256})\b/g, "[REDACTED:sk-key]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g, "[REDACTED:github-token]")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED:aws-access-key]")
    .replace(/\b(ya29\.[A-Za-z0-9_-]{20,256})\b/g, "[REDACTED:google-oauth]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED:jwt]")
    // KEY=value / KEY: value where KEY ends in TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL))\s*[:=]\s*([^\s"'`]{4,256})/g, "$1=[REDACTED]")
    // Authorization: Bearer ...
    .replace(/\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, "$1[REDACTED]");
}

// ---- Concurrency limiter ----
//
// A search/embed flood would otherwise hammer the embedder endpoint without
// bound — both the hosted (OpenAI) and local (Ollama / DMR / llama.cpp) cases
// fall over under enough parallel requests. Cap in-flight calls and bound the
// wait queue so queue memory itself can't grow unbounded.
//
// Defaults: 4 concurrent, 100-deep queue. Both env-overridable.

const MAX_CONCURRENT_EMBEDS = parseInt(process.env.HOOOP_MAX_CONCURRENT_EMBEDS ?? "", 10) || 4;
const MAX_EMBED_QUEUE = parseInt(process.env.HOOOP_MAX_EMBED_QUEUE ?? "", 10) || 100;

export class TooManyConcurrentEmbedsError extends Error {
  constructor() {
    super("max embed queue depth exceeded");
    this.name = "TooManyConcurrentEmbedsError";
  }
}

let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * Acquire a slot, queue if necessary, throw if the queue is full. Exported
 * for tests; production code calls `withEmbedSlot()`.
 */
export function acquireEmbedSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_EMBEDS) {
    inFlight += 1;
    return Promise.resolve();
  }
  if (waiters.length >= MAX_EMBED_QUEUE) {
    return Promise.reject(new TooManyConcurrentEmbedsError());
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => { inFlight += 1; resolve(); });
  });
}

export function releaseEmbedSlot(): void {
  inFlight -= 1;
  const next = waiters.shift();
  if (next) next();
}

/**
 * Run `fn` under a bounded concurrency slot. The slot is released on both
 * success and failure. Used by `embed()`; exposed so tests can exercise the
 * limiter without going through the OpenAI client.
 */
export async function withEmbedSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireEmbedSlot();
  try {
    return await fn();
  } finally {
    releaseEmbedSlot();
  }
}

export async function embed(texts: string[]): Promise<number[][] | null> {
  const client = getClient();
  if (!client) return null;
  if (texts.length === 0) return [];

  return withEmbedSlot(async () => {
    const model = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    const scrubbed = texts.map(redactSecrets);
    const resp = await client.embeddings.create({ model, input: scrubbed });
    return resp.data.map((d) => d.embedding);
  });
}

// Test-only access to the limiter state. NOT exported in production builds —
// just reachable from sandbox/lib/embeddings.test.ts.
export const __testing__ = {
  getInFlight: () => inFlight,
  getQueueDepth: () => waiters.length,
  reset: () => { inFlight = 0; waiters.length = 0; },
};
