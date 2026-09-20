// quality-contract.ts — deterministic acceptance coverage and failure taxonomy.

const ACCEPTANCE_HEADING = /^Acceptance criteria:\s*$/i;
const ACCEPTANCE_LINE = /^(?:[-*]\s*)?(?:(AC-\d+)\s*:\s*)?(.+?)\s*$/i;

/** One acceptance criterion parsed from a card spec. */
export interface Criterion {
  id: string;
  statement: string;
}

/** What the reviewer reported back for a criterion. */
export interface AcceptanceResult {
  id?: string;
  status?: string;
  evidence?: string;
}

export function acceptanceCriteria(spec: unknown): Criterion[] {
  const lines = String(spec || "").split(/\r?\n/);
  const found: Criterion[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (ACCEPTANCE_HEADING.test(line)) { inBlock = true; continue; }
    const inline = line.match(/^Acceptance:\s*(.+)$/i);
    if (inline) {
      const parsed = (inline[1] ?? "").match(ACCEPTANCE_LINE);
      if (parsed) found.push({ id: parsed[1]?.toUpperCase() || "", statement: parsed[2] ?? "" });
      continue;
    }
    if (!inBlock) continue;
    if (!line) continue;
    if (/^[A-Za-z][A-Za-z /_-]+:\s*/.test(line) && !/^[-*]/.test(line)) break;
    const parsed = line.match(ACCEPTANCE_LINE);
    if (!parsed || !/^[-*]/.test(line)) break;
    found.push({ id: parsed[1]?.toUpperCase() || "", statement: parsed[2] ?? "" });
  }

  const criteria = found.length
    ? found
    : [{ id: "AC-1", statement: String(spec || "").replace(/\s+/g, " ").trim() || "Complete the requested change" }];
  const used = new Set();
  return criteria.map((criterion, index) => {
    let id = criterion.id || `AC-${index + 1}`;
    while (used.has(id)) id = `AC-${index + 2}`;
    used.add(id);
    return { id, statement: criterion.statement };
  });
}

export function validateAcceptanceResults(criteria: Criterion[], results: unknown): string[] {
  const errors: string[] = [];
  const expected = new Map(criteria.map((c: Criterion) => [c.id, c]));
  const seen = new Set();
  for (const result of (Array.isArray(results) ? results : []) as AcceptanceResult[]) {
    const id = result.id ?? "";
    if (!expected.has(id)) errors.push(`unknown acceptance id: ${id}`);
    if (seen.has(id)) errors.push(`duplicate acceptance id: ${id}`);
    seen.add(id);
    if (result.status !== "pass") errors.push(`${id} is ${result.status || "missing status"}`);
    if (!String(result.evidence || "").trim()) errors.push(`${id} has no evidence`);
  }
  for (const id of expected.keys()) if (!seen.has(id)) errors.push(`missing acceptance result: ${id}`);
  return errors;
}

export function classifyFailure(text: unknown): string {
  const value = String(text || "").toLowerCase();
  if (/acceptance|requirement|spec|contract|인수|요구/.test(value)) return "spec_gap";
  if (/not implemented|missing feature|no changed files|미구현|누락/.test(value)) return "implementation_gap";
  if (/no test|test script|evidence|coverage|검증 수단/.test(value)) return "test_gap";
  if (/eacces|eperm|enoent|not found|missing required env|permission|권한|환경변수/.test(value)) return "environment";
  if (/timeout|timed out|flaky|intermittent|간헐/.test(value)) return "flaky";
  if (/integration|deploy|endpoint|smoke|통합|배포/.test(value)) return "integration";
  return "regression";
}

export function normalizeFailure(text: unknown): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z/g, "<timestamp>")
    .replace(/\b[0-9a-f]{12,64}\b/g, "<sha>")
    .replace(/[a-z]:[\\/][^\s"'`]+|\/(?:tmp|private\/tmp)\/[^\s"'`]+/gi, "<temp-path>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?|attempts?|iterations?)\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

export function isReproFirstRequired(spec: unknown): boolean {
  const text = String(spec || "").toLowerCase();
  return /repro[-_ ]?first|tdd|fail[-_ ]?first|재현\s*테스트|실패\s*확인/i.test(text);
}

export function validateReproEvidence(evidenceContent: string): { ok: boolean; reason?: string } {
  if (!evidenceContent || !evidenceContent.trim()) {
    return { ok: false, reason: "Repro evidence is empty" };
  }
  const hasFailureObserved = /fail|failed|error|red|reproduced|non-zero|exit\s*code\s*[1-9]|실패\s*확인/i.test(evidenceContent);
  if (!hasFailureObserved) {
    return { ok: false, reason: "Repro evidence does not record a failing pre-implementation test (Red step)" };
  }
  return { ok: true };
}

