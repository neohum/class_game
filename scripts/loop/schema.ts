// schema.ts — structured-output layer for agent CLI responses.
//
// Every place the loop asks a model for machine-readable output used to do its
// own `output.match(/\{[\s\S]*\}/)` + JSON.parse + ad-hoc field checks. This
// module centralizes that into the Pydantic-AI pattern, dependency-free:
//
//   extractJson(text)             — robustly pull the JSON payload out of chatty
//                                   model output (fenced block, balanced scan,
//                                   or the whole text).
//   validate(value, schema)       — check it against a JSON-Schema subset and
//                                   return precise, promptable error strings.
//   parseStructured(text, schema) — the two combined: {ok, value, errors}.
//
// Callers that talk to an agent CLI use the errors for ONE format-feedback
// retry ("your previous output failed validation: <errors> — output ONLY the
// JSON") before giving up, which converts most malformed responses into valid
// ones without any harness-side special cases.
//
// Supported schema keywords (the subset the loop actually needs):
//   type (string|number|integer|boolean|object|array|null), enum, const,
//   properties, required, additionalProperties (false = reject extras),
//   items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The JSON-Schema subset this validator implements. Deliberately loose on the
 * keyword values — this is a thin validator, and a precise schema-of-schemas
 * would be a second spec to keep in sync with the one below.
 */
export interface Schema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

/** What extractJson found, if anything. */
export interface Extracted {
  ok: boolean;
  value?: unknown;
  raw?: string;
}

/** Extraction plus validation, as every caller consumes it. */
export interface Parsed<T = unknown> {
  ok: boolean;
  value: T | null;
  errors: string[];
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // string | number | boolean | object | undefined
}

/**
 * Validate `value` against a JSON-Schema-subset `schema`.
 * @returns {string[]} human/model-readable errors, empty when valid
 */
export function validate(value: any, schema: Schema | undefined, path = "$"): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return errors;

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(" | ")}, got ${JSON.stringify(value)}`);
    return errors;
  }

  if (schema.type) {
    const t = typeOf(value);
    const ok = schema.type === "integer" ? t === "number" && Number.isInteger(value) : t === schema.type;
    if (!ok) {
      errors.push(`${path}: expected ${schema.type}, got ${t}`);
      return errors; // no point checking children of the wrong type
    }
  }

  if (typeOf(value) === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: string shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: string longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`);
  }

  if (typeOf(value) === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }

  if (typeOf(value) === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) {
      value.forEach((item: unknown, i: number) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
    }
  }

  if (typeOf(value) === "object") {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required key missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) errors.push(`${path}.${key}: unexpected key (not in the schema)`);
      }
    }
  }

  return errors;
}

// Scan for the first balanced {...} or [...] in `text`, respecting strings and
// escapes, so prose before/after the payload (or a nested brace inside a string)
// can't break extraction the way a greedy regex does.
function balancedSlice(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pull the JSON payload out of chatty model output. Tries, in order:
 * a ```json fenced block, a balanced {...}/[...] scan, then the whole text.
 * @returns {{ok:boolean, value?:any, raw?:string}}
 */
export function extractJson(text: unknown): Extracted {
  const candidates: string[] = [];
  const fence = String(text ?? "").match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1]);
  const balanced = balancedSlice(String(text ?? ""));
  if (balanced) candidates.push(balanced);
  candidates.push(String(text ?? "").trim());

  for (const raw of candidates) {
    try {
      return { ok: true, value: JSON.parse(raw), raw };
    } catch {
      // Robust Fallback: Clean trailing commas & comments from dirty model JSON output
      try {
        const sanitized = raw
          .replace(/,\s*([}\]])/g, "$1") // Remove trailing commas
          .replace(/\/\/.*/g, "");       // Remove inline single-line comments
        return { ok: true, value: JSON.parse(sanitized), raw: sanitized };
      } catch {
        /* try next candidate */
      }
    }
  }
  return { ok: false };
}

/**
 * Extract + validate in one call.
 * @returns {{ok:boolean, value:any, errors:string[]}}
 */
export function parseStructured<T = unknown>(text: unknown, schema: Schema): Parsed<T> {
  const ex = extractJson(text);
  if (!ex.ok) return { ok: false, value: null, errors: ["no parseable JSON found in the output"] };
  const errors = validate(ex.value, schema);
  return { ok: errors.length === 0, value: ex.value as T, errors };
}

/**
 * One-line, promptable rendering of validation errors — meant to be embedded in
 * the format-feedback retry prompt sent back to the model.
 */
export function formatErrors(errors: string[] | undefined): string {
  return (errors || []).slice(0, 10).join("; ");
}

/**
 * Build the standard retry prompt: the original instruction plus what was wrong
 * with the previous answer. Keeping the phrasing in one place means every caller
 * retries the same way.
 */
export function retryPrompt(originalPrompt: string, errors: string[] | undefined, previousOutput: unknown = ""): string {
  const tail = previousOutput ? `\n\nYour previous output was:\n${String(previousOutput).slice(-1500)}` : "";
  return `${originalPrompt}\n\n[FORMAT ERROR] Your previous response failed schema validation: ${formatErrors(errors)}.${tail}\n\nRespond again with ONLY the corrected raw JSON — no markdown fences, no prose.`;
}

// `import.meta.url` is realpath-resolved by the loader, while `process.argv[1]` is
// the raw path the caller typed. On a symlinked path (macOS /tmp -> /private/tmp,
// /var -> /private/var, linked checkouts) the two differ and a naive comparison
// makes this CLI silently no-op with exit 0. Compare both through realpath.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

// CLI (mostly for debugging): `echo '<model output>' | node schema.ts check '<schema-json>'`
if (isMainModule) {
  const [cmd, schemaArg] = process.argv.slice(2);
  if (cmd !== "check" || !schemaArg) {
    console.error("usage: schema.ts check '<schema-json>'   (reads the model output from stdin)");
    process.exit(2);
  }
  const schema = JSON.parse(schemaArg);
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const r = parseStructured(input, schema);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 4);
}
