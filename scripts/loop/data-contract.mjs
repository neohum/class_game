// data-contract.mjs — pre-write data contract guard for the autonomous loop.
//
// Atlan-style guard: before a builder agent writes a row to a database table or
// uploads an object to Wasabi (S3-compatible) storage, it must run its proposed
// shape/path past this guard. The master contract lives in AGENTS.md at the repo
// root, inside a ```yaml fence under a "## Data Contract" heading. A proposed
// write that violates the contract is BLOCKED (non-zero exit) and the violation
// is logged via telemetry so it can be escalated (e.g. to Telegram by the
// escalation layer that consumes 'guard' events).
//
// No external deps — node: builtins only. We parse only the tiny YAML subset the
// contract needs (see parseContractYaml) rather than pull in a yaml package; the
// autonomous loop must run on a bare Node install.
//
// FAIL-OPEN CHOICE (read this): if AGENTS.md is missing or has no contract block,
// we return ok:true (allow the write) and log a 'guard' telemetry event noting
// the contract was absent. We do this because blocking *every* write when no
// contract exists would brick the very first run before the human has authored a
// contract. The risk is real: a typo'd heading or deleted block silently
// disables the guard. We mitigate by always emitting a loud telemetry warning so
// the absence is visible in the action trail rather than failing closed-silent.

import { resolve, normalize, posix } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { log } from "./telemetry.mjs";

const ROOT = resolve(process.cwd());
const AGENTS_PATH = resolve(ROOT, "AGENTS.md");

// Exit codes (consistent with claim-task.mjs: 2 = usage, 3 = race-lost).
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_VIOLATION = 4; // 4 = contract violation

// --- telemetry helper -----------------------------------------------------

// Never let a telemetry failure crash the guard — the guard's verdict matters
// more than the bookkeeping. Mirrors telemetry.mjs's own never-throw contract.
async function logGuard(detail) {
  try {
    await log("guard", { actor: "data-contract", detail });
  } catch {
    /* swallow — a broken trail must not turn a write decision into a crash */
  }
}

// --- contract loading + minimal YAML-subset parser ------------------------

// Deliberately minimal. Supports ONLY the shapes the contract uses:
//
//   schemas:
//     <table>:
//       <field>: <type>
//       <field>?: <type>      # trailing ? marks an optional field
//   storage:
//     allowedPrefixes:
//       - <prefix>
//     allowedExtensions:
//       - <.ext>
//
// Indentation is significant and assumed to be spaces (two-space steps are
// conventional but we only compare relative depth, not a fixed step size).
// Anything fancier than the above (anchors, flow maps, multi-line strings) is
// out of scope on purpose — keep the blast radius of a hand-rolled parser tiny.
function parseContractYaml(yaml) {
  const contract = { schemas: {}, storage: { allowedPrefixes: [], allowedExtensions: [] } };

  const lines = yaml.split(/\r?\n/);
  let section = null; // "schemas" | "storage"
  let currentTable = null; // active table name under schemas
  let currentList = null; // active list name under storage (allowedPrefixes|allowedExtensions)
  let tableIndent = -1; // indent at which table names sit under schemas

  const indentOf = (s) => s.length - s.replace(/^ +/, "").length;
  const strip = (v) => v.trim().replace(/^["']|["']$/g, "");

  for (const raw of lines) {
    // Drop comments and blank lines. (We do not support inline comments after
    // values to avoid mangling values that legitimately contain '#'.)
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = indentOf(line);
    const content = line.trim();

    // Top-level keys (no indentation).
    if (indent === 0) {
      if (content === "schemas:") { section = "schemas"; currentTable = null; currentList = null; tableIndent = -1; }
      else if (content === "storage:") { section = "storage"; currentTable = null; currentList = null; }
      else { section = null; } // unknown top-level key — ignore the block
      continue;
    }

    if (section === "schemas") {
      // A table header looks like `tableName:` with nothing after the colon.
      if (/^[^:]+:\s*$/.test(content)) {
        if (tableIndent === -1) tableIndent = indent;
        if (indent === tableIndent) {
          currentTable = content.slice(0, -1).trim();
          contract.schemas[currentTable] = {};
          continue;
        }
      }
      // A field line looks like `field: type` (deeper than the table header).
      if (currentTable && indent > tableIndent && content.includes(":")) {
        const idx = content.indexOf(":");
        const field = content.slice(0, idx).trim();
        const type = strip(content.slice(idx + 1));
        if (field) contract.schemas[currentTable][field] = type;
      }
      continue;
    }

    if (section === "storage") {
      // List headers: `allowedPrefixes:` / `allowedExtensions:`.
      if (content === "allowedPrefixes:") { currentList = "allowedPrefixes"; continue; }
      if (content === "allowedExtensions:") { currentList = "allowedExtensions"; continue; }
      // List items: `- value`.
      if (currentList && content.startsWith("- ")) {
        contract.storage[currentList].push(strip(content.slice(2)));
        continue;
      }
      // A bare `- value` with no value, or some other key — ignore.
      continue;
    }
  }

  return contract;
}

// Pull the ```yaml fenced block that sits under the "## Data Contract" heading.
// Returns the raw YAML string, or null if the heading or fence is absent.
function extractContractBlock(md) {
  const lines = md.split(/\r?\n/);
  let inSection = false;
  let inFence = false;
  const collected = [];

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (heading) {
      const title = heading[2].trim().toLowerCase();
      if (title === "data contract") { inSection = true; continue; }
      // Any other heading ends the Data Contract section (unless we are mid-fence).
      if (inSection && !inFence) { inSection = false; }
    }
    if (!inSection) continue;

    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (!inFence) {
        // Only open on a yaml-tagged fence; ignore other fenced blocks (e.g. an
        // example shell command) that may precede the contract.
        if (fence[1].toLowerCase() === "yaml") inFence = true;
        continue;
      } else {
        // Closing fence — we have the whole block.
        return collected.join("\n");
      }
    }
    if (inFence) collected.push(line);
  }

  // Heading present but fence never closed (or never opened) => no usable block.
  return null;
}

// Load + parse the contract once per process. Returns:
//   { present: boolean, contract: {schemas, storage} }
// `present:false` signals the fail-open path (see file header).
let _cache = null;
async function loadContract() {
  if (_cache) return _cache;

  if (!existsSync(AGENTS_PATH)) {
    _cache = { present: false, contract: parseContractYaml("") };
    return _cache;
  }

  let raw;
  try {
    raw = readFileSync(AGENTS_PATH, "utf8");
  } catch {
    _cache = { present: false, contract: parseContractYaml("") };
    return _cache;
  }

  const block = extractContractBlock(raw);
  if (block == null) {
    _cache = { present: false, contract: parseContractYaml("") };
    return _cache;
  }

  _cache = { present: true, contract: parseContractYaml(block) };
  return _cache;
}

// --- type validation ------------------------------------------------------

const KNOWN_TYPES = new Set(["string", "number", "boolean", "integer", "timestamp", "json"]);

// ISO-8601-ish check for the `timestamp` type. We require a string that Date can
// parse AND that looks like a date (has a digit-dash-digit head) — `new Date`
// alone is too permissive (it accepts "monday").
function isIso8601(v) {
  if (typeof v !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/.test(v)) return false;
  return !Number.isNaN(Date.parse(v));
}

// Returns null if the value matches the declared type, or a reason string.
function typeMismatch(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string" ? null : "expected string";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "expected number";
    case "integer":
      return Number.isInteger(value) ? null : "expected integer";
    case "boolean":
      return typeof value === "boolean" ? null : "expected boolean";
    case "timestamp":
      return isIso8601(value) ? null : "expected ISO-8601 timestamp string";
    case "json":
      return value !== null && typeof value === "object" ? null : "expected json object";
    default:
      // Unknown declared type — a contract authoring error, not a record error.
      return "unknown type in contract";
  }
}

// --- public API -----------------------------------------------------------

/**
 * Validate a proposed DB row against the contract's schema for `tableName`.
 * @param {string} tableName
 * @param {Record<string, any>} record
 * @returns {Promise<{ok: boolean, violations: string[]}>}
 */
export async function checkSchema(tableName, record) {
  const { present, contract } = await loadContract();

  if (!present) {
    // Fail-open: no contract authored yet. Allow, but make the absence loud.
    await logGuard({ tableName, note: "no data contract defined — allowing write (fail-open)" });
    return { ok: true, violations: [] };
  }

  const violations = [];
  const schema = contract.schemas[tableName];

  if (!schema) {
    violations.push(`no schema defined for table "${tableName}"`);
    await logGuard({ tableName, violations });
    return { ok: false, violations };
  }

  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    violations.push("record must be a plain object");
    await logGuard({ tableName, violations });
    return { ok: false, violations };
  }

  // Build the set of declared field names (stripping the optional `?` marker),
  // and validate present values against their declared types.
  const declared = new Map(); // bareName -> { type, optional }
  for (const [decl, type] of Object.entries(schema)) {
    const optional = decl.endsWith("?");
    const name = optional ? decl.slice(0, -1).trim() : decl;
    declared.set(name, { type, optional });
  }

  // Missing required fields.
  for (const [name, { type, optional }] of declared) {
    const hasField = Object.prototype.hasOwnProperty.call(record, name);
    if (!hasField) {
      if (!optional) violations.push(`missing required field "${name}"`);
      continue;
    }
    if (!KNOWN_TYPES.has(type)) {
      violations.push(`field "${name}": unknown type in contract ("${type}")`);
      continue;
    }
    const reason = typeMismatch(type, record[name]);
    if (reason) violations.push(`field "${name}": ${reason}`);
  }

  // Extra fields not in the schema.
  for (const key of Object.keys(record)) {
    if (!declared.has(key)) violations.push(`unexpected field "${key}" not in contract`);
  }

  const ok = violations.length === 0;
  if (!ok) await logGuard({ tableName, violations });
  return { ok, violations };
}

/**
 * Validate a proposed Wasabi object key against the contract's storage rules.
 * Rules checked: no path traversal (`..`), no absolute keys, must match one of
 * the allowed prefixes, must end in one of the allowed extensions.
 * @param {string} path  the object key (e.g. "uploads/2026/report.pdf")
 * @returns {Promise<{ok: boolean, violations: string[]}>}
 */
export async function checkStoragePath(path) {
  const { present, contract } = await loadContract();

  if (!present) {
    await logGuard({ path, note: "no data contract defined — allowing upload (fail-open)" });
    return { ok: true, violations: [] };
  }

  const violations = [];

  if (typeof path !== "string" || path.trim() === "") {
    violations.push("object key must be a non-empty string");
    await logGuard({ path, violations });
    return { ok: false, violations };
  }

  // Normalize to POSIX-style separators for comparison. Object keys are always
  // forward-slash on S3/Wasabi regardless of the host OS, so we convert any
  // backslashes a Windows caller might pass before checking. We use node:path
  // for traversal detection rather than hand-rolling separator logic.
  const key = path.replace(/\\/g, "/");

  // Path traversal — check the raw segments AND the normalized form so that
  // neither "a/../b" nor an OS-normalized "..\\x" sneaks through.
  const segments = key.split("/");
  if (segments.includes("..") || normalize(path).split(/[\\/]/).includes("..")) {
    violations.push("path traversal (`..`) is not allowed");
  }

  // Absolute keys are never valid object keys.
  if (key.startsWith("/") || posix.isAbsolute(key)) {
    violations.push("object key must be relative (no leading `/`)");
  }

  const { allowedPrefixes, allowedExtensions } = contract.storage;

  if (allowedPrefixes.length) {
    const okPrefix = allowedPrefixes.some((p) => key.startsWith(p));
    if (!okPrefix) {
      violations.push(`prefix not allowed — must start with one of: ${allowedPrefixes.join(", ")}`);
    }
  }

  if (allowedExtensions.length) {
    const ext = posix.extname(key).toLowerCase();
    const allowed = allowedExtensions.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
    if (!allowed.includes(ext)) {
      violations.push(`extension not allowed — must be one of: ${allowed.join(", ")}`);
    }
  }

  const ok = violations.length === 0;
  if (!ok) await logGuard({ path, violations });
  return { ok, violations };
}

// --- CLI ------------------------------------------------------------------
//
//   node scripts/loop/data-contract.mjs check-schema <table> '<json>'
//   node scripts/loop/data-contract.mjs check-path   <objectKey>
//
// Exit: 0 = ok, 4 = violation(s), 2 = bad usage.
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);

  const report = (res) => {
    if (res.ok) {
      console.log("✓ contract OK");
    } else {
      console.log("✗ contract violation:");
      for (const v of res.violations) console.log(`  - ${v}`);
    }
    process.exit(res.ok ? EXIT_OK : EXIT_VIOLATION);
  };

  if (cmd === "check-schema") {
    const [table, json] = rest;
    if (!table || json == null) {
      console.error("usage: data-contract.mjs check-schema <table> '<json>'");
      process.exit(EXIT_USAGE);
    }
    let record;
    try {
      record = JSON.parse(json);
    } catch (e) {
      console.error(`invalid JSON record: ${e.message}`);
      process.exit(EXIT_USAGE);
    }
    report(await checkSchema(table, record));
  } else if (cmd === "check-path") {
    const [objectKey] = rest;
    if (!objectKey) {
      console.error("usage: data-contract.mjs check-path <objectKey>");
      process.exit(EXIT_USAGE);
    }
    report(await checkStoragePath(objectKey));
  } else {
    console.error("usage: data-contract.mjs <check-schema|check-path> ...");
    process.exit(EXIT_USAGE);
  }
}
