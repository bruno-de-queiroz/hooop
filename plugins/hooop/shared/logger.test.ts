import { describe, it, expect } from "vitest";
import { __testing__ } from "./logger";

const { redactString, serializeError, normalizeCtx } = __testing__;

describe("redactString", () => {
  it("redacts 64-hex tokens (sandbox/dashboard/hook style)", () => {
    const token = "a".repeat(64);
    expect(redactString(`token=${token} ok`)).toBe("token=[redacted] ok");
  });

  it("redacts Anthropic-style sk-ant- keys", () => {
    expect(redactString("key=sk-ant-AbCdEf012345_-AbCdEf done")).toBe("key=[redacted] done");
  });

  it("redacts Bearer header values", () => {
    expect(redactString("Authorization: Bearer abcdef.1234-_~+/")).toBe("Authorization: [redacted]");
  });

  it("redacts a JWT-shaped string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4f";
    expect(redactString(`auth=${jwt}`)).toBe("auth=[redacted]");
  });

  it("leaves benign strings alone", () => {
    expect(redactString("session not controllable")).toBe("session not controllable");
  });
});

describe("serializeError", () => {
  it("captures message + name + stack + code from an Error", () => {
    const err = new Error("boom") as NodeJS.ErrnoException;
    err.code = "EBOOM";
    const out = serializeError(err) as { message: string; name?: string; stack?: string; code?: string };
    expect(out.message).toBe("boom");
    expect(out.name).toBe("Error");
    expect(out.code).toBe("EBOOM");
    expect(out.stack).toContain("Error: boom");
  });

  it("redacts a token that leaked into an Error message", () => {
    const token = "f".repeat(64);
    const err = new Error(`auth failed with token=${token}`);
    const out = serializeError(err) as { message: string; stack?: string };
    expect(out.message).toBe("auth failed with token=[redacted]");
    // Stack contains the message too; both should be scrubbed.
    expect(out.stack).not.toContain(token);
  });

  it("walks a cause chain", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    const out = serializeError(outer) as { cause: { message: string } };
    expect(out.cause.message).toBe("inner");
  });

  it("falls back to String() for non-Error values", () => {
    expect(serializeError("oops")).toBe("oops");
    expect(serializeError(42)).toBe("42");
  });
});

describe("normalizeCtx — recursive redaction", () => {
  it("redacts nested string (Bearer token deep in object)", () => {
    const ctx = { a: { b: { c: "Bearer abc123def456ghi789" } } };
    const out = normalizeCtx(ctx) as { a: { b: { c: string } } };
    expect(out.a.b.c).toBe("[redacted]");
  });

  it("redacts strings inside arrays, leaves benign entries alone", () => {
    const ctx = { items: ["sk-ant-aaaaaaaaaaaaaaaaaaaa", "ok"] };
    const out = normalizeCtx(ctx) as { items: string[] };
    expect(out.items[0]).toBe("[redacted]");
    expect(out.items[1]).toBe("ok");
  });

  it("caps recursion at depth 5 and replaces deeper values with [depth-capped]", () => {
    // Value nesting: a -> b -> c -> d -> e -> f -> g (7 levels)
    // redactValue starts at depth 1, so depth 6 triggers the cap.
    const ctx = { a: { b: { c: { d: { e: { f: { g: "secret" } } } } } } };
    const out = normalizeCtx(ctx) as { a: { b: { c: { d: { e: { f: unknown } } } } } };
    expect(out.a.b.c.d.e.f).toBe("[depth-capped]");
  });

  it("replaces circular references with [circular] without infinite looping", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const out = normalizeCtx({ ref: a }) as { ref: { self: unknown } };
    expect(out.ref.self).toBe("[circular]");
  });
});
