import { getDb, hasVecExtension } from "./db";
import { embed, isEmbeddingConfigured } from "./embeddings";
import { log } from "@shared/logger";

export type SearchType = "bm25" | "semantic" | "hybrid";

export interface SearchResult {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  score: number;
  rank: number;
  bm25_rank?: number;
  vec_distance?: number;
  /**
   * "hot" — row still in the live events.db; "arch" — already rotated.
   * Useful for the UI to show provenance; never affects ranking.
   */
  tier?: "hot" | "arch";
}

export interface SearchResponse {
  results: SearchResult[];
  type: SearchType;
  total: number;
  meta: {
    bm25_used: boolean;
    semantic_used: boolean;
    semantic_unavailable?: string;
  };
}

// Standard RRF k. Larger k = ranks matter less; smaller k = top results dominate.
const RRF_K = 60;

/**
 * Wrap a user query as an FTS5 phrase so hyphens, colons, parens, and other
 * operator characters are treated literally. Escape embedded double-quotes by
 * doubling them. We accept the trade-off that this disables FTS5 advanced
 * query syntax (AND/OR/NEAR/etc.) — typical dashboard search is keyword
 * lookup, not boolean composition, and operator confusion was producing
 * "no such column" errors on terms like `tool-name`.
 */
function fts5Phrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

/**
 * A session-scope restriction shared by both tiers. `ids` is deduped; `sql` is
 * a ready-to-AND fragment referencing the events table alias `e` (both tier
 * queries alias it as `e`). Callers bind `ids` as the trailing params.
 */
interface SessionScope {
  sql: string;
  ids: string[];
}

function scopeClause(sessions: string[]): SessionScope {
  const ids = [...new Set(sessions.filter((s) => typeof s === "string" && s.length > 0))];
  return { sql: `e.session_id IN (${ids.map(() => "?").join(", ")})`, ids };
}

export async function search(
  q: string,
  type: SearchType,
  limit: number,
  sessions?: string[],
): Promise<SearchResponse> {
  const trimmed = q.trim();
  if (!trimmed) {
    return { results: [], type, total: 0, meta: { bm25_used: false, semantic_used: false } };
  }

  // Optional session scope: a caller (the dashboard, for a peer) may restrict
  // results to a fixed set of session ids. An empty array means "no session
  // matches this scope" — return nothing rather than falling through to an
  // unscoped search, which would leak other sessions' events.
  const scope = sessions ? scopeClause(sessions) : null;
  if (scope && scope.ids.length === 0) {
    return { results: [], type, total: 0, meta: { bm25_used: false, semantic_used: false } };
  }

  const wantBM25 = type === "bm25" || type === "hybrid";
  const wantSemantic = type === "semantic" || type === "hybrid";

  let bm25Results: SearchResult[] = [];
  let semanticResults: SearchResult[] = [];
  let semanticUnavailable: string | undefined;

  if (wantBM25) {
    bm25Results = bm25SearchUnion(trimmed, limit * 2, scope);
  }

  if (wantSemantic) {
    if (!isEmbeddingConfigured()) {
      semanticUnavailable =
        "Semantic search not configured. Set EMBEDDING_BASE_URL (e.g. http://localhost:11434/v1 for Ollama) or OPENAI_API_KEY in ~/.claude/hooop/hooop.env. BM25 works without config.";
    } else if (!hasVecExtension()) {
      semanticUnavailable = "sqlite-vec extension not loaded; semantic search disabled.";
    } else {
      semanticResults = await semanticSearchUnion(trimmed, limit * 2, scope);
    }
  }

  let merged: SearchResult[];
  if (type === "bm25") merged = bm25Results.slice(0, limit);
  else if (type === "semantic") merged = semanticResults.slice(0, limit);
  else merged = rrf(bm25Results, semanticResults, limit);

  return {
    results: merged,
    type,
    total: merged.length,
    meta: {
      bm25_used: wantBM25,
      semantic_used: wantSemantic && !semanticUnavailable,
      ...(semanticUnavailable ? { semantic_unavailable: semanticUnavailable } : {}),
    },
  };
}

/**
 * BM25 across hot + arch. Each tier is queried independently with the same
 * cap and the results are merged client-side, then re-sorted by raw bm25 score.
 * Tier-tagged so the caller can show provenance.
 */
function bm25SearchUnion(q: string, limit: number, scope: SessionScope | null): SearchResult[] {
  const hot = bm25SearchTier(q, limit, "hot", scope);
  const arch = bm25SearchTier(q, limit, "arch", scope);
  const merged = dedupePreferHot([...hot, ...arch]);
  // bm25 returns a NEGATIVE score; lower (more negative) is better. Re-sort
  // the merged list and re-rank so RRF below sees a consistent order.
  merged.sort((a, b) => (a.bm25_rank ?? 0) - (b.bm25_rank ?? 0));
  return merged.slice(0, limit).map((r, i) => ({ ...r, score: -(r.bm25_rank ?? 0), rank: i }));
}

function bm25SearchTier(
  q: string,
  limit: number,
  tier: "hot" | "arch",
  scope: SessionScope | null,
): SearchResult[] {
  const db = getDb();
  const tableEvents = tier === "hot" ? "events" : "arch.events";
  const tableFts = tier === "hot" ? "events_fts" : "arch.events_fts";
  // Cross-DB FTS5 quirks:
  //   - `arch.events_fts MATCH ?` is rejected by SQLite's parser (treated as
  //     column-ref). The MATCH LHS must be the bare table name, even when
  //     FROM uses a schema prefix.
  //   - `bm25(arch.events_fts)` is similarly rejected; use the bare name.
  //   - User queries containing FTS5 operator chars (notably `-` for NOT)
  //     get parsed against the table's column list and produce
  //     "no such column" errors. Quoting the query as an FTS5 phrase
  //     (`"...""`) treats the whole input as a single phrase, neutralising
  //     those operators. This matches the user's mental model: type a
  //     keyword, get rows containing that keyword.
  try {
    const rows = db
      .prepare(
        `SELECT e.id, e.ts, e.session_id, e.hook_type, e.tool_name, e.text, e.content_hash,
                bm25(events_fts) AS bm25_rank
         FROM ${tableFts}
         JOIN ${tableEvents} e ON e.id = ${tableFts}.rowid
         WHERE events_fts MATCH ?${scope ? ` AND ${scope.sql}` : ""}
         ORDER BY bm25_rank
         LIMIT ?`
      )
      .all(fts5Phrase(q), ...(scope ? scope.ids : []), limit) as Array<{
        id: number; ts: string; session_id: string | null; hook_type: string | null;
        tool_name: string | null; text: string | null; content_hash: string | null;
        bm25_rank: number;
      }>;
    return rows.map((r, i) => ({
      id: r.id,
      ts: r.ts,
      session_id: r.session_id,
      hook_type: r.hook_type,
      tool_name: r.tool_name,
      text: r.text,
      bm25_rank: r.bm25_rank,
      score: -r.bm25_rank,
      rank: i,
      tier,
      content_hash: r.content_hash ?? undefined,
    } as SearchResult & { content_hash?: string }));
  } catch (err) {
    log.error("search", `bm25 ${tier} tier failed`, { err });
    return [];
  }
}

async function semanticSearchUnion(
  q: string,
  limit: number,
  scope: SessionScope | null,
): Promise<SearchResult[]> {
  const vectors = await embed([q]);
  if (!vectors || vectors.length === 0) return [];
  const queryVec = JSON.stringify(vectors[0]);
  const hot = semanticSearchTier(queryVec, limit, "hot", scope);
  const arch = semanticSearchTier(queryVec, limit, "arch", scope);
  const merged = dedupePreferHot([...hot, ...arch]);
  // Smaller distance = better (cosine / euclidean per vec0 setup); re-sort.
  merged.sort((a, b) => (a.vec_distance ?? 0) - (b.vec_distance ?? 0));
  return merged.slice(0, limit).map((r, i) => ({ ...r, score: -(r.vec_distance ?? 0), rank: i }));
}

function semanticSearchTier(
  queryVec: string,
  limit: number,
  tier: "hot" | "arch",
  scope: SessionScope | null,
): SearchResult[] {
  const db = getDb();
  const tableEvents = tier === "hot" ? "events" : "arch.events";
  const tableVec = tier === "hot" ? "events_vec" : "arch.events_vec";
  try {
    // sqlite-vec KNN picks the `k` nearest rows *before* any joined-table
    // constraint is applied, so the session filter runs as a post-filter. When
    // scoping to a session, widen `k` so enough in-session rows survive the
    // filter instead of being crowded out by nearer rows from other sessions
    // (bounded to keep the KNN scan cheap). The IN clause still guarantees no
    // out-of-scope row is ever returned.
    const k = scope ? Math.min(limit * 10, 500) : limit;
    const rows = db
      .prepare(
        `SELECT e.id, e.ts, e.session_id, e.hook_type, e.tool_name, e.text, e.content_hash,
                v.distance AS vec_distance
         FROM ${tableVec} AS v
         JOIN ${tableEvents} e ON e.id = v.rowid
         WHERE v.embedding MATCH ?
           AND k = ?${scope ? ` AND ${scope.sql}` : ""}
         ORDER BY v.distance
         LIMIT ?`
      )
      .all(queryVec, k, ...(scope ? scope.ids : []), limit) as Array<{
        id: number; ts: string; session_id: string | null; hook_type: string | null;
        tool_name: string | null; text: string | null; content_hash: string | null;
        vec_distance: number;
      }>;
    return rows.map((r, i) => ({
      id: r.id,
      ts: r.ts,
      session_id: r.session_id,
      hook_type: r.hook_type,
      tool_name: r.tool_name,
      text: r.text,
      vec_distance: r.vec_distance,
      score: -r.vec_distance,
      rank: i,
      tier,
      content_hash: r.content_hash ?? undefined,
    } as SearchResult & { content_hash?: string }));
  } catch (err) {
    log.error("search", `semantic ${tier} tier failed`, { err });
    return [];
  }
}

/**
 * Deduplicate when a content_hash appears in both tiers (crash-mid-rotation
 * window before the boot sweep cleans it up). Hot wins. Rows without a
 * content_hash fall through unchanged (legacy rows from before idempotency
 * landed).
 */
function dedupePreferHot<T extends SearchResult & { content_hash?: string }>(rows: T[]): T[] {
  const seenHashes = new Set<string>();
  // Hot tier always comes first in the input array; emit hot rows, then arch
  // rows that aren't shadowed by hot. Rows without a content_hash bypass
  // the dedup check entirely so legacy rows still appear.
  const out: T[] = [];
  for (const r of rows) {
    const h = r.content_hash;
    if (h && r.tier === "hot") {
      seenHashes.add(h);
      out.push(r);
    } else if (h && r.tier === "arch") {
      if (!seenHashes.has(h)) out.push(r);
    } else {
      out.push(r);
    }
  }
  return out;
}

interface Accumulator {
  score: number;
  row: SearchResult;
  bm25_rank?: number;
  vec_distance?: number;
}

/**
 * RRF fuses BM25 and semantic into a single ranked list. Rows are keyed by
 * `tier:id` so a row that exists in arch (id 42, tier "arch") and a row that
 * happens to share an autoincrement id 42 in hot don't collide. content_hash
 * dedup already happened in the upstream tier-merge step.
 */
function rrf(bm25: SearchResult[], semantic: SearchResult[], limit: number): SearchResult[] {
  const scores: Map<string, Accumulator> = new Map();
  const keyFor = (r: SearchResult) => `${r.tier ?? "hot"}:${r.id}`;

  for (const [i, r] of bm25.entries()) {
    const inc = 1 / (RRF_K + i + 1);
    const k = keyFor(r);
    const prev = scores.get(k);
    if (prev) {
      prev.score += inc;
      prev.bm25_rank = r.bm25_rank;
    } else {
      scores.set(k, { score: inc, row: r, bm25_rank: r.bm25_rank });
    }
  }
  for (const [i, r] of semantic.entries()) {
    const inc = 1 / (RRF_K + i + 1);
    const k = keyFor(r);
    const prev = scores.get(k);
    if (prev) {
      prev.score += inc;
      prev.vec_distance = r.vec_distance;
    } else {
      scores.set(k, { score: inc, row: r, vec_distance: r.vec_distance });
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s, i) => ({
      ...s.row,
      score: s.score,
      rank: i,
      bm25_rank: s.bm25_rank,
      vec_distance: s.vec_distance,
    }));
}
