// mcp-harness.mjs — a local MCP server exposing the harness's own state.
//
// The agents in this harness used to reach the backlog, telemetry trail, risk
// scorer, and graph checkpoints by shelling out to `node scripts/loop/*.mjs`
// with per-prompt instructions on how to parse the output. This server
// standardizes that channel the MCP way: the same state, exposed as typed MCP
// tools over stdio, so ANY MCP-capable agent (Claude Code, Codex, Gemini CLI,
// ...) can query and mutate harness state without bespoke prompt plumbing.
//
// Registered in .mcp.json as:
//   "harness": { "command": "node", "args": ["scripts/loop/mcp-harness.mjs"] }
//
// Zero dependencies: MCP's stdio transport is newline-delimited JSON-RPC 2.0,
// which plain Node handles fine. State modules resolve from process.cwd(), so
// the server must be launched from the project root (which MCP clients do).
//
// Tools:
//   backlog_list       — tasks, optionally filtered by status
//   backlog_add        — queue a new task card
//   backlog_get        — one card's row
//   backlog_set_status — move a card between open|claimed|review|done|failed
//   loop_trail         — recent telemetry events (the current.md trail)
//   cooldowns          — which agent CLIs are rate-limited right now
//   risk_score         — framein path-risk score for a set of file paths
//   graph_state        — a card's state-graph checkpoint (node, step, history)
//   decision_pending   — deploys held by the persona gate, awaiting a human
//   decision_approve   — release a held deploy (same action as the Telegram ✅)
//   decision_reject    — revert + reopen a held card (same as the Telegram ❌)

import { getBacklog } from "./backlog.mjs";
import { recent } from "./telemetry.mjs";
import { activeCooldowns } from "./cooldown.mjs";
import { riskScore } from "./framein.mjs";
import { loadCheckpoint, listCheckpoints } from "./graph.mjs";
import { pendingCards, approveCard, rejectCard } from "./decide.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "harness", version: "0.2.0" };

const TOOLS = [
  {
    name: "backlog_list",
    description: "List the autonomous loop's task backlog, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "claimed", "review", "done", "failed"], description: "Only rows with this status" },
      },
    },
  },
  {
    name: "backlog_add",
    description: "Add a task card to the backlog for the autonomous loop to pick up.",
    inputSchema: {
      type: "object",
      required: ["card", "spec"],
      properties: {
        card: { type: "string", description: "URL-friendly lowercase slug, hyphens only" },
        spec: { type: "string", description: "Actionable instruction including the acceptance criterion" },
      },
    },
  },
  {
    name: "backlog_get",
    description: "Fetch one backlog card's full row (status, attempts, timestamps).",
    inputSchema: {
      type: "object",
      required: ["card"],
      properties: { card: { type: "string" } },
    },
  },
  {
    name: "backlog_set_status",
    description: "Move a backlog card to a new status (open|claimed|review|done|failed).",
    inputSchema: {
      type: "object",
      required: ["card", "status"],
      properties: {
        card: { type: "string" },
        status: { type: "string", enum: ["open", "claimed", "review", "done", "failed"] },
      },
    },
  },
  {
    name: "loop_trail",
    description: "Recent autonomous-loop telemetry events (newest first) — the 'why did the repo change' trail.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: "Max events (default 20)" } },
    },
  },
  {
    name: "cooldowns",
    description: "Agent CLIs currently rate-limited, with their reset times.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "risk_score",
    description: "Framein path-risk score (low|medium|high + reasons) for a set of changed file paths.",
    inputSchema: {
      type: "object",
      required: ["files"],
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Changed file paths" },
        spec: { type: "string", description: "Optional task intent as a fallback signal" },
      },
    },
  },
  {
    name: "graph_state",
    description: "A card's task-pipeline state-graph checkpoint (current node, step, history). Without a card, lists all checkpoints.",
    inputSchema: {
      type: "object",
      properties: { card: { type: "string" } },
    },
  },
  {
    name: "decision_pending",
    description: "Deploys the persona gate held for a human decision — the cards waiting for approve/reject.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "decision_approve",
    description: "Approve a held deploy: starts the deploy and records the ground-truth persona label. Same action as the Telegram ✅ tap. Only call this when the human has explicitly decided to approve.",
    inputSchema: {
      type: "object",
      required: ["card"],
      properties: {
        card: { type: "string" },
        force: { type: "boolean", description: "Approve even without a pending marker (e.g. retry after a failed deploy)" },
      },
    },
  },
  {
    name: "decision_reject",
    description: "Reject a held deploy: reverts the loop commit, reopens the card for the builder, records the label. Same action as the Telegram ❌ tap. Only call this when the human has explicitly decided to reject.",
    inputSchema: {
      type: "object",
      required: ["card"],
      properties: {
        card: { type: "string" },
        force: { type: "boolean", description: "Reject even without a pending marker (e.g. roll back an auto-approved deploy)" },
      },
    },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case "backlog_list": {
      const b = await getBacklog();
      return b.list(args.status);
    }
    case "backlog_add": {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(args.card || "")) throw new Error("card must be a lowercase hyphenated slug");
      if (!args.spec) throw new Error("spec is required");
      const b = await getBacklog();
      b.add(args.card, args.spec, "mcp");
      return { added: args.card };
    }
    case "backlog_get": {
      const b = await getBacklog();
      return b.get(args.card) ?? { error: `no card "${args.card}"` };
    }
    case "backlog_set_status": {
      const b = await getBacklog();
      if (!b.get(args.card)) throw new Error(`no card "${args.card}"`);
      b.setStatus(args.card, args.status);
      return { card: args.card, status: args.status };
    }
    case "loop_trail":
      return await recent(args.limit || 20);
    case "cooldowns":
      return activeCooldowns();
    case "risk_score":
      return riskScore(args.files || [], args.spec || "");
    case "graph_state": {
      if (!args.card) return listCheckpoints();
      const cp = loadCheckpoint(args.card);
      return cp ?? { error: `no graph checkpoint for "${args.card}"` };
    }
    case "decision_pending":
      return pendingCards();
    case "decision_approve":
      return await approveCard(args.card, { actor: "mcp", force: !!args.force });
    case "decision_reject":
      return await rejectCard(args.card, { actor: "mcp", force: !!args.force });
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  // Notifications (no id) never get a response.
  if (id === undefined || id === null) return;

  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      try {
        const result = await callTool(params.name, params.arguments || {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        // Tool-level failures are results, not protocol errors, per the MCP spec.
        reply(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
      }
    } else {
      replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    replyError(id, -32603, String(e?.message ?? e));
  }
}

// Newline-delimited JSON-RPC over stdio (the MCP stdio transport).
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, "parse error");
      continue;
    }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
