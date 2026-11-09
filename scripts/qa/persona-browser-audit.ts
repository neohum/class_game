// persona-browser-audit.ts — Pre-launch 5-Persona Synthetic User Browser Audit Engine
//
// 출시 전 5명의 가상 사용자 페르소나(급한 사용자, 의심 많은 사용자, 모바일 저속망 사용자,
// 화면 문구만 믿는 사용자, 망가뜨리는 사용자)를 병렬 브라우저 에이전트로 구동하기 위한
// 에뮬레이션 설정 직렬화, 마찰/결함 증거 정규화·빈도/심각도 집계, 마크다운/HTML 보고서
// 렌더링 및 수정 전후 5인 재검증(Re-audit) 비교 게이트를 제공한다.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PersonaId =
  | "impatient-first-click"
  | "skeptical-legal-reader"
  | "mobile-375-slow3g"
  | "literal-copy-follower"
  | "chaos-doubleclick-fuzzer";

export type Severity = "critical" | "high" | "medium" | "low";

export interface ViewportSpec {
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
}

export interface NetworkThrottleSpec {
  profile: "none" | "fast-3g" | "slow-3g" | "offline";
  latencyMs: number;
  downloadKbps: number;
  uploadKbps: number;
  cpuSlowdownMultiplier: number;
}

export interface PersonaSpec {
  id: PersonaId;
  nameKo: string;
  nameEn: string;
  summary: string;
  playwrightDevice: string;
  viewport: ViewportSpec;
  network: NetworkThrottleSpec;
  heuristics: string[];
  abortConditions: string[];
  focusAreas: string[];
  fuzzPayloads?: string[];
}

export interface McpEmulationConfig {
  persona: PersonaSpec;
  playwrightArgs: string[];
  devtoolsEmulate: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
    networkProfile: string;
    latencyMs: number;
    downloadKbps: number;
    uploadKbps: number;
    cpuSlowdownMultiplier: number;
    viewport: {
      width: number;
      height: number;
      deviceScaleFactor: number;
      isMobile: boolean;
      hasTouch: boolean;
    };
    networkConditions: {
      offline: boolean;
      profile: string;
      latency: number;
      downloadThroughput: number;
      uploadThroughput: number;
    };
    cpuThrottlingRate: number;
  };
  subagentPrompt: string;
}

export interface EvidenceArtifact {
  screenshotPath?: string;
  domSelector?: string;
  domSnippet?: string;
  consoleErrors?: string[];
  networkErrors?: Array<{ url: string; status: number; method?: string } | string>;
}

export interface PersonaFindingInput {
  id?: string;
  personaId?: string;
  title: string;
  description?: string;
  severity: Severity;
  category?: string;
  step?: string;
  url?: string;
  selector?: string;
  screenshotPath?: string;
  consoleErrors?: string[];
  networkErrors?: Array<{ url: string; status: number; method?: string } | string>;
  evidence?: EvidenceArtifact;
  abortedFlow?: boolean;
  reproductionSteps?: string[];
}

export interface PersonaObservation {
  personaId: string;
  title?: string;
  description?: string;
  severity?: Severity;
  category?: string;
  step?: string;
  url?: string;
  selector?: string;
  screenshotPath?: string;
  consoleErrors?: string[];
  networkErrors?: Array<{ url: string; status: number; method?: string } | string>;
  evidence?: EvidenceArtifact;
  abortedFlow?: boolean;
  reproductionSteps?: string[];
  completedCoreFlow?: boolean;
  durationMs?: number;
  findings?: PersonaFindingInput[];
}

export interface AggregatedFinding {
  key: string;
  title: string;
  description: string;
  severity: Severity;
  severityWeight: number;
  frequency: number;
  priorityScore: number;
  personas: string[];
  category: string;
  step: string;
  url: string;
  selectors: string[];
  screenshots: string[];
  consoleErrors: string[];
  networkErrors: string[];
  abortedCount: number;
  reproductionSteps: string[];
}

export interface AggregatedAuditReport {
  generatedAt: string;
  targetUrl: string;
  totalPersonasRun: number;
  totalObservations: number;
  uniqueFindings: number;
  summaryBySeverity: Record<Severity, number>;
  findings: AggregatedFinding[];
}

export interface ReauditComparison {
  comparedAt: string;
  pass: boolean;
  exitCode: 0 | 1;
  resolved: AggregatedFinding[];
  remaining: AggregatedFinding[];
  regressed: AggregatedFinding[];
  blockingCount: number;
  summary: {
    initialCount: number;
    followUpCount: number;
    resolvedCount: number;
    remainingCount: number;
    regressedCount: number;
    remainingCriticalOrHigh: number;
  };
}

export interface SwarmAuditPlan {
  targetUrl: string;
  generatedAt: string;
  personas: McpEmulationConfig[];
}

export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 100,
  high: 60,
  medium: 25,
  low: 10,
};

export const PRELAUNCH_PERSONAS: readonly PersonaSpec[] = [
  {
    id: "impatient-first-click",
    nameKo: "급한 사용자",
    nameEn: "Impatient First-Click User",
    summary:
      "설명이나 안내문을 읽지 않고 3초 내에 가장 눈에 띄는 첫 CTA 버튼을 클릭하며, 첫 에러나 무응답 발생 시 즉시 이탈합니다.",
    playwrightDevice: "Desktop Chrome",
    viewport: {
      width: 1280,
      height: 800,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    },
    network: {
      profile: "none",
      latencyMs: 20,
      downloadKbps: 10000,
      uploadKbps: 5000,
      cpuSlowdownMultiplier: 1,
    },
    heuristics: [
      "첫 화면 진입 후 3초 이내에 가장 시각적 대비가 큰 주 행동(Primary CTA) 버튼을 즉시 클릭합니다.",
      "가이드 툴팁이나 긴 온보딩 설명문은 건너뛰고 최소 입력만으로 가입 및 핵심 기능 실행을 시도합니다.",
      "클릭 후 3초 이상 피드백(로딩 인디케이터, 화면 전환)이 없거나 첫 에러 토스트가 뜨면 즉시 플로우를 중단합니다.",
    ],
    abortConditions: [
      "첫 화면에서 3초 내에 핵심 CTA 버튼을 식별할 수 없음",
      "첫 CTA 클릭 시 무응답(3초 초과) 또는 원인 불명의 오류 발생",
      "핵심 가치 체험 전에 필수 입력 필드가 5개 이상 요구됨",
    ],
    focusAreas: ["첫 화면 CTA 가시성", "온보딩 단계 최소화", "즉각적 인터랙션 피드백"],
  },
  {
    id: "skeptical-legal-reader",
    nameKo: "의심 많은 사용자",
    nameEn: "Skeptical Legal & Pricing Reader",
    summary:
      "가입·결제 전에 요금제, 이용약관, 개인정보 처리방침, 환불 및 보안 안내 링크를 전수 클릭하여 확인합니다.",
    playwrightDevice: "Desktop Chrome HiDPI",
    viewport: {
      width: 1440,
      height: 900,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    },
    network: {
      profile: "none",
      latencyMs: 20,
      downloadKbps: 10000,
      uploadKbps: 5000,
      cpuSlowdownMultiplier: 1,
    },
    heuristics: [
      "회원가입 또는 이메일 입력 전에 요금 안내(Pricing), 이용약관(Terms), 개인정보 처리방침(Privacy), 환불/해지 정책, 보안(Security) 링크를 모두 클릭합니다.",
      "약관 모달이나 새 탭 링크가 404, 빈 화면, `#` 더미 링크인지 점검합니다.",
      "무료 체험 기간, 자동 결제 전환 여부, 계정 삭제/탈퇴 경로가 명시되어 있는지 확인한 뒤에만 가입을 진행합니다.",
    ],
    abortConditions: [
      "이용약관 또는 개인정보 처리방침 링크가 누락되었거나 클릭 시 404/빈 페이지가 표시됨",
      "요금제 또는 무료 체험 조건이 모호하거나 숨겨진 비용 의심 문구가 존재함",
      "가입 폼의 필수/선택 동의 체크박스 구분이 불명확함",
    ],
    focusAreas: ["이용약관·개인정보 처리방침 링크 무결성", "요금·환불 정책 투명성", "신뢰·보안 안내 검증"],
  },
  {
    id: "mobile-375-slow3g",
    nameKo: "모바일 저속망 사용자",
    nameEn: "Mobile 375px Slow 3G User",
    summary:
      "375px 폭 모바일 화면과 Slow 3G 저속 네트워크 환경에서 가로 스크롤 깨짐, 44px 미만 터치 타겟, 로딩 지연을 겪으며 플로우를 수행합니다.",
    playwrightDevice: "iPhone SE",
    viewport: {
      width: 375,
      height: 667,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
    network: {
      profile: "slow-3g",
      latencyMs: 400,
      downloadKbps: 400,
      uploadKbps: 400,
      cpuSlowdownMultiplier: 4,
    },
    heuristics: [
      "375x667 모바일 뷰포트 및 Slow 3G(지연 400ms, 다운로드/업로드 400kbps) 조건에서 첫 화면부터 핵심 기능 완료까지 진행합니다.",
      "매 화면마다 가로 스크롤(`document.documentElement.scrollWidth > window.innerWidth`) 발생 여부와 고정 헤더/하단 버튼 가림 현상을 스캔합니다.",
      "모든 버튼·링크·입력창의 터치 영역이 최소 44x44px 이상인지, 느린 네트워크에서 로딩 스피너/스켈레톤이 표시되는지 점검합니다.",
    ],
    abortConditions: [
      "가로 스크롤이나 레이아웃 오버플로우로 인해 주요 CTA 버튼이나 입력 폼이 화면 밖으로 잘림",
      "터치 타겟이 44px 미만이거나 요소 간 간격 부족으로 인접 요소가 오작동함",
      "Slow 3G 환경에서 10초 내 주요 콘텐츠가 렌더링되지 않거나 중복 탭 방지가 없어 오류가 발생함",
    ],
    focusAreas: ["375px 반응형 레이아웃·가로 스크롤 방지", "44px 이상 모바일 터치 타겟", "Slow 3G 로딩 상태 표시 및 타임아웃 복구"],
  },
  {
    id: "literal-copy-follower",
    nameKo: "화면 문구만 믿는 사용자",
    nameEn: "Literal Copy & Placeholder Follower",
    summary:
      "사전 배경지식 없이 화면에 적힌 안내 문구, 플레이스홀더 예시, 버튼 텍스트 그대로만 입력하고 행동합니다.",
    playwrightDevice: "Desktop Chrome",
    viewport: {
      width: 1280,
      height: 800,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    },
    network: {
      profile: "none",
      latencyMs: 20,
      downloadKbps: 10000,
      uploadKbps: 5000,
      cpuSlowdownMultiplier: 1,
    },
    heuristics: [
      "입력창의 플레이스홀더(`예: ...`)나 라벨에 적힌 예시 형식을 문자 그대로 입력합니다.",
      "버튼 텍스트가 약속한 결과와 실제 클릭 후 이동한 화면의 제목·상태가 일치하는지 대조합니다.",
      "유효성 검사 실패 시 에러 메시지가 구체적인 수정 방법(예: '8자 이상 영문/숫자 조합')을 안내하는지 확인합니다.",
    ],
    abortConditions: [
      "플레이스홀더 예시 그대로 입력했으나 유효성 검사 오류가 발생함",
      "에러 메시지가 '잘못된 입력입니다' 또는 코드/영문 원문으로만 노출되어 해결 방법을 알 수 없음",
      "작업 완료 후 다음 단계로 무엇을 해야 하는지 안내 문구나 CTA가 없음",
    ],
    focusAreas: ["플레이스홀더·라벨 문구 정합성", "구체적인 오류 복구 안내", "단계별 행동 유도 마이크로카피"],
  },
  {
    id: "chaos-doubleclick-fuzzer",
    nameKo: "망가뜨리는 사용자",
    nameEn: "Chaos Double-Click & Input Fuzzer",
    summary:
      "빈 값, 초장문, 특수문자, 음수 입력과 브라우저 뒤로/앞으로 가기, 모든 제출 버튼 더블클릭 연타로 중복 요청 및 크래시를 유도합니다.",
    playwrightDevice: "Desktop Chrome",
    viewport: {
      width: 1280,
      height: 800,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    },
    network: {
      profile: "fast-3g",
      latencyMs: 150,
      downloadKbps: 1600,
      uploadKbps: 750,
      cpuSlowdownMultiplier: 2,
    },
    heuristics: [
      "모든 입력 폼에 빈 값, 공백 문자열, 음수(`-1`), 0, 초장문(1,000자 이상), 이모지/특수문자, 스크립트 태그 문자열을 순서대로 주입합니다.",
      "제출·저장·가입·결제 버튼을 빠르게 더블클릭하거나 5회 연속 연타하여 중복 네트워크 요청(409/500)이나 중복 생성 여부를 점검합니다.",
      "다단계 플로우 도중 브라우저 뒤로 가기(Back), 앞으로 가기(Forward), 새로고침(Refresh)을 실행하여 상태 파손이나 빈 화면을 탐지합니다.",
    ],
    abortConditions: [
      "제출 버튼 더블클릭 시 버튼 비활성화(disabled/loading)가 되지 않아 중복 API 호출 또는 500 오류가 발생함",
      "특수문자·초장문 입력 또는 뒤로 가기 시 미처리 런타임 예외(Uncaught Error)로 화면이 깨짐",
      "잘못된 입력 후 정상 값으로 수정해도 이전 에러 상태가 해제되지 않아 진행이 불가능함",
    ],
    focusAreas: ["제출 버튼 더블클릭(Idempotency) 방어", "경계값·특수문자 입력 검증", "뒤로 가기·새로고침 상태 복원력"],
    fuzzPayloads: [
      "",
      "   ",
      "-1",
      "0",
      "99999999999999999999",
      "<script>alert(1)</script>",
      "' OR 1=1 --",
      "🔥👩‍💻🚀".repeat(25),
      "A".repeat(1024),
    ],
  },
] as const;

function clonePersona(spec: PersonaSpec): PersonaSpec {
  return {
    ...spec,
    viewport: { ...spec.viewport },
    network: { ...spec.network },
    heuristics: [...spec.heuristics],
    abortConditions: [...spec.abortConditions],
    focusAreas: [...spec.focusAreas],
    ...(spec.fuzzPayloads ? { fuzzPayloads: [...spec.fuzzPayloads] } : {}),
  };
}

export function getPersonaSpecs(): PersonaSpec[] {
  return PRELAUNCH_PERSONAS.map(clonePersona);
}

export function getPersonaSpec(personaId: string): PersonaSpec {
  const found = PRELAUNCH_PERSONAS.find((p) => p.id === personaId);
  if (!found) {
    const valid = PRELAUNCH_PERSONAS.map((p) => p.id).join(", ");
    throw new Error(`Unknown personaId '${personaId}'. Expected one of: ${valid}`);
  }
  return clonePersona(found);
}

export function buildMcpEmulationConfig(personaId: string, targetUrl = "http://localhost:3000"): McpEmulationConfig {
  const persona = getPersonaSpec(personaId);
  const { viewport, network } = persona;
  const downloadBytesPerSec = Math.floor((network.downloadKbps * 1024) / 8);
  const uploadBytesPerSec = Math.floor((network.uploadKbps * 1024) / 8);

  const playwrightArgs = [
    "--device",
    persona.playwrightDevice,
    "--viewport-size",
    `${viewport.width},${viewport.height}`,
  ];

  const devtoolsEmulate = {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    networkProfile: network.profile,
    latencyMs: network.latencyMs,
    downloadKbps: network.downloadKbps,
    uploadKbps: network.uploadKbps,
    cpuSlowdownMultiplier: network.cpuSlowdownMultiplier,
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
    },
    networkConditions: {
      offline: network.profile === "offline",
      profile: network.profile,
      latency: network.latencyMs,
      downloadThroughput: downloadBytesPerSec,
      uploadThroughput: uploadBytesPerSec,
    },
    cpuThrottlingRate: network.cpuSlowdownMultiplier,
  };

  const promptLines = [
    `[가상 사용자 브라우저 감사 에이전트 — ${persona.nameKo} (${persona.id})]`,
    `대상 URL: ${targetUrl}`,
    `요약: ${persona.summary}`,
    `브라우저 에뮬레이션: 뷰포트 ${viewport.width}x${viewport.height} (mobile=${viewport.isMobile}, touch=${viewport.hasTouch}), 네트워크=${network.profile} (latency=${network.latencyMs}ms, down=${network.downloadKbps}kbps, up=${network.uploadKbps}kbps)`,
    `Playwright MCP 인자: ${playwrightArgs.join(" ")}`,
    `행동 규칙 (Heuristics):`,
    ...persona.heuristics.map((h, i) => `  ${i + 1}. ${h}`),
    `중단 조건 (Abort Conditions):`,
    ...persona.abortConditions.map((a, i) => `  ${i + 1}. ${a}`),
    `증거 수집 규칙: 막히거나 헷갈리는 지점마다 스크린샷 경로(screenshotPath), DOM 셀렉터(selector), 콘솔 에러(consoleErrors), 네트워크 실패(networkErrors)를 PersonaObservation JSON 형식으로 기록하세요.`,
  ];

  return {
    persona,
    playwrightArgs,
    devtoolsEmulate,
    subagentPrompt: promptLines.join("\n"),
  };
}

export function buildSwarmAuditPlan(targetUrl = "http://localhost:3000"): SwarmAuditPlan {
  return {
    targetUrl,
    generatedAt: new Date().toISOString(),
    personas: PRELAUNCH_PERSONAS.map((p) => buildMcpEmulationConfig(p.id, targetUrl)),
  };
}

function normalizeToken(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[`"'?!.,;:()[\]{}]/g, "");
}

function normalizeSeverity(sev: string | undefined): Severity {
  const s = String(sev ?? "medium").trim().toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") {
    return s;
  }
  return "medium";
}

function formatNetworkError(err: { url: string; status: number; method?: string } | string): string {
  if (typeof err === "string") return err.trim();
  const method = err.method ? `${err.method.toUpperCase()} ` : "";
  return `${method}${err.status} ${err.url}`.trim();
}

interface FlattenedFinding {
  id?: string;
  personaId: string;
  title: string;
  description: string;
  severity: Severity;
  category: string;
  step: string;
  url: string;
  selector: string;
  screenshotPath: string;
  consoleErrors: string[];
  networkErrors: string[];
  abortedFlow: boolean;
  reproductionSteps: string[];
}

function flattenObservations(observations: PersonaObservation[]): {
  personasSeen: Set<string>;
  items: FlattenedFinding[];
} {
  const personasSeen = new Set<string>();
  const items: FlattenedFinding[] = [];

  for (const obs of observations || []) {
    const personaId = String(obs.personaId || "unknown-persona").trim();
    personasSeen.add(personaId);

    const rawFindings: PersonaFindingInput[] =
      Array.isArray(obs.findings) && obs.findings.length > 0
        ? obs.findings
        : obs.title
          ? [
              {
                personaId,
                title: obs.title,
                description: obs.description,
                severity: obs.severity ?? "medium",
                category: obs.category,
                step: obs.step,
                url: obs.url,
                selector: obs.selector,
                screenshotPath: obs.screenshotPath,
                consoleErrors: obs.consoleErrors,
                networkErrors: obs.networkErrors,
                evidence: obs.evidence,
                abortedFlow: obs.abortedFlow,
                reproductionSteps: obs.reproductionSteps,
              },
            ]
          : [];

    for (const f of rawFindings) {
      const fPersona = String(f.personaId || personaId).trim();
      personasSeen.add(fPersona);
      const selector = String(f.selector || f.evidence?.domSelector || "").trim();
      const screenshotPath = String(f.screenshotPath || f.evidence?.screenshotPath || "").trim();
      const consoleErrors = [
        ...(f.consoleErrors || []),
        ...(f.evidence?.consoleErrors || []),
      ]
        .map((c) => String(c).trim())
        .filter(Boolean);
      const networkErrors = [
        ...(f.networkErrors || []).map(formatNetworkError),
        ...(f.evidence?.networkErrors || []).map(formatNetworkError),
      ].filter(Boolean);

      items.push({
        id: f.id,
        personaId: fPersona,
        title: String(f.title || "Untitled Friction Point").trim(),
        description: String(f.description || f.evidence?.domSnippet || "").trim(),
        severity: normalizeSeverity(f.severity),
        category: String(f.category || "general").trim(),
        step: String(f.step || "unspecified-step").trim(),
        url: String(f.url || "").trim(),
        selector,
        screenshotPath,
        consoleErrors,
        networkErrors,
        abortedFlow: Boolean(f.abortedFlow ?? obs.abortedFlow),
        reproductionSteps: (f.reproductionSteps || []).map((s) => String(s).trim()).filter(Boolean),
      });
    }
  }

  return { personasSeen, items };
}

export function computeFindingKey(item: {
  id?: string;
  title: string;
  selector?: string;
  category?: string;
  step?: string;
}): string {
  if (item.id && String(item.id).trim()) {
    return normalizeToken(item.id);
  }
  const normTitle = normalizeToken(item.title);
  const normSelector = normalizeToken(item.selector);
  if (normSelector && normTitle) {
    return `${normSelector}::${normTitle}`;
  }
  return normTitle || normSelector || "unknown-finding";
}

export function aggregatePersonaFindings(
  observations: PersonaObservation[],
  options: { targetUrl?: string; generatedAt?: string } = {},
): AggregatedAuditReport {
  const { personasSeen, items } = flattenObservations(observations);
  const groups = new Map<string, FlattenedFinding[]>();

  for (const item of items) {
    let key = computeFindingKey(item);
    // If another group already shares the exact normalized title or exact non-empty selector + step, merge into it
    if (!groups.has(key)) {
      const normTitle = normalizeToken(item.title);
      const normSelector = normalizeToken(item.selector);
      for (const [existingKey, existingItems] of groups.entries()) {
        const first = existingItems[0];
        if (!first) continue;
        const firstTitle = normalizeToken(first.title);
        const firstSelector = normalizeToken(first.selector);
        if (normTitle && normTitle === firstTitle) {
          key = existingKey;
          break;
        }
        if (normSelector && normSelector === firstSelector && normalizeToken(item.step) === normalizeToken(first.step)) {
          key = existingKey;
          break;
        }
      }
    }
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }

  const aggregated: AggregatedFinding[] = [];

  for (const [key, group] of groups.entries()) {
    let highestSeverity: Severity = "low";
    for (const item of group) {
      if (SEVERITY_WEIGHTS[item.severity] > SEVERITY_WEIGHTS[highestSeverity]) {
        highestSeverity = item.severity;
      }
    }

    const personas = [...new Set(group.map((g) => g.personaId))];
    const frequency = Math.max(personas.length, group.length);
    const severityWeight = SEVERITY_WEIGHTS[highestSeverity];
    const abortedCount = group.filter((g) => g.abortedFlow).length;
    const priorityScore = severityWeight * frequency + abortedCount * 15;

    const selectors = [...new Set(group.map((g) => g.selector).filter(Boolean))];
    const screenshots = [...new Set(group.map((g) => g.screenshotPath).filter(Boolean))];
    const consoleErrors = [...new Set(group.flatMap((g) => g.consoleErrors).filter(Boolean))];
    const networkErrors = [...new Set(group.flatMap((g) => g.networkErrors).filter(Boolean))];
    const reproductionSteps = [...new Set(group.flatMap((g) => g.reproductionSteps).filter(Boolean))];
    const descriptions = [...new Set(group.map((g) => g.description).filter(Boolean))];

    const first = group[0]!;
    aggregated.push({
      key,
      title: first.title,
      description: descriptions.join(" | ") || first.title,
      severity: highestSeverity,
      severityWeight,
      frequency,
      priorityScore,
      personas,
      category: first.category,
      step: first.step,
      url: group.find((g) => g.url)?.url || options.targetUrl || "",
      selectors,
      screenshots,
      consoleErrors,
      networkErrors,
      abortedCount,
      reproductionSteps,
    });
  }

  aggregated.sort(
    (a, b) =>
      b.priorityScore - a.priorityScore ||
      b.severityWeight - a.severityWeight ||
      b.frequency - a.frequency ||
      a.key.localeCompare(b.key),
  );

  const summaryBySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const f of aggregated) {
    summaryBySeverity[f.severity] += 1;
  }

  const inferredUrl =
    options.targetUrl ||
    items.find((i) => i.url)?.url ||
    "http://localhost:3000";

  return {
    generatedAt: options.generatedAt || new Date().toISOString(),
    targetUrl: inferredUrl,
    totalPersonasRun: personasSeen.size,
    totalObservations: items.length,
    uniqueFindings: aggregated.length,
    summaryBySeverity,
    findings: aggregated,
  };
}

function matchFindingKey(finding: AggregatedFinding): string {
  if (finding.key) return normalizeToken(finding.key);
  return computeFindingKey({
    title: finding.title,
    selector: finding.selectors[0] || "",
    category: finding.category,
    step: finding.step,
  });
}

export function compareReaudit(
  initial: AggregatedAuditReport,
  followUp: AggregatedAuditReport,
  comparedAt = new Date().toISOString(),
): ReauditComparison {
  const initialMap = new Map<string, AggregatedFinding>();
  for (const f of initial.findings || []) {
    initialMap.set(matchFindingKey(f), f);
  }

  const followUpMap = new Map<string, AggregatedFinding>();
  for (const f of followUp.findings || []) {
    followUpMap.set(matchFindingKey(f), f);
  }

  const resolved: AggregatedFinding[] = [];
  const remaining: AggregatedFinding[] = [];
  const regressed: AggregatedFinding[] = [];

  for (const [key, initFinding] of initialMap.entries()) {
    const afterFinding = followUpMap.get(key);
    if (!afterFinding) {
      resolved.push(initFinding);
    } else {
      remaining.push(afterFinding);
    }
  }

  for (const [key, afterFinding] of followUpMap.entries()) {
    if (!initialMap.has(key)) {
      regressed.push(afterFinding);
    }
  }

  const remainingCriticalOrHigh = remaining.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  ).length;
  const blockingCount = remainingCriticalOrHigh + regressed.length;
  const pass = remainingCriticalOrHigh === 0 && regressed.length === 0;

  return {
    comparedAt,
    pass,
    exitCode: pass ? 0 : 1,
    resolved,
    remaining,
    regressed,
    blockingCount,
    summary: {
      initialCount: initial.findings.length,
      followUpCount: followUp.findings.length,
      resolvedCount: resolved.length,
      remainingCount: remaining.length,
      regressedCount: regressed.length,
      remainingCriticalOrHigh,
    },
  };
}

export function renderAuditMarkdown(
  report: AggregatedAuditReport,
  reaudit?: ReauditComparison,
): string {
  const lines: string[] = [
    `# 출시 전 5대 가상 사용자 페르소나 브라우저 감사 보고서`,
    ``,
    `- **대상 URL**: \`${report.targetUrl}\``,
    `- **생성 시각**: \`${report.generatedAt}\``,
    `- **참여 페르소나 수**: ${report.totalPersonasRun}명`,
    `- **총 관측 마찰/결함 수**: ${report.totalObservations}건 (고유 결함 ${report.uniqueFindings}건)`,
    `- **심각도 요약**: Critical ${report.summaryBySeverity.critical}건 | High ${report.summaryBySeverity.high}건 | Medium ${report.summaryBySeverity.medium}건 | Low ${report.summaryBySeverity.low}건`,
    ``,
  ];

  if (reaudit) {
    lines.push(
      `## 재검증(Re-audit) 판정 결과: ${reaudit.pass ? "PASS (출시 게이트 통과)" : "FAIL (출시 게이트 차단)"}`,
      ``,
      `- **비교 시각**: \`${reaudit.comparedAt}\``,
      `- **판정 상태**: **${reaudit.pass ? "PASS" : "FAIL"}** (exitCode: \`${reaudit.exitCode}\`)`,
      `- **해결됨(Resolved)**: ${reaudit.summary.resolvedCount}건`,
      `- **미해결(Remaining)**: ${reaudit.summary.remainingCount}건 (Critical/High: ${reaudit.summary.remainingCriticalOrHigh}건)`,
      `- **회귀(Regressed)**: ${reaudit.summary.regressedCount}건`,
      ``,
    );

    if (reaudit.resolved.length > 0) {
      lines.push(`### 해결된 결함 (Resolved)`);
      for (const f of reaudit.resolved) {
        lines.push(`- [x] **[${f.severity.toUpperCase()}]** ${f.title} (${f.personas.join(", ")})`);
      }
      lines.push(``);
    }

    if (reaudit.remaining.length > 0) {
      lines.push(`### 미해결 결함 (Remaining)`);
      for (const f of reaudit.remaining) {
        lines.push(`- [ ] **[${f.severity.toUpperCase()}]** ${f.title} — 빈도 ${f.frequency}회 (${f.personas.join(", ")})`);
      }
      lines.push(``);
    }

    if (reaudit.regressed.length > 0) {
      lines.push(`### 신규 회귀 결함 (Regressed)`);
      for (const f of reaudit.regressed) {
        lines.push(`- [!] **[${f.severity.toUpperCase()}]** ${f.title} — 빈도 ${f.frequency}회 (${f.personas.join(", ")})`);
      }
      lines.push(``);
    }
  }

  lines.push(`## 빈도·심각도 우선순위별 결함 목록 (Prioritized Findings)`, ``);

  if (report.findings.length === 0) {
    lines.push(`관측된 결함이 없습니다.`, ``);
  } else {
    report.findings.forEach((f, idx) => {
      lines.push(
        `### ${idx + 1}. [${f.severity.toUpperCase()}] ${f.title}`,
        `- **우선순위 점수(Priority Score)**: \`${f.priorityScore}\` (심각도 가중치 \`${f.severityWeight}\` × 빈도 \`${f.frequency}\`)`,
        `- **영향 페르소나(${f.frequency}명)**: \`${f.personas.join("`, `")}\``,
        `- **단계 / 카테고리**: \`${f.step}\` / \`${f.category}\``,
        `- **상세 설명**: ${f.description}`,
      );
      if (f.selectors.length > 0) {
        lines.push(`- **DOM 셀렉터**: \`${f.selectors.join("`, `")}\``);
      }
      if (f.screenshots.length > 0) {
        lines.push(`- **스크린샷 증거**: \`${f.screenshots.join("`, `")}\``);
      }
      if (f.consoleErrors.length > 0) {
        lines.push(`- **콘솔 오류**: \`${f.consoleErrors.join(" | ")}\``);
      }
      if (f.networkErrors.length > 0) {
        lines.push(`- **네트워크 오류**: \`${f.networkErrors.join(" | ")}\``);
      }
      lines.push(``);
    });
  }

  lines.push(
    `## 5대 가상 사용자 페르소나 스펙 요약`,
    ``,
    `| 페르소나 ID | 이름 | 뷰포트 | 네트워크 | 핵심 점검 초점 |`,
    `| --- | --- | --- | --- | --- |`,
    ...PRELAUNCH_PERSONAS.map(
      (p) =>
        `| \`${p.id}\` | ${p.nameKo} | ${p.viewport.width}x${p.viewport.height} | ${p.network.profile} (${p.network.latencyMs}ms) | ${p.focusAreas.join(", ")} |`,
    ),
    ``,
  );

  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderAuditHtml(
  report: AggregatedAuditReport,
  reaudit?: ReauditComparison,
): string {
  const reauditBanner = reaudit
    ? `
    <section class="reaudit-card ${reaudit.pass ? "reaudit-pass" : "reaudit-fail"}">
      <div class="reaudit-header">
        <h2>재검증(Re-audit) 게이트 판정: ${reaudit.pass ? "PASS (출시 가능)" : "FAIL (출시 차단)"}</h2>
        <span class="badge ${reaudit.pass ? "badge-pass" : "badge-fail"}">${reaudit.pass ? "PASS" : "FAIL"}</span>
      </div>
      <p class="reaudit-meta">
        해결됨(Resolved): <strong>${reaudit.summary.resolvedCount}건</strong> ·
        미해결(Remaining): <strong>${reaudit.summary.remainingCount}건</strong> (Critical/High ${reaudit.summary.remainingCriticalOrHigh}건) ·
        회귀(Regressed): <strong>${reaudit.summary.regressedCount}건</strong>
      </p>
    </section>`
    : "";

  const findingsHtml =
    report.findings.length === 0
      ? `<div class="empty-state">관측된 마찰 지점이나 결함이 없습니다.</div>`
      : report.findings
          .map(
            (f, idx) => `
      <article class="finding-card severity-${escapeHtml(f.severity)}">
        <div class="finding-header">
          <div class="finding-title-wrap">
            <span class="finding-rank">#${idx + 1}</span>
            <span class="badge badge-${escapeHtml(f.severity)}">${escapeHtml(f.severity.toUpperCase())}</span>
            <h3 class="finding-title">${escapeHtml(f.title)}</h3>
          </div>
          <div class="finding-metrics">
            <span class="badge badge-neutral">빈도 ${f.frequency}명</span>
            <span class="badge badge-neutral">점수 ${f.priorityScore}</span>
          </div>
        </div>
        <p class="finding-desc">${escapeHtml(f.description)}</p>
        <div class="finding-meta-grid">
          <div><strong>영향 페르소나:</strong> ${f.personas.map((p) => `<code>${escapeHtml(p)}</code>`).join(" ")}</div>
          <div><strong>단계 / 카테고리:</strong> <code>${escapeHtml(f.step)}</code> / <code>${escapeHtml(f.category)}</code></div>
          ${f.selectors.length ? `<div><strong>DOM 셀렉터:</strong> ${f.selectors.map((s) => `<code>${escapeHtml(s)}</code>`).join(" ")}</div>` : ""}
          ${f.screenshots.length ? `<div><strong>스크린샷 증거:</strong> ${f.screenshots.map((s) => `<code>${escapeHtml(s)}</code>`).join(" ")}</div>` : ""}
          ${f.consoleErrors.length ? `<div><strong>콘솔 오류:</strong> <code>${escapeHtml(f.consoleErrors.join(" | "))}</code></div>` : ""}
          ${f.networkErrors.length ? `<div><strong>네트워크 오류:</strong> <code>${escapeHtml(f.networkErrors.join(" | "))}</code></div>` : ""}
        </div>
      </article>`,
          )
          .join("\n");

  const personaRows = PRELAUNCH_PERSONAS.map(
    (p) => `
      <tr>
        <td><code>${escapeHtml(p.id)}</code></td>
        <td>${escapeHtml(p.nameKo)}</td>
        <td><code>${p.viewport.width}x${p.viewport.height}</code></td>
        <td><code>${escapeHtml(p.network.profile)} (${p.network.latencyMs}ms / ${p.network.downloadKbps}kbps)</code></td>
        <td>${escapeHtml(p.focusAreas.join(", "))}</td>
      </tr>`,
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>출시 전 5대 가상 사용자 페르소나 브라우저 감사 보고서</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --muted: #8b949e;
      --heading: #f0f6fc;
      --accent: #58a6ff;
      --critical: #f85149;
      --high: #db6d28;
      --medium: #d29922;
      --low: #3fb950;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f8fa;
        --card-bg: #ffffff;
        --border: #d0d7de;
        --text: #24292f;
        --muted: #57606a;
        --heading: #1f2328;
        --accent: #0969da;
        --critical: #cf222e;
        --high: #bc4c00;
        --medium: #9a6700;
        --low: #1a7f37;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.6;
      padding: 32px 16px;
      word-break: keep-all;
      overflow-wrap: break-word;
    }
    .container { max-width: 1080px; margin: 0 auto; }
    header.report-header {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    header.report-header h1 {
      color: var(--heading);
      font-size: 24px;
      margin-bottom: 8px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .stat-box {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
    }
    .stat-label { font-size: 12px; color: var(--muted); }
    .stat-value { font-size: 20px; font-weight: 700; color: var(--heading); }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.2;
    }
    .badge-critical { background: rgba(248,81,73,0.18); color: var(--critical); border: 1px solid var(--critical); }
    .badge-high { background: rgba(219,109,40,0.18); color: var(--high); border: 1px solid var(--high); }
    .badge-medium { background: rgba(210,153,34,0.18); color: var(--medium); border: 1px solid var(--medium); }
    .badge-low { background: rgba(63,185,80,0.18); color: var(--low); border: 1px solid var(--low); }
    .badge-neutral { background: rgba(139,148,158,0.15); color: var(--heading); border: 1px solid var(--border); }
    .badge-pass { background: rgba(63,185,80,0.2); color: var(--low); border: 1px solid var(--low); }
    .badge-fail { background: rgba(248,81,73,0.2); color: var(--critical); border: 1px solid var(--critical); }
    .reaudit-card {
      background: var(--card-bg);
      border: 2px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .reaudit-pass { border-color: var(--low); }
    .reaudit-fail { border-color: var(--critical); }
    .reaudit-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .finding-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .finding-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .finding-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .finding-rank { font-family: var(--mono); color: var(--muted); font-weight: 700; }
    .finding-title { font-size: 17px; color: var(--heading); }
    .finding-metrics { display: flex; gap: 8px; align-items: center; }
    .finding-desc { margin-bottom: 12px; color: var(--text); }
    .finding-meta-grid {
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: var(--muted);
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }
    code {
      font-family: var(--mono);
      font-size: 12px;
      background: rgba(139,148,158,0.12);
      padding: 2px 6px;
      border-radius: 4px;
    }
    table.persona-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-top: 12px;
    }
    .persona-table th, .persona-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      font-size: 13px;
    }
    .persona-table th { color: var(--heading); background: rgba(255,255,255,0.03); }
    section { margin-bottom: 28px; }
    section h2 { color: var(--heading); font-size: 19px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <header class="report-header">
      <h1>출시 전 5대 가상 사용자 페르소나 브라우저 감사 보고서</h1>
      <p>대상 URL: <code>${escapeHtml(report.targetUrl)}</code> · 생성 시각: <code>${escapeHtml(report.generatedAt)}</code></p>
      <div class="summary-grid">
        <div class="stat-box">
          <div class="stat-label">참여 페르소나</div>
          <div class="stat-value">${report.totalPersonasRun}명</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">고유 결함 (총 관측)</div>
          <div class="stat-value">${report.uniqueFindings}건 (${report.totalObservations}건)</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Critical / High</div>
          <div class="stat-value">${report.summaryBySeverity.critical} / ${report.summaryBySeverity.high}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Medium / Low</div>
          <div class="stat-value">${report.summaryBySeverity.medium} / ${report.summaryBySeverity.low}</div>
        </div>
      </div>
    </header>

    ${reauditBanner}

    <section>
      <h2>빈도·심각도 우선순위별 결함 목록</h2>
      ${findingsHtml}
    </section>

    <section>
      <h2>5대 가상 사용자 페르소나 에뮬레이션 스펙</h2>
      <table class="persona-table">
        <thead>
          <tr>
            <th>페르소나 ID</th>
            <th>페르소나 이름</th>
            <th>뷰포트</th>
            <th>네트워크 쓰로틀링</th>
            <th>핵심 점검 영역</th>
          </tr>
        </thead>
        <tbody>
          ${personaRows}
        </tbody>
      </table>
    </section>
  </div>
</body>
</html>`;
}

function parseInputFileAsReport(filePath: string, targetUrl?: string): AggregatedAuditReport {
  const raw = JSON.parse(readFileSync(resolve(filePath), "utf8")) as unknown;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as AggregatedAuditReport).findings)) {
    return raw as AggregatedAuditReport;
  }
  const observations = Array.isArray(raw)
    ? (raw as PersonaObservation[])
    : Array.isArray((raw as { observations?: PersonaObservation[] })?.observations)
      ? (raw as { observations: PersonaObservation[] }).observations
      : [];
  return aggregatePersonaFindings(observations, { targetUrl });
}

export function runCli(argv: string[] = process.argv.slice(2)): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const getFlag = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
    return undefined;
  };

  const jsonMode = argv.includes("--json");
  const targetUrl = getFlag("--url") || "http://localhost:3000";
  const outDir = getFlag("--out") || getFlag("--out-dir");

  try {
    if (argv.includes("--list-personas")) {
      const specs = getPersonaSpecs();
      const stdout = jsonMode
        ? JSON.stringify(specs, null, 2)
        : specs
            .map(
              (p) =>
                `${p.id} (${p.nameKo}) — viewport=${p.viewport.width}x${p.viewport.height}, net=${p.network.profile}`,
            )
            .join("\n");
      return { exitCode: 0, stdout, stderr: "" };
    }

    const emulateId = getFlag("--emulate");
    if (emulateId) {
      const cfg = buildMcpEmulationConfig(emulateId, targetUrl);
      const stdout = JSON.stringify(cfg, null, 2);
      return { exitCode: 0, stdout, stderr: "" };
    }

    if (argv.includes("--init-plan")) {
      const plan = buildSwarmAuditPlan(targetUrl);
      if (outDir) {
        const dir = resolve(outDir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "persona-swarm-plan.json"), JSON.stringify(plan, null, 2), "utf8");
      }
      return { exitCode: 0, stdout: JSON.stringify(plan, null, 2), stderr: "" };
    }

    const aggregateFile = getFlag("--aggregate");
    if (aggregateFile) {
      const report = parseInputFileAsReport(aggregateFile, targetUrl);
      const md = renderAuditMarkdown(report);
      const html = renderAuditHtml(report);
      if (outDir) {
        const dir = resolve(outDir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "persona-audit-report.json"), JSON.stringify(report, null, 2), "utf8");
        writeFileSync(join(dir, "persona-audit-report.md"), md, "utf8");
        writeFileSync(join(dir, "persona-audit-report.html"), html, "utf8");
      }
      const stdout = jsonMode ? JSON.stringify(report, null, 2) : md;
      return { exitCode: 0, stdout, stderr: "" };
    }

    const reauditIdx = argv.indexOf("--reaudit");
    if (reauditIdx !== -1) {
      const beforeFile = argv[reauditIdx + 1];
      const afterFile = argv[reauditIdx + 2];
      if (!beforeFile || !afterFile) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "usage: persona-browser-audit.ts --reaudit <before.json> <after.json> [--out <dir>]",
        };
      }
      const initial = parseInputFileAsReport(beforeFile, targetUrl);
      const followUp = parseInputFileAsReport(afterFile, targetUrl);
      const comparison = compareReaudit(initial, followUp);
      const md = renderAuditMarkdown(followUp, comparison);
      const html = renderAuditHtml(followUp, comparison);
      if (outDir) {
        const dir = resolve(outDir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "persona-reaudit-report.json"),
          JSON.stringify({ report: followUp, reaudit: comparison }, null, 2),
          "utf8",
        );
        writeFileSync(join(dir, "persona-reaudit-report.md"), md, "utf8");
        writeFileSync(join(dir, "persona-reaudit-report.html"), html, "utf8");
      }
      const stdout = jsonMode
        ? JSON.stringify({ report: followUp, reaudit: comparison }, null, 2)
        : md;
      return { exitCode: comparison.exitCode, stdout, stderr: "" };
    }

    return {
      exitCode: 0,
      stdout:
        "Usage: node scripts/qa/persona-browser-audit.ts [--list-personas | --emulate <id> | --init-plan | --aggregate <file.json> | --reaudit <before.json> <after.json>] [--url <url>] [--out <dir>] [--json]",
      stderr: "",
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const res = runCli(process.argv.slice(2));
  if (res.stdout) console.log(res.stdout);
  if (res.stderr) console.error(res.stderr);
  process.exitCode = res.exitCode;
}
