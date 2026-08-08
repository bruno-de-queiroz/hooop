import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { redactSecrets, isHostedEmbedding, hasHostedEmbeddingConsent, isEmbeddingConfigured } from "./embeddings";

const snapshot = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
  HOOOP_EMBED_HOSTED_CONSENT: process.env.HOOOP_EMBED_HOSTED_CONSENT,
};

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.HOOOP_EMBED_HOSTED_CONSENT;
});

afterEach(() => {
  process.env.OPENAI_API_KEY = snapshot.OPENAI_API_KEY ?? "";
  process.env.EMBEDDING_BASE_URL = snapshot.EMBEDDING_BASE_URL ?? "";
  process.env.HOOOP_EMBED_HOSTED_CONSENT = snapshot.HOOOP_EMBED_HOSTED_CONSENT ?? "";
  if (!snapshot.OPENAI_API_KEY) delete process.env.OPENAI_API_KEY;
  if (!snapshot.EMBEDDING_BASE_URL) delete process.env.EMBEDDING_BASE_URL;
  if (!snapshot.HOOOP_EMBED_HOSTED_CONSENT) delete process.env.HOOOP_EMBED_HOSTED_CONSENT;
});

describe("isEmbeddingConfigured / isHostedEmbedding", () => {
  it("reports unconfigured when neither env is set", () => {
    expect(isEmbeddingConfigured()).toBe(false);
    expect(isHostedEmbedding()).toBe(false);
  });

  it("reports local-configured when only EMBEDDING_BASE_URL is set", () => {
    process.env.EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    expect(isEmbeddingConfigured()).toBe(true);
    expect(isHostedEmbedding()).toBe(false);
  });

  it("reports hosted when OPENAI_API_KEY is set without a base URL", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(isHostedEmbedding()).toBe(true);
  });

  it("reports non-hosted when OPENAI_API_KEY accompanies a base URL (local proxy)", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.EMBEDDING_BASE_URL = "http://localhost:1234/v1";
    expect(isHostedEmbedding()).toBe(false);
  });
});

describe("hasHostedEmbeddingConsent", () => {
  it("returns false when env var is unset", () => {
    expect(hasHostedEmbeddingConsent()).toBe(false);
  });

  it("returns true only for explicit 'yes' (case-insensitive)", () => {
    process.env.HOOOP_EMBED_HOSTED_CONSENT = "yes";
    expect(hasHostedEmbeddingConsent()).toBe(true);
    process.env.HOOOP_EMBED_HOSTED_CONSENT = "YES";
    expect(hasHostedEmbeddingConsent()).toBe(true);
  });

  it("returns false for any other value (no implicit truthiness)", () => {
    for (const v of ["true", "1", "y", "ok"]) {
      process.env.HOOOP_EMBED_HOSTED_CONSENT = v;
      expect(hasHostedEmbeddingConsent(), v).toBe(false);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts OpenAI sk-* keys", () => {
    expect(redactSecrets("API key: sk-abcdef1234567890ABCDEF")).toBe("API key: [REDACTED:sk-key]");
  });

  it("redacts GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)", () => {
    const t = "ghp_" + "x".repeat(36);
    expect(redactSecrets(`token=${t}`)).toBe("token=[REDACTED:github-token]");
  });

  it("redacts AWS access key IDs", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE here")).toBe("[REDACTED:aws-access-key] here");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf";
    expect(redactSecrets(`Bearer ${jwt} extra`)).toContain("[REDACTED:jwt]");
  });

  it("redacts SECRET / TOKEN / KEY / PASSWORD / CREDENTIAL env-style assignments", () => {
    expect(redactSecrets("DATABASE_PASSWORD=hunter22")).toBe("DATABASE_PASSWORD=[REDACTED]");
    expect(redactSecrets("API_TOKEN: abc12345")).toBe("API_TOKEN=[REDACTED]");
    expect(redactSecrets("STRIPE_SECRET=sk_live_xxxxxxxxxxx")).toBe("STRIPE_SECRET=[REDACTED]");
  });

  it("redacts Authorization: Bearer headers", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi-jkl")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("leaves regular text alone", () => {
    expect(redactSecrets("Just some plain prose. No secrets here.")).toBe("Just some plain prose. No secrets here.");
  });
});

// ---- concurrency cap ----
//
// We test the limiter directly (withEmbedSlot) rather than going through
// embed() — that way we don't fight the OpenAI module's CJS/ESM interop.
// Production embed() composes withEmbedSlot + the real client; if the slot
// math works here, embed inherits it.

describe("withEmbedSlot: concurrency cap", () => {
  afterEach(() => {
    delete process.env.HOOOP_MAX_CONCURRENT_EMBEDS;
    delete process.env.HOOOP_MAX_EMBED_QUEUE;
  });

  it("limits in-flight calls to MAX_CONCURRENT_EMBEDS; queues the rest", async () => {
    process.env.HOOOP_MAX_CONCURRENT_EMBEDS = "2";
    process.env.HOOOP_MAX_EMBED_QUEUE = "10";
    vi.resetModules();
    const mod = await import("./embeddings");
    mod.__testing__.reset();

    const resolvers: Array<() => void> = [];
    const block = () => new Promise<void>((r) => { resolvers.push(r); });

    const p1 = mod.withEmbedSlot(block);
    const p2 = mod.withEmbedSlot(block);
    const p3 = mod.withEmbedSlot(block);

    await new Promise((r) => setTimeout(r, 5));

    expect(mod.__testing__.getInFlight()).toBe(2);
    expect(mod.__testing__.getQueueDepth()).toBe(1);
    expect(resolvers).toHaveLength(2);

    // Release the first in-flight; p3 should then dequeue and call block.
    resolvers[0]();
    await new Promise((r) => setTimeout(r, 5));
    expect(resolvers).toHaveLength(3);
    expect(mod.__testing__.getQueueDepth()).toBe(0);

    // Release the remaining two so the test can settle.
    resolvers[1]();
    resolvers[2]();
    await Promise.all([p1, p2, p3]);

    expect(mod.__testing__.getInFlight()).toBe(0);
    expect(mod.__testing__.getQueueDepth()).toBe(0);
  });

  it("rejects with TooManyConcurrentEmbedsError once the queue is full", async () => {
    process.env.HOOOP_MAX_CONCURRENT_EMBEDS = "1";
    process.env.HOOOP_MAX_EMBED_QUEUE = "1";
    vi.resetModules();
    const mod = await import("./embeddings");
    mod.__testing__.reset();

    const resolvers: Array<() => void> = [];
    const block = () => new Promise<void>((r) => { resolvers.push(r); });

    const p1 = mod.withEmbedSlot(block);   // takes the slot
    const p2 = mod.withEmbedSlot(block);   // takes the queue spot
    await new Promise((r) => setTimeout(r, 5));

    let caught: unknown = null;
    try { await mod.withEmbedSlot(block); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(mod.TooManyConcurrentEmbedsError);

    // Release the in-flight; queued one will then run.
    resolvers[0]();
    await new Promise((r) => setTimeout(r, 5));
    resolvers[1]();
    await Promise.all([p1, p2]);
  });

  it("releases the slot even when the wrapped fn throws", async () => {
    process.env.HOOOP_MAX_CONCURRENT_EMBEDS = "1";
    vi.resetModules();
    const mod = await import("./embeddings");
    mod.__testing__.reset();

    await expect(mod.withEmbedSlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(mod.__testing__.getInFlight()).toBe(0);
  });
});
