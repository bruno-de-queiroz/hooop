// One-off backfill for events that were ingested before the sqlite-vec rowid
// BigInt fix (see lib/ingestor.ts). Embeds every event row that has text but no
// vector and inserts it into events_vec with a BigInt rowid.
//
// Usage (inside the sandbox container, where better-sqlite3/sqlite-vec are the
// linux builds and the embedding env is present). The plugin is baked into the
// image but the sandbox/ source tree is not, so pass this file in — either copy
// it in first:
//   docker cp plugins/hooop/sandbox/scripts/backfill-embeddings.mjs hooop-agent-sandbox-1:/tmp/ \
//     && docker exec hooop-agent-sandbox-1 node /tmp/backfill-embeddings.mjs
// or run with the dev overlay (HOOOP_PLUGIN_DEV=1), which mounts the repo at
// /opt/hooop, then: node /opt/hooop/sandbox/scripts/backfill-embeddings.mjs
//
// Env: EMBEDDING_BASE_URL, EMBEDDING_MODEL (same vars the app uses).

import { createRequire } from "node:module";

const require = createRequire("/app/");
const Database = require("/app/node_modules/better-sqlite3");
const sqliteVec = require("/app/node_modules/sqlite-vec");

const DB_PATH = process.env.HOOOP_DB_PATH || "/home/agent/.claude/hooop/events.db";
const BASE_URL = process.env.EMBEDDING_BASE_URL;
const MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const API_KEY = process.env.OPENAI_API_KEY || "not-required";
const BATCH = Number(process.env.BACKFILL_BATCH || 16);
// nomic-embed-text (and most local models) truncate at ~2048 tokens anyway, so
// embedding megabyte-sized tool outputs wastes memory and can OOM the request.
// Cap the text we send; this also matches what the model would effectively use.
const MAX_CHARS = Number(process.env.BACKFILL_MAX_CHARS || 6000);

if (!BASE_URL && !process.env.OPENAI_API_KEY) {
  console.error("No EMBEDDING_BASE_URL or OPENAI_API_KEY set; cannot backfill.");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");
sqliteVec.load(db);

const pending = db
  .prepare(
    `SELECT e.id AS id, e.text AS text
     FROM events e
     LEFT JOIN events_vec v ON e.id = v.rowid
     WHERE v.rowid IS NULL AND e.text IS NOT NULL AND e.text <> ''
     ORDER BY e.id`
  )
  .all();

console.log(`Backfilling ${pending.length} events (model=${MODEL}, dim table check below)`);

async function embed(texts) {
  const url = `${BASE_URL.replace(/\/$/, "")}/embeddings`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!resp.ok) throw new Error(`embed HTTP ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  return json.data.map((d) => d.embedding);
}

const insertVec = db.prepare("INSERT INTO events_vec (rowid, embedding) VALUES (?, ?)");
let done = 0;
let failed = 0;

for (let i = 0; i < pending.length; i += BATCH) {
  const chunk = pending.slice(i, i + BATCH);
  try {
    const vectors = await embed(chunk.map((r) => r.text.slice(0, MAX_CHARS)));
    const tx = db.transaction(() => {
      for (let j = 0; j < chunk.length; j++) {
        insertVec.run(BigInt(chunk[j].id), JSON.stringify(vectors[j]));
      }
    });
    tx();
    done += chunk.length;
    process.stdout.write(`\r  embedded ${done}/${pending.length}`);
  } catch (err) {
    failed += chunk.length;
    console.error(`\n  batch @${i} failed:`, err.message);
  }
}

console.log(`\nDone. embedded=${done} failed=${failed} total_vec_rows=${db.prepare("SELECT COUNT(*) c FROM events_vec").get().c}`);
