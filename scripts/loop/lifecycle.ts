// lifecycle.ts — versioned, reconnect-safe state shared by the browser Studio
// and the optional Wails desktop client.
//
// The underlying stores remain the source of truth. This module only projects
// them into an operator-facing lifecycle and gives that projection explicit
// snapshot/delta semantics. A client can therefore detect duplicate delivery,
// sequence gaps, server restarts, and stale data instead of silently painting an
// old screen as if it were current.

import { randomUUID } from "node:crypto";

export const LIFECYCLE_SCHEMA_VERSION = 1 as const;

export function lifecycleStreamTiming(inputPollMs: number): {
  pollMs: number;
  staleAfterMs: number;
  pingEveryTicks: number;
} {
  const pollMs = Math.max(100, Math.floor(Number.isFinite(inputPollMs) ? inputPollMs : 1_000));
  const staleAfterMs = Math.max(2_000, pollMs * 4);
  const pingEveryTicks = Math.max(1, Math.floor((staleAfterMs - 1) / (pollMs * 2)));
  return { pollMs, staleAfterMs, pingEveryTicks };
}

export type LifecycleStageId = "plan" | "build" | "verify" | "release" | "operate";
export type LifecycleStageStatus = "pending" | "ready" | "running" | "blocked" | "passed" | "failed";

export interface LifecycleStage {
  id: LifecycleStageId;
  label: string;
  order: number;
  status: LifecycleStageStatus;
  blockedReason: string | null;
}

export interface LifecycleView {
  stages: LifecycleStage[];
  currentStage: LifecycleStageId;
  sourceUpdatedAt: string | null;
  checks: CompletionCheck[];
  release: LifecycleReleaseView;
  hypercare: LifecycleHypercareView;
  costs: LifecycleCostView | null;
  agents: LifecycleAgentView[];
  recentActivity: LifecycleActivityView[];
}

export type CompletionCheckStatus = "pending" | "running" | "passed" | "blocked";

/** One human-auditable completion condition used by release and hypercare. */
export interface CompletionCheck {
  id: string;
  label: string;
  status: CompletionCheckStatus;
  owner: string;
  observedAt: string;
  evidence: string;
  approver: string | null;
  blockedReason: string | null;
}

export interface LifecycleReleaseCheck extends CompletionCheck {
  stage: string;
  phase: string;
}

export interface LifecycleReleaseLane {
  name: string;
  status: CompletionCheckStatus;
  checks: LifecycleReleaseCheck[];
  observedAt: string | null;
  blockedReason: string | null;
}

export interface LifecycleReleaseView {
  lanes: LifecycleReleaseLane[];
  /** Only a card already paused by the loop may be resumed. */
  resumeTarget: string | null;
}

export interface LifecycleHypercareView {
  status: CompletionCheckStatus;
  startedAt: string | null;
  observedAt: string | null;
  checks: CompletionCheck[];
}

export interface LifecycleCostView {
  calls: number;
  milliseconds: number;
  /** null means no invocation reported tokens; zero is a real reported value. */
  reportedTokens: number | null;
  reportedCalls: number;
  limits: Record<string, number | null>;
  exceeded: string[];
  tokenCapBlind: boolean;
}

export interface LifecycleAgentView {
  name: string;
  calls: number;
  milliseconds: number;
  reportedTokens: number | null;
  reportedCalls: number;
  jobs: string[];
  coolingDown: boolean;
  overridden: boolean;
}

export interface LifecycleActivityView {
  ts: string;
  kind: string;
  card: string | null;
  actor: string | null;
  detail: string;
}

export function completionCheck(input: CompletionCheck): CompletionCheck {
  return { ...input };
}

export interface HypercareExitInput {
  startedAt: string;
  observedAt?: string;
  minimumObservationMs: number;
  openIncidents: Array<{ severity: string; id: string }>;
  sloEvidence: string[];
  owner: string;
  approver?: string | null;
}

export interface HypercareExitVerdict {
  ok: boolean;
  checks: CompletionCheck[];
}

/** Fail-closed gate for ending post-release hypercare. */
export function evaluateHypercareExit(input: HypercareExitInput): HypercareExitVerdict {
  const observedAt = input.observedAt || new Date().toISOString();
  const elapsed = Date.parse(observedAt) - Date.parse(input.startedAt);
  const windowPassed = Number.isFinite(elapsed)
    && input.minimumObservationMs > 0
    && elapsed >= input.minimumObservationMs;
  const importantIncidents = input.openIncidents.filter((incident) => /^(P0|P1)$/i.test(incident.severity));
  const incidentsPassed = importantIncidents.length === 0;
  const sloPassed = input.sloEvidence.some((item) => String(item).trim().length > 0);
  const approver = input.approver || input.owner || null;

  const checks: CompletionCheck[] = [
    completionCheck({
      id: "observation-window",
      label: "최소 관찰 기간",
      status: windowPassed ? "passed" : "blocked",
      owner: input.owner,
      observedAt,
      evidence: `duration:${Math.max(0, Number.isFinite(elapsed) ? elapsed : 0)}ms`,
      approver,
      blockedReason: windowPassed ? null : `minimum observation ${input.minimumObservationMs}ms not reached`,
    }),
    completionCheck({
      id: "p0-p1-clear",
      label: "P0/P1 미해결 사고 없음",
      status: incidentsPassed ? "passed" : "blocked",
      owner: input.owner,
      observedAt,
      evidence: incidentsPassed ? "incidents:none" : `incidents:${importantIncidents.map((item) => item.id).join(",")}`,
      approver,
      blockedReason: incidentsPassed ? null : `open P0/P1: ${importantIncidents.map((item) => item.id).join(", ")}`,
    }),
    completionCheck({
      id: "slo-evidence",
      label: "SLO 관찰 증거",
      status: sloPassed ? "passed" : "blocked",
      owner: input.owner,
      observedAt,
      evidence: input.sloEvidence.filter(Boolean).join(",") || "slo-evidence:missing",
      approver,
      blockedReason: sloPassed ? null : "SLO evidence is required",
    }),
  ];
  return { ok: checks.every((item) => item.status === "passed"), checks };
}

interface CardLike {
  card?: string;
  status?: string;
  source?: string;
  updated_at?: string;
}

interface CheckpointLike {
  key?: unknown;
  node?: string;
  bp?: string | null;
  at?: string;
  updated_at?: string;
}

interface ActivityLike {
  id?: number;
  ts?: string;
  kind?: string;
  card?: string | null;
  actor?: string | null;
  detail?: unknown;
}

interface SpendLike {
  calls?: number;
  ms?: number;
  tokens?: number;
  reportedCalls?: number;
}

interface BudgetLike {
  ok?: boolean;
  exceeded?: string[];
  limits?: Record<string, number | null>;
  today?: SpendLike;
  todayByAgent?: Array<SpendLike & { agent?: string }>;
  cardSpend?: SpendLike | null;
  tokenCapBlind?: boolean;
}

interface LaneLike {
  job?: string;
  lane?: string;
  overridden?: boolean;
  coolingDown?: boolean;
}

export interface LifecycleViewInput {
  cards?: CardLike[];
  checkpoints?: CheckpointLike[] | Record<string, CheckpointLike>;
  activity?: ActivityLike[];
  budget?: BudgetLike | null;
  lanes?: LaneLike[];
}

export interface LifecycleFreshness {
  observedAt: string;
  staleAfterMs: number;
  sourceUpdatedAt: string | null;
}

export interface LifecycleEnvelope<T extends object> {
  schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  streamId: string;
  sequence: number;
  kind: "snapshot" | "delta";
  freshness: LifecycleFreshness;
  /** Present for a snapshot. */
  data?: T;
  /** Present for a delta; only changed top-level keys are included. */
  changes?: Partial<T>;
  removed?: string[];
}

export interface AppliedLifecycle<T extends object> {
  streamId: string;
  sequence: number;
  data: T;
  freshness: LifecycleFreshness;
}

function checkpointRows(input: LifecycleViewInput["checkpoints"]): CheckpointLike[] {
  if (Array.isArray(input)) return input;
  return Object.values(input || {});
}

function latestTimestamp(input: LifecycleViewInput): string | null {
  const values = [
    ...(input.cards || []).flatMap((card) => card.updated_at ? [card.updated_at] : []),
    ...checkpointRows(input.checkpoints).flatMap((cp) => cp.at || cp.updated_at ? [String(cp.at || cp.updated_at)] : []),
    ...(input.activity || []).flatMap((event) => event.ts ? [event.ts] : []),
  ];
  if (!values.length) return null;
  return values.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function stage(
  id: LifecycleStageId,
  label: string,
  order: number,
  status: LifecycleStageStatus,
  blockedReason: string | null = null,
): LifecycleStage {
  return { id, label, order, status, blockedReason };
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function detailObject(detail: unknown): Record<string, unknown> | null {
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    return detail as Record<string, unknown>;
  }
  if (typeof detail !== "string" || !detail.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function orderedActivity(input: ActivityLike[]): ActivityLike[] {
  return [...input].sort((a, b) => {
    const idDelta = numberOrZero(b.id) - numberOrZero(a.id);
    if (idDelta) return idDelta;
    return Date.parse(String(b.ts || "")) - Date.parse(String(a.ts || ""));
  });
}

function checkFromEvent(event: ActivityLike, includeRelease: true): LifecycleReleaseCheck | null;
function checkFromEvent(event: ActivityLike, includeRelease: false): CompletionCheck | null;
function checkFromEvent(
  event: ActivityLike,
  includeRelease: boolean,
): LifecycleReleaseCheck | CompletionCheck | null {
  const detail = detailObject(event.detail);
  if (!detail) return null;
  const status = String(detail.status || "") as CompletionCheckStatus;
  if (!detail.id || !detail.label || !["pending", "running", "passed", "blocked"].includes(status)) return null;
  const base: CompletionCheck = {
    id: String(detail.id),
    label: String(detail.label),
    status,
    owner: String(detail.owner || event.actor || ""),
    observedAt: String(detail.observedAt || event.ts || ""),
    evidence: String(detail.evidence || ""),
    approver: detail.approver == null ? null : String(detail.approver),
    blockedReason: detail.blockedReason == null ? null : String(detail.blockedReason),
  };
  if (!includeRelease) return base;
  if (!detail.stage || !detail.phase) return null;
  return { ...base, stage: String(detail.stage), phase: String(detail.phase) };
}

function newestChecks<T extends CompletionCheck>(
  events: ActivityLike[],
  kind: string,
  read: (event: ActivityLike) => T | null,
): T[] {
  const byId = new Map<string, T>();
  for (const event of events) {
    if (String(event.kind || "").toLowerCase() !== kind || byId.has(String(detailObject(event.detail)?.id || ""))) continue;
    const check = read(event);
    if (check) byId.set(check.id, check);
  }
  return [...byId.values()];
}

function activityDetail(event: ActivityLike): string {
  const detail = detailObject(event.detail);
  if (detail?.label && detail?.status) return `${String(detail.label)} · ${String(detail.status)}`;
  if (detail?.startedAt) return `startedAt ${String(detail.startedAt)}`;
  if (typeof event.detail === "string") return event.detail;
  if (event.detail == null) return "";
  try { return JSON.stringify(event.detail); } catch { return String(event.detail); }
}

function operatorProjection(input: LifecycleViewInput): Pick<
  LifecycleView,
  "checks" | "release" | "hypercare" | "costs" | "agents" | "recentActivity"
> {
  const events = orderedActivity(input.activity || []);
  const releaseChecks = newestChecks(events, "release.check", (event) => checkFromEvent(event, true));
  const hypercareChecks = newestChecks(events, "hypercare.check", (event) => checkFromEvent(event, false));
  const enter = events.find((event) => String(event.kind || "").toLowerCase() === "hypercare.enter");
  const exit = events.find((event) => String(event.kind || "").toLowerCase() === "hypercare.exit");
  const enterDetail = detailObject(enter?.detail);
  const completedIds = new Set(
    Array.isArray(enterDetail?.releaseChecks)
      ? enterDetail.releaseChecks.map((item) => String(item))
      : [],
  );

  const byStage = new Map<string, LifecycleReleaseCheck[]>();
  for (const check of releaseChecks) byStage.set(check.stage, [...(byStage.get(check.stage) || []), check]);
  const phaseOrder = new Map([["deploy", 1], ["verify", 2], ["regression", 3]]);
  const lanes = [...byStage.entries()].map(([name, checks]): LifecycleReleaseLane => {
    checks.sort((a, b) => (phaseOrder.get(a.phase) || 99) - (phaseOrder.get(b.phase) || 99));
    const blocked = checks.find((check) => check.status === "blocked");
    const running = checks.find((check) => check.status === "running");
    const complete = checks.length > 0 && checks.every((check) => completedIds.has(check.id));
    return {
      name,
      status: blocked ? "blocked" : complete ? "passed" : running ? "running" : "running",
      checks,
      observedAt: checks.map((check) => check.observedAt).filter(Boolean).sort().at(-1) || null,
      blockedReason: blocked?.blockedReason || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const enterId = numberOrZero(enter?.id);
  const incident = events.find((event) => {
    if (enter && numberOrZero(event.id) < enterId) return false;
    const text = `${event.kind || ""} ${activityDetail(event)}`.toLowerCase();
    return /\bp[01]\b/.test(text) && /\b(open|breach|failed|unresolved)\b/.test(text);
  });
  const exitedAfterEnter = Boolean(exit && (!enter || numberOrZero(exit.id) > enterId));
  const hypercareStatus: CompletionCheckStatus = incident
    ? "blocked"
    : exitedAfterEnter
      ? "passed"
      : enter
        ? "running"
        : "pending";
  const hypercare: LifecycleHypercareView = {
    status: hypercareStatus,
    startedAt: enter ? String(enterDetail?.startedAt || enter.ts || "") || null : null,
    observedAt: String(exit?.ts || enter?.ts || "") || null,
    checks: hypercareChecks,
  };

  const budget = input.budget || null;
  const today = budget?.today;
  const costs: LifecycleCostView | null = budget && today ? {
    calls: numberOrZero(today.calls),
    milliseconds: numberOrZero(today.ms),
    reportedTokens: numberOrZero(today.reportedCalls) > 0 ? numberOrZero(today.tokens) : null,
    reportedCalls: numberOrZero(today.reportedCalls),
    limits: { ...(budget.limits || {}) },
    exceeded: (budget.exceeded || []).map(String),
    tokenCapBlind: Boolean(budget.tokenCapBlind),
  } : null;

  const agentRows = new Map<string, LifecycleAgentView>();
  for (const spend of budget?.todayByAgent || []) {
    const name = String(spend.agent || "").trim();
    if (!name) continue;
    agentRows.set(name, {
      name,
      calls: numberOrZero(spend.calls),
      milliseconds: numberOrZero(spend.ms),
      reportedTokens: numberOrZero(spend.reportedCalls) > 0 ? numberOrZero(spend.tokens) : null,
      reportedCalls: numberOrZero(spend.reportedCalls),
      jobs: [],
      coolingDown: false,
      overridden: false,
    });
  }
  for (const lane of input.lanes || []) {
    const name = String(lane.lane || "").trim();
    if (!name) continue;
    const row = agentRows.get(name) || {
      name,
      calls: 0,
      milliseconds: 0,
      reportedTokens: null,
      reportedCalls: 0,
      jobs: [],
      coolingDown: false,
      overridden: false,
    };
    if (lane.job) row.jobs.push(String(lane.job));
    row.coolingDown ||= Boolean(lane.coolingDown);
    row.overridden ||= Boolean(lane.overridden);
    agentRows.set(name, row);
  }
  const agents = [...agentRows.values()]
    .map((agent) => ({ ...agent, jobs: [...new Set(agent.jobs)].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    checks: [...releaseChecks, ...hypercareChecks],
    release: {
      lanes,
      resumeTarget: (input.cards || []).find((card) => String(card.status || "").toLowerCase() === "paused")?.card || null,
    },
    hypercare,
    costs,
    agents,
    recentActivity: events.slice(0, 20).map((event) => ({
      ts: String(event.ts || ""),
      kind: String(event.kind || ""),
      card: event.card == null ? null : String(event.card),
      actor: event.actor == null ? null : String(event.actor),
      detail: activityDetail(event),
    })),
  };
}

/** Project backlog/checkpoint/telemetry state into the five lifecycle lanes. */
export function buildLifecycleView(input: LifecycleViewInput): LifecycleView {
  const cards = input.cards || [];
  const checkpoints = checkpointRows(input.checkpoints);
  const statuses = new Set(cards.map((card) => String(card.status || "open").toLowerCase()));
  const activity = input.activity || [];
  const activityText = activity
    .map((event) => `${event.kind || ""} ${typeof event.detail === "string" ? event.detail : JSON.stringify(event.detail ?? "")}`.toLowerCase())
    .join("\n");

  const hasPlan = cards.some((card) => card.source === "plan-doc")
    || activity.some((event) => String(event.kind || "").toLowerCase() === "plan");
  const plan = stage("plan", "계획", 1, hasPlan ? "passed" : "ready");

  let buildStatus: LifecycleStageStatus = cards.length ? "ready" : "pending";
  let buildBlock: string | null = null;
  if (statuses.has("failed")) buildStatus = "failed";
  else if (statuses.has("paused") || checkpoints.some((cp) => cp.bp)) {
    buildStatus = "blocked";
    const cp = checkpoints.find((item) => item.bp || item.node);
    buildBlock = cp?.bp || cp?.node ? `중단점: ${cp.bp || cp.node}` : "일시 중지된 카드";
  } else if (statuses.has("claimed")) buildStatus = "running";
  else if (cards.length && cards.every((card) => card.status === "review" || card.status === "done")) buildStatus = "passed";
  const build = stage("build", "빌드", 2, buildStatus, buildBlock);

  let verifyStatus: LifecycleStageStatus = "pending";
  if (statuses.has("failed")) verifyStatus = "failed";
  else if (statuses.has("review")) verifyStatus = "running";
  else if (cards.length && cards.every((card) => card.status === "done")) verifyStatus = "passed";
  const verify = stage("verify", "검증", 3, verifyStatus);

  const operator = operatorProjection(input);
  let releaseStatus: LifecycleStageStatus = "pending";
  if (operator.release.lanes.some((lane) => lane.status === "blocked")) releaseStatus = "blocked";
  else if (operator.release.lanes.length && operator.release.lanes.every((lane) => lane.status === "passed")) releaseStatus = "passed";
  else if (operator.release.lanes.length || /\b(release|deploy|promote)\b/.test(activityText)) releaseStatus = "running";
  if (/\b(release|deploy|promote)\b.*\b(fail|failed|reject|rollback)\b/.test(activityText)) releaseStatus = "failed";
  const release = stage("release", "출시", 4, releaseStatus);

  let operateStatus: LifecycleStageStatus = operator.hypercare.status;
  if (operateStatus === "pending" && /\b(hypercare|monitor|slo)\b/.test(activityText)) operateStatus = "running";
  const operate = stage("operate", "운영", 5, operateStatus,
    operateStatus === "blocked" ? "미해결 P0/P1 또는 SLO 위반" : null);

  const stages = [plan, build, verify, release, operate];
  const active = stages.find((item) => ["ready", "running", "blocked", "failed"].includes(item.status))
    || stages.find((item) => item.status === "pending")
    || operate;
  return { stages, currentStage: active.id, sourceUpdatedAt: latestTimestamp(input), ...operator };
}

function iso(now: Date): string {
  return now.toISOString();
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceUpdatedAt(value: object): string | null {
  const candidate = (value as Record<string, unknown>).sourceUpdatedAt;
  return typeof candidate === "string" ? candidate : null;
}

function delta<T extends object>(before: T, after: T): { changes: Partial<T>; removed: string[] } {
  const changes: Partial<T> = {};
  const removed: string[] = [];
  for (const key of Object.keys(after) as Array<keyof T>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = copy(after[key]);
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(key);
  return { changes, removed };
}

export class LifecycleStream<T extends object> {
  readonly streamId: string;
  readonly staleAfterMs: number;
  readonly historyLimit: number;
  private sequence = 0;
  private value: T | null = null;
  private observedAt = "";
  private history: Array<LifecycleEnvelope<T>> = [];

  constructor(options: { streamId?: string; staleAfterMs?: number; historyLimit?: number } = {}) {
    this.streamId = options.streamId || randomUUID();
    this.staleAfterMs = Math.max(1, options.staleAfterMs || 5_000);
    this.historyLimit = Math.max(1, options.historyLimit || 128);
  }

  update(value: T, now = new Date()): LifecycleEnvelope<T> | null {
    const next = copy(value);
    if (this.value && JSON.stringify(this.value) === JSON.stringify(next)) return null;
    this.sequence += 1;
    this.observedAt = iso(now);
    const freshness: LifecycleFreshness = {
      observedAt: this.observedAt,
      staleAfterMs: this.staleAfterMs,
      sourceUpdatedAt: sourceUpdatedAt(next),
    };
    let envelope: LifecycleEnvelope<T>;
    if (!this.value) {
      envelope = {
        schemaVersion: LIFECYCLE_SCHEMA_VERSION,
        streamId: this.streamId,
        sequence: this.sequence,
        kind: "snapshot",
        freshness,
        data: next,
      };
    } else {
      const patch = delta(this.value, next);
      envelope = {
        schemaVersion: LIFECYCLE_SCHEMA_VERSION,
        streamId: this.streamId,
        sequence: this.sequence,
        kind: "delta",
        freshness,
        changes: patch.changes,
        removed: patch.removed,
      };
    }
    this.value = next;
    if (envelope.kind === "delta") {
      this.history.push(envelope);
      if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    }
    return envelope;
  }

  currentSnapshot(): LifecycleEnvelope<T> {
    if (!this.value) throw new Error("lifecycle stream has no snapshot");
    return {
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      streamId: this.streamId,
      sequence: this.sequence,
      kind: "snapshot",
      freshness: {
        observedAt: this.observedAt,
        staleAfterMs: this.staleAfterMs,
        sourceUpdatedAt: sourceUpdatedAt(this.value),
      },
      data: copy(this.value),
    };
  }

  resume(cursor: { streamId?: string | null; sequence?: number } = {}): Array<LifecycleEnvelope<T>> {
    if (!this.value) return [];
    const sequence = Math.max(0, Number(cursor.sequence) || 0);
    if (!cursor.streamId || cursor.streamId !== this.streamId || sequence === 0) return [this.currentSnapshot()];
    if (sequence >= this.sequence) return [];
    const expected = sequence + 1;
    const available = this.history.filter((item) => item.sequence >= expected);
    if (!available.length || available[0]?.sequence !== expected) return [this.currentSnapshot()];
    return available.map(copy);
  }
}

/** Apply one envelope on the client side, rejecting a silent sequence gap. */
export function applyLifecycleEnvelope<T extends object>(
  previous: AppliedLifecycle<T> | null,
  envelope: LifecycleEnvelope<T>,
): AppliedLifecycle<T> {
  if (envelope.kind === "snapshot") {
    if (!envelope.data) throw new Error("snapshot data is required");
    return {
      streamId: envelope.streamId,
      sequence: envelope.sequence,
      data: copy(envelope.data),
      freshness: envelope.freshness,
    };
  }
  if (!previous) throw new Error("sequence gap: delta arrived before a snapshot");
  if (previous.streamId !== envelope.streamId) throw new Error("sequence gap: stream changed without a snapshot");
  if (envelope.sequence <= previous.sequence) return previous;
  if (envelope.sequence !== previous.sequence + 1) {
    throw new Error(`sequence gap: expected ${previous.sequence + 1}, received ${envelope.sequence}`);
  }
  const data = { ...previous.data, ...(envelope.changes || {}) } as T;
  for (const key of envelope.removed || []) delete (data as Record<string, unknown>)[key];
  return {
    streamId: envelope.streamId,
    sequence: envelope.sequence,
    data,
    freshness: envelope.freshness,
  };
}

export function lifecycleEnvelopeIsStale(
  envelope: Pick<LifecycleEnvelope<object>, "freshness">,
  now = new Date(),
): boolean {
  return now.getTime() - Date.parse(envelope.freshness.observedAt) > envelope.freshness.staleAfterMs;
}
