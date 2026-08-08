import { getDb } from "./db";
import { clampInt } from "@shared/clamp";
import { expandSessionIds } from "./active-sessions";

export interface EventsQuery {
  limit?: number;
  before?: number;
  hook?: string;
  tool?: string;
  session?: string;
}

export interface EventRow {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  // Who initiated this (shared-session attribution): "host", a guest's name,
  // or null. Extracted from the stored payload's ctx.author; null for events
  // predating attribution or not initiated by a participant.
  author: string | null;
  // ≤512px image thumbnails attached to a user turn (base64), or null. Extracted
  // from ctx.images so the transcript can show them for host and peers alike.
  images?: { media_type: string; data: string }[] | null;
  // Lifecycle marker for a turn that isn't ordinary chat — e.g. "plan-approval"
  // / "plan-rejection" for the host's plan-review decision. Extracted from
  // ctx.kind; lets the transcript re-style the turn. Null/absent for normal turns.
  kind?: string | null;
  // The subagent id, present ONLY when this tool/stop event fired INSIDE a
  // subagent (claude populates ctx.agent_id for PreToolUse/PostToolUse/
  // SubagentStop in a sidechain, and omits it for the main agent). The main
  // transcript uses it to hide subagent-internal activity, which is surfaced in
  // the Agents rail instead. Null/absent for main-agent events.
  agent_id?: string | null;
}

export interface EventRowFull extends EventRow {
  payload: unknown;
}

export function listEvents(query: EventsQuery): EventRow[] {
  const limit = clampInt(query.limit, { min: 1, max: 1000, fallback: 200 });
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.before != null && Number.isFinite(query.before)) {
    where.push("id < ?");
    params.push(query.before);
  }
  if (query.hook) {
    where.push("hook_type = ?");
    params.push(query.hook);
  }
  if (query.tool) {
    where.push("tool_name = ?");
    params.push(query.tool);
  }
  if (query.session) {
    // Expand the requested session id to its full alias set so the
    // transcript shows every event ever logged under the conversation,
    // even across `claude --resume` cycles that minted new canonical
    // ids. For an unknown session (deleted/expired) this collapses
    // back to just the requested id.
    const ids = expandSessionIds(query.session);
    where.push(`session_id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }

  const sql = `
    SELECT id, ts, session_id, hook_type, tool_name, text,
           json_extract(payload, '$.ctx.author') AS author,
           json_extract(payload, '$.ctx.kind') AS kind,
           json_extract(payload, '$.ctx.agent_id') AS agent_id,
           json_extract(payload, '$.ctx.images') AS images_json
    FROM events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY id DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = getDb().prepare(sql).all(...params) as (EventRow & { images_json?: string | null })[];
  // `json_extract` returns the images array as JSON text — rehydrate it so a
  // reloaded transcript shows the same thumbnails the live SSE feed carries.
  return rows.map(({ images_json, ...row }) => {
    let images: EventRow["images"] = null;
    if (typeof images_json === "string") {
      try { const p = JSON.parse(images_json); if (Array.isArray(p)) images = p; } catch { /* ignore */ }
    }
    return { ...row, images };
  });
}

export function getEvent(id: number): EventRowFull | null {
  const row = getDb()
    .prepare(
      "SELECT id, ts, session_id, hook_type, tool_name, text, json_extract(payload, '$.ctx.author') AS author, payload FROM events WHERE id = ?"
    )
    .get(id) as (EventRow & { payload: string | null }) | undefined;

  if (!row) return null;

  let payload: unknown = null;
  if (typeof row.payload === "string") {
    try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
  }

  return { ...row, payload };
}
