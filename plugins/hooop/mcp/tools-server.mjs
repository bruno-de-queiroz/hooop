#!/usr/bin/env node
// hooop tools MCP server — a zero-dependency stdio JSON-RPC server that re-provides
// the interactive tools headless `claude -p` DROPS (they're TUI-only). Confirmed
// absent from the init tool list in every permission mode, not ToolSearch-findable:
//
//   submit_plan(plan)       — submit an implementation plan for human review.
//   enter_plan_mode()       — switch the session into read-only plan mode.
//   ask_user_question(...)  — ask the operator a multiple-choice question and
//                             block until they answer (native AskUserQuestion is
//                             absent in headless mode, so the model has no way to
//                             ask a structured question without this).
//
// It also exposes hooop's LIVE PREVIEW tools, which have no native equivalent at
// all — they drive hooop's own preview-runner containers:
//
//   start_preview / share_preview / restart_preview / rebuild_preview /
//   stop_preview / list_previews
//
// Why this exists: without these, the model hunts for the native tool, fails, and
// falls back to prose (e.g. "AskUserQuestion isn't available"). Bundling this
// server (via the plugin's .mcp.json) gives the model tools that actually exist.
//
// Declaration-only: in normal operation the hooop PreToolUse permission gate
// intercepts these tool calls and drives the real behavior — plan capture /
// plan-mode flip / surfacing the question to the dashboard + relaying the answer
// — then answers the call itself. So `tools/call` here never actually runs. We
// still implement it (a benign ack) so the server is correct if a call ever
// reaches it (e.g. gate disabled). The sandbox gate is the single policy authority.
//
// Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We handle exactly
// what a client needs: initialize, notifications/initialized, tools/list,
// tools/call, and ping. stdout carries ONLY protocol messages; anything else
// goes to stderr.

import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "submit_plan",
    description:
      "Submit your implementation plan for human review. Call this when you've " +
      "finished investigating and are ready to propose a plan. The session stays " +
      "read-only until a human approves the plan; on approval you'll be asked to " +
      "proceed, on rejection you'll get feedback to revise. Pass the full plan as " +
      "the `plan` argument (a concise numbered list of steps, the files/areas " +
      "you'd touch, and how you'd verify it) — do not just describe it in prose.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The implementation plan, as markdown." },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    name: "enter_plan_mode",
    description:
      "Switch this session into read-only plan mode: you may only investigate " +
      "(Read/Grep/Glob) — edits, shell commands, and subagents are blocked — and " +
      "must call submit_plan with your plan before anything can change. Use this " +
      "when a task is complex enough to warrant proposing a plan first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ask_user_question",
    description:
      "Ask the operator a multiple-choice question and BLOCK until they answer — " +
      "use this instead of asking in prose whenever you need the user to choose " +
      "between options or confirm a decision you can't resolve yourself. Their " +
      "answer comes back as the next user message. (This is the headless " +
      "equivalent of the native AskUserQuestion tool.) Provide 1-4 questions, each " +
      "with 2-4 concrete options.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The full question to ask." },
              header: { type: "string", description: "Short label/chip for the question (<=12 chars)." },
              multiSelect: { type: "boolean", description: "Allow selecting multiple options." },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "The choice text." },
                    description: { type: "string", description: "What this option means / its trade-off." },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "start_preview",
    description:
      "Run this project in an isolated container and give the operator a live URL for it. " +
      "Use it whenever you've built or changed something with a browser UI (or an HTTP API) " +
      "and a human should look at it.\n\n" +
      "The arguments are a Dockerfile in JSON form. Map what you already know:\n" +
      "  WORKDIR     -> workdir   (relative to the session's workspace)\n" +
      "  ENV         -> env\n" +
      "  RUN         -> setup[]   (ordered, fail-fast, one log each)\n" +
      "  CMD         -> run       (the long-lived server command)\n" +
      "  HEALTHCHECK -> readyPath\n" +
      "hooop assigns the port and passes your commands to a shell VERBATIM — it never " +
      "rewrites them and never appends --host/--port flags. Read the port from $PORT (or " +
      "name your framework's own variable in port.env); binding 127.0.0.1 is fine, hooop " +
      "forwards to it.\n\n" +
      "DERIVE the spec from the repository — README first, then lockfiles, Makefile, " +
      "Procfile, docker-compose.yml, pyproject.toml, Cargo.toml, go.mod. Do NOT assume npm.\n\n" +
      "The container has node+npm, corepack (pnpm/yarn), bun, python3+uv, git and mise. " +
      "For anything else, install it in a setup step with mise (it reads the repo's own " +
      ".tool-versions/.nvmrc/.python-version), uv, or pip --user. `apt-get install` will " +
      "NOT work: the runtime user is unprivileged.\n\n" +
      "If you may need to OPERATE the UI yourself later, declare what it can do as you " +
      "write it: document.modelContext.registerTool({name, description, inputSchema, execute}) " +
      "(W3C WebMCP). A few lines next to the handlers you already have, inert in browsers " +
      "that lack it, and it lets you drive the app by intent — call_page_tool('add_todo', " +
      "{text}) — instead of hunting for selectors in someone's live screen.\n\n" +
      "Each preview starts from a cold container, so keep setup steps idempotent. " +
      "Three previews can run at once across all sessions, one per session. " +
      "Starting a preview does NOT expose it to anyone but the local operator — call " +
      "share_preview for that.\n\n" +
      "Examples:\n" +
      "  Node:   {name:'web', setup:['npm ci'], run:'npm run dev -- --port $PORT'}\n" +
      "  Python: {name:'api', setup:['uv sync'], run:'uv run uvicorn app:app --port $PORT'}\n" +
      "  Go:     {name:'svc', setup:['mise install','mise exec -- go build -o svc ./cmd'], run:'./svc -addr :$PORT'}",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short label for the preview, shown in the dashboard." },
        workdir: { type: "string", description: "Directory to run in, relative to the session workspace (e.g. the name of a directory you just cloned into). Omit for the workspace root." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for every setup step and the run command." },
        setup: { type: "array", items: { type: "string" }, description: "Ordered shell commands to prepare the project (install deps, build). Fail-fast: the first non-zero exit stops the preview and reports that step." },
        run: { type: "string", description: "The long-lived command that serves the app. Must keep running." },
        port: {
          type: "object",
          properties: { env: { type: "string", description: "Extra env var name to receive the port, if your framework doesn't read PORT." } },
          additionalProperties: false,
        },
        readyPath: { type: "string", description: "URL path polled to decide the app is up. Defaults to '/'. Any HTTP status counts." },
        readyTimeoutSec: { type: "number", description: "How long to wait for the app to answer before declaring failure. Defaults to 120." },
      },
      required: ["name", "run"],
      additionalProperties: false,
    },
  },
  {
    name: "share_preview",
    description:
      "Ask the operator to make a running preview reachable by everyone in this session " +
      "(including peers co-driving it from elsewhere). This opens a permission card and " +
      "BLOCKS until a human decides — it is never auto-approved, because it publishes " +
      "code you wrote to a public tunnel URL. On approval the URL comes back in the result. " +
      "A preview that is merely running is already visible to the local operator; only call " +
      "this when someone else needs to see it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The preview id from start_preview or list_previews." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "restart_preview",
    description:
      "Respawn a preview's run command without re-running its setup steps. Use after " +
      "editing source that the dev server didn't pick up on its own (hooop does not " +
      "install a file watcher — whatever hot reload your framework manages is its own).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "rebuild_preview",
    description:
      "Re-run every setup step, then respawn the run command. Use after changing " +
      "dependencies or anything a build step consumes.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_preview",
    description: "Stop a preview and free its slot.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_previews",
    description:
      "List the previews running across all sessions, with each one's spec, state, " +
      "current step and URL. Use it to check on a preview that was still installing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },

  // ── driving the preview ────────────────────────────────────────────────────
  // These act on the page the OPERATOR is looking at, not on a browser of your
  // own. That is the point: they watch you use what you built. It also means
  // they fail when nobody has the panel open, and that failure is not something
  // to route around — there is deliberately no headless fallback.
  {
    name: "page_snapshot",
    description:
      "Read the preview page the operator is watching: its title, URL, and every " +
      "element that can be interacted with, each with a selector to use with " +
      "page_click / page_type. Call this before acting — the selectors come from " +
      "the live DOM, so guessing them from your source is how you click the wrong " +
      "thing. Fails if nobody has the Browser panel open; ask them to open it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "page_click",
    description:
      "Click an element in the preview the operator is watching. The click is real " +
      "— it runs the app's own handlers — and is drawn on screen so the humans " +
      "watching can see what you did. Use a selector from page_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "A CSS selector from page_snapshot." },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "page_type",
    description:
      "Type into an input or textarea in the preview the operator is watching. Sets " +
      "the value and fires the input/change events a framework listens for, so React " +
      "and friends see it as real typing.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "A CSS selector from page_snapshot." },
        text: { type: "string", description: "The value to put in the field." },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_page_tools",
    description:
      "List the tools the previewed app declares about itself, via the W3C WebMCP " +
      "API (document.modelContext.registerTool). An app that declares 'add_todo({text})' " +
      "can be driven by intent instead of by clicking through its UI, which is both " +
      "more reliable and readable to whoever is watching. Returns an empty list for an " +
      "app that declares nothing — use page_snapshot and page_click there.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "call_page_tool",
    description:
      "Call one of the tools the previewed app declared, by name, with arguments " +
      "matching the inputSchema from list_page_tools.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A tool name from list_page_tools." },
        arguments: { type: "object", description: "Arguments matching that tool's inputSchema." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  // Notifications have no id and expect no response.
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize": {
      const clientProto = msg.params?.protocolVersion;
      reply(msg.id, {
        // Echo the client's protocol version when provided so we never mismatch.
        protocolVersion: typeof clientProto === "string" ? clientProto : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "hooop-tools", version: "0.1.0" },
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return; // notification, no reply
    case "ping":
      if (!isNotification) reply(msg.id, {});
      return;
    case "tools/list":
      reply(msg.id, { tools: TOOLS });
      return;
    case "tools/call": {
      // Normally unreachable — the gate answers these out of band and DENIES
      // dispatch (deny-and-relay for an ask, deny-and-capture for a plan). So
      // reaching this handler means the gate ALLOWED the call and none of the real
      // behavior ran: no card, no capture, no answer coming.
      //
      // These strings are therefore a failure report, not an ack. A cheerful
      // "received" here is indistinguishable from success, which is strictly worse
      // than an error: the model proceeds believing a question was answered or a
      // plan was filed, and the operator never learns either happened. That is
      // exactly how an auto-mode guard that missed this server's own tool alias
      // turned every ask into a silent no-op. Say plainly what did NOT happen, and
      // name the fallback.
      const name = msg.params?.name;
      const PREVIEW_TOOLS = new Set([
        "start_preview", "share_preview", "restart_preview",
        "rebuild_preview", "stop_preview", "list_previews",
      ]);
      const PAGE_TOOLS = new Set([
        "page_snapshot", "page_click", "page_type", "list_page_tools", "call_page_tool",
      ]);
      const text =
        name === "submit_plan"
          ? "NOT SUBMITTED: hooop's permission gate did not capture this plan, so it was never sent for review. Do not treat it as approved. Report that plan submission is broken instead of proceeding."
          : name === "enter_plan_mode"
            ? "NOT ENGAGED: hooop's permission gate did not apply plan mode, so this session is NOT read-only. Do not assume investigation-only enforcement is active."
            : name === "ask_user_question"
              ? "NOT DELIVERED: your question never reached the operator and no answer is coming — hooop's permission gate allowed this call instead of routing it to the dashboard. Do not assume any option was chosen. Ask your question as plain text in your reply instead."
              : PREVIEW_TOOLS.has(name)
                // Same failure shape as the tools above, and it matters most for
                // share_preview: a cheerful ack there would tell the model a URL
                // is live and reachable by the session's peers when nothing was
                // started, nothing was approved and no human was ever asked.
                ? `NOT DONE: hooop's permission gate did not handle ${name}, so nothing happened — no preview was started, changed, or shared, and no URL exists. Do not report a preview to the user. Say that hooop's preview support is not working in this session.`
                : PAGE_TOOLS.has(name)
                  // The same lie, in the form that would be hardest to catch:
                  // these tools act on somebody's screen, so an ack the operator
                  // did not see anything happen for is a direct contradiction of
                  // what they are looking at.
                  ? `NOT DONE: hooop's permission gate did not handle ${name}, so nothing happened in anyone's browser — no page was read, clicked or typed into. Do not describe the page or claim you interacted with it. Say that hooop's preview driving is not working in this session.`
                  : `Unknown tool: ${name}`;
      reply(msg.id, { content: [{ type: "text", text }] });
      return;
    }
    default:
      if (!isNotification) replyError(msg.id, -32601, `method not found: ${msg.method}`);
      return;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON lines
  }
  try {
    handle(msg);
  } catch (e) {
    process.stderr.write(`[hooop-plan] handler error: ${String(e?.message ?? e)}\n`);
    if (msg && msg.id != null) replyError(msg.id, -32603, "internal error");
  }
});
rl.on("close", () => process.exit(0));
