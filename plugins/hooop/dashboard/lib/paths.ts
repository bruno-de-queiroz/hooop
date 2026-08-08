import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = join(homedir(), ".claude", "hooop");
export const EVENTS_FILE = join(STATE_DIR, "events.jsonl");
export const DB_PATH = join(STATE_DIR, "events.db");
export const DASHBOARD_PID = join(STATE_DIR, "dashboard.pid");
export const DASHBOARD_LOG = join(STATE_DIR, "dashboard.log");
export const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "sessions");
export const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");

// Embedding dimension. Default matches OpenAI text-embedding-3-small.
// If you switch to a smaller local model (e.g. Ollama nomic-embed-text = 768,
// bge-small = 384), set EMBED_DIM in hooop.env and re-run setup so the
// vec0 virtual table is recreated with the right dim.
export const EMBED_DIM = parseInt(process.env.EMBED_DIM ?? "1536", 10) || 1536;
