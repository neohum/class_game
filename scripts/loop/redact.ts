// redact.ts — mandatory secret scrubbing for persisted/exported harness data.
// Agent prompts may legitimately contain credentials by accident. Nothing written
// to knowledge, telemetry, traces, or the shared hub may preserve those values.

const SECRET_ENV_NAME = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|database_url|connection_string)/i;

function envSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && String(value || "").length >= 6)
    .map(([, value]) => String(value))
    .sort((a, b) => b.length - a.length);
}

export function redactText(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let text = String(value ?? "");
  for (const secret of envSecrets(env)) text = text.split(secret).join("[REDACTED]");

  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|glpat|xox[baprs])[-_][-A-Za-z0-9_]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY))\s*[=:]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

/**
 * Scrub secrets from a value of any shape, preserving that shape.
 *
 * Generic in T because every caller feeds it a domain object (a knowledge entry,
 * a telemetry row) and expects the same object back — typing it as `unknown`
 * would push a cast onto each of them. The one place the shape does NOT survive
 * is a circular reference, which becomes the string "[CIRCULAR]"; that is the
 * cost of guaranteeing termination on data that came from an agent.
 */
export function redactValue<T>(value: T, env: NodeJS.ProcessEnv = process.env, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactText(value, env) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]" as T;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, env, seen)) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, SECRET_ENV_NAME.test(key) ? "[REDACTED]" : redactValue(item, env, seen)]),
  ) as T;
}
