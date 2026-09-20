#!/usr/bin/env node
/**
 * mode.ts — Dynamic Harness Mode Switcher (Autonomous ⇄ Collaborator ⇄ Verify).
 *
 * Safely switches the harness operational mode between:
 *   - autonomous: Proactive execution & verification
 *   - collaborator: Advisory & step-by-step developer typing guide
 *   - verify: Autonomous execution with thorough post-run doublecheck
 *
 * Usage:
 *   node scripts/loop/mode.ts [status|autonomous|collaborator|verify|toggle] [--json]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./telemetry.ts";

const ROOT = resolve(process.cwd());
const VERSION_FILE = resolve(ROOT, ".harness-version.json");
const AGENTS_FILE = resolve(ROOT, "AGENTS.md");
const CLAUDE_FILE = resolve(ROOT, "CLAUDE.md");

export interface ModeInfo {
  id: string;
  label: string;
  description: string;
  contractHeading: string;
  contractBody: string;
  adapterBody: string;
}

export const MODES: Record<string, ModeInfo> = {
  autonomous: {
    id: "autonomous",
    label: "자동 (자율 실행형)",
    description: "사용자가 맡긴 개발 작업을 주도적으로 실행하고 필요한 파일 변경 및 검증을 완료합니다.",
    contractHeading: "## Harness mode: Autonomous (자율 실행형)",
    contractBody: `## Harness mode: Autonomous (자율 실행형)

이 프로젝트는 기존 실행 중심 하네스를 사용한다. 사용자가 맡긴 개발 작업은
필요한 파일 변경과 검증까지 주도적으로 완료하고, 아래의 역할 파이프라인과
자율 루프를 사용할 수 있다.`,
    adapterBody: `## Active behavior mode

**Autonomous.** Carry out requested engineering work proactively, including
appropriate edits and verification, under the shared contract.`,
  },
  collaborator: {
    id: "collaborator",
    label: "학습과병행 (조언·기술·코드 제공형)",
    description: "설명과 선택지를 먼저 제공하고, 개발자가 직접 타이핑할 수 있도록 코드 위치와 내용을 가이드합니다.",
    contractHeading: "## Harness mode: Developer Collaborator (개발 협력자형)",
    contractBody: `## Harness mode: Developer Collaborator (개발 협력자형)

이 프로젝트의 에이전트는 개발자의 의사결정을 돕는 협력자로 행동한다.

- 먼저 문제와 목표를 함께 정리하고, 관련 개념·기술·트레이드오프를 개발자의
  수준과 질문에 맞춰 설명한다.
- 구현 시 개발자가 직접 타이핑할 수 있도록 파일 위치, 코드 스니펫, 변경 이유를
  안내하며, 웹 가이드 콘솔(scripts/collaborator-web.ts)을 활용할 수 있다.
- 단순 질문이나 검토 요청을 파일 직접 수정이나 자율 루프 가동으로 확대하지 않는다.
- 실제 파일 수정은 개발자가 명시적으로 지시했을 때만 수행한다.`,
    adapterBody: `## Active behavior mode

**Developer Collaborator.** Explain relevant concepts, options, trade-offs, and
project-specific code first. Guide the developer with exact typing locations, code snippets,
and rationale via the collaborator web viewer (node scripts/collaborator-web.ts). Do not edit
files unless explicitly requested.`,
  },
  verify: {
    id: "verify",
    label: "결과물 완결 및 재검증형 (Thorough Verification)",
    description: "요청받은 작업을 끝까지 만들고 실행/테스트 후 코너 케이스를 철저히 재점검합니다.",
    contractHeading: "## Harness mode: Thorough Verification (결과물 완결 및 재검증형)",
    contractBody: `## Harness mode: Thorough Verification (결과물 완결 및 재검증형)

이 프로젝트는 결과를 끝까지 만들고 실행 후 재점검하는 방식을 사용한다.

- 요청받은 작업을 코드 작성에서 멈추지 않고 실행/테스트까지 수행해 동작을 검증한다.
- 검증 후 잠재적 문제와 코너 케이스를 다시 한 번 점검(Doublecheck)한다.
- 자율 루프와 테스트 스위트의 게이트를 통과할 때까지 반복한다.`,
    adapterBody: `## Active behavior mode

**Thorough Verification.** Complete requested engineering tasks thoroughly to the end,
execute/run the results, and perform a careful doublecheck/recheck to ensure correctness.`,
  },
};

const DEFAULT_MODE: ModeInfo = MODES.autonomous!;

export function normalizeModeName(val: unknown): string {
  const s = String(val || "").toLowerCase().trim();
  if (["collaborator", "collab", "collaborative", "advisor", "guide", "협업", "협력자", "조언"].includes(s)) return "collaborator";
  if (["verify", "verification", "doublecheck", "검증", "재검증"].includes(s)) return "verify";
  return "autonomous";
}

export function getCurrentMode(root = ROOT): ModeInfo {
  const vPath = resolve(root, ".harness-version.json");
  if (existsSync(vPath)) {
    try {
      const data = JSON.parse(readFileSync(vPath, "utf8"));
      const modeKey = normalizeModeName(data.mode);
      return MODES[modeKey] ?? DEFAULT_MODE;
    } catch {}
  }
  return DEFAULT_MODE;
}

export function updateFileSection(filePath: string, startPattern: RegExp, endPattern: RegExp, replacement: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, "utf8");
  const match = content.match(startPattern);
  if (!match || match.index === undefined) return false;

  const startIndex = match.index;
  const rest = content.slice(startIndex);
  const endMatch = rest.slice(match[0].length).match(endPattern);

  let endIndex = content.length;
  if (endMatch && endMatch.index !== undefined) {
    endIndex = startIndex + match[0].length + endMatch.index;
  }

  const updated = content.slice(0, startIndex) + replacement.trim() + "\n\n" + content.slice(endIndex).replace(/^\n+/, "");
  writeFileSync(filePath, updated, "utf8");
  return true;
}

export function setMode(targetModeInput: string, root = ROOT): { prev: ModeInfo; next: ModeInfo; changed: boolean } {
  const targetMode = normalizeModeName(targetModeInput);
  const prev = getCurrentMode(root);
  const next = MODES[targetMode] ?? DEFAULT_MODE;

  const vPath = resolve(root, ".harness-version.json");
  let versionData: Record<string, unknown> = {};
  if (existsSync(vPath)) {
    try {
      versionData = JSON.parse(readFileSync(vPath, "utf8"));
    } catch {}
  }
  versionData.mode = next.id;
  writeFileSync(vPath, JSON.stringify(versionData, null, 2) + "\n", "utf8");

  // Sync AGENTS.md
  const aPath = resolve(root, "AGENTS.md");
  if (existsSync(aPath)) {
    updateFileSection(
      aPath,
      /## Harness mode:[^\n]+/,
      /\n(?=## )/,
      next.contractBody,
    );
  }

  // Sync CLAUDE.md
  const cPath = resolve(root, "CLAUDE.md");
  if (existsSync(cPath)) {
    updateFileSection(
      cPath,
      /## Active behavior mode[^\n]*/,
      /\n(?=## )/,
      next.adapterBody,
    );
  }

  log("mode.change", { detail: { from: prev.id, to: next.id } });
  return { prev, next, changed: prev.id !== next.id };
}

export function toggleMode(root = ROOT): { prev: ModeInfo; next: ModeInfo } {
  const current = getCurrentMode(root);
  const nextModeKey = current.id === "collaborator" ? "autonomous" : "collaborator";
  return setMode(nextModeKey, root);
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  return process.argv[1].endsWith("mode.ts");
})();

if (isMainModule) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const isJson = process.argv.includes("--json");
  const command = args[0] || "status";

  if (command === "status") {
    const current = getCurrentMode();
    if (isJson) {
      console.log(JSON.stringify(current, null, 2));
    } else {
      console.log(`\n[Harness Mode] 현재 모드: ${current.label} (${current.id})`);
      console.log(`설명: ${current.description}\n`);
      console.log("전환 명령어:");
      console.log("  node scripts/mode.ts collaborator  # 협업 모드로 전환");
      console.log("  node scripts/mode.ts autonomous    # 완전 자율 모드로 전환");
      console.log("  node scripts/mode.ts verify        # 재검증 모드로 전환");
      console.log("  node scripts/mode.ts toggle        # 자율 ⇄ 협업 상호 토글\n");
    }
  } else if (command === "toggle") {
    const { prev, next } = toggleMode();
    if (isJson) {
      console.log(JSON.stringify({ prev: prev.id, next: next.id }, null, 2));
    } else {
      console.log(`\n[Harness Mode] 모드 전환 완료: ${prev.label} ➔ ${next.label}`);
      console.log(`새 동작 지침: ${next.description}\n`);
    }
  } else {
    const { prev, next, changed } = setMode(command);
    if (isJson) {
      console.log(JSON.stringify({ prev: prev.id, next: next.id, changed }, null, 2));
    } else {
      console.log(`\n[Harness Mode] 모드 설정: ${next.label} (${next.id})`);
      console.log(`설명: ${next.description}\n`);
    }
  }
}
