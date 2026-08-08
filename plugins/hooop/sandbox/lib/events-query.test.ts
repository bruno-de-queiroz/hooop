import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./db", () => ({
  getDb: () => mockDb,
}));

// Mocked so listEvents' alias expansion is deterministic and the test
// doesn't drag in the live active-sessions registry. The mock returns
// just the requested id by default; individual tests override it.
const mockExpand = vi.fn((id: string) => [id]);
vi.mock("./active-sessions", () => ({
  expandSessionIds: (id: string) => mockExpand(id),
}));

let mockDb: any;

beforeEach(() => {
  mockDb = {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
    })),
  };
  mockExpand.mockReset();
  mockExpand.mockImplementation((id: string) => [id]);
});

import { listEvents } from "./events-query";

describe("listEvents — limit clamping", () => {
  it("uses default limit of 200 when limit is undefined", () => {
    listEvents({});
    const sql: string = mockDb.prepare.mock.calls[0][0];
    expect(sql).toContain("LIMIT ?");
    const allCall = mockDb.prepare.mock.results[0].value.all;
    expect(allCall).toHaveBeenCalledWith(200);
  });

  it("clamps limit=-1 to 1 (prevents SQLite LIMIT -1 returning full table)", () => {
    listEvents({ limit: -1 });
    const allCall = mockDb.prepare.mock.results[0].value.all;
    expect(allCall).toHaveBeenCalledWith(1);
  });

  it("clamps limit=0 to 1", () => {
    listEvents({ limit: 0 });
    const allCall = mockDb.prepare.mock.results[0].value.all;
    expect(allCall).toHaveBeenCalledWith(1);
  });

  it("clamps limit above 1000 down to 1000", () => {
    listEvents({ limit: 99999 });
    const allCall = mockDb.prepare.mock.results[0].value.all;
    expect(allCall).toHaveBeenCalledWith(1000);
  });

  it("passes through a valid limit unchanged", () => {
    listEvents({ limit: 42 });
    const allCall = mockDb.prepare.mock.results[0].value.all;
    expect(allCall).toHaveBeenCalledWith(42);
  });

  it("floors float limit values", () => {
    listEvents({ limit: 7.9 });
    const allCall = mockDb.prepare.mock.results[0].value.all;
    expect(allCall).toHaveBeenCalledWith(7);
  });

  it("adds WHERE clauses for filter params when provided", () => {
    listEvents({ hook: "PreToolUse", session: "s1", limit: 10 });
    const sql: string = mockDb.prepare.mock.calls[0][0];
    expect(sql).toContain("hook_type = ?");
    // The session filter expands through aliases — single id collapses
    // to `session_id IN (?)` rather than `session_id = ?`.
    expect(sql).toMatch(/session_id IN \(\?\)/);
  });

  it("omits WHERE when no filters provided", () => {
    listEvents({ limit: 10 });
    const sql: string = mockDb.prepare.mock.calls[0][0];
    expect(sql).not.toContain("WHERE");
  });

  it("expands the session filter to the full alias set", () => {
    // Regression: a session that has lived through `claude --resume`
    // cycles persists events under multiple canonical ids. The
    // dashboard's initial transcript fetch only knows the URL-anchored
    // id, so the sandbox MUST expand to every historical alias when
    // querying — otherwise the user sees an empty transcript for a
    // session that has been talking for an hour.
    mockExpand.mockImplementation((id: string) => {
      if (id === "canonical-now") {
        return ["canonical-now", "pending-a071", "old-canonical-52d1"];
      }
      return [id];
    });
    listEvents({ session: "canonical-now", limit: 10 });
    const sql: string = mockDb.prepare.mock.calls[0][0];
    expect(sql).toContain("session_id IN (?, ?, ?)");
    const allCall = mockDb.prepare.mock.results[0].value.all;
    const args = allCall.mock.calls[0];
    expect(args.slice(0, 3)).toEqual(["canonical-now", "pending-a071", "old-canonical-52d1"]);
    // Last arg is the limit.
    expect(args[args.length - 1]).toBe(10);
  });
});
