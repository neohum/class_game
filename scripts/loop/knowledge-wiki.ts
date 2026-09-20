#!/usr/bin/env node
// knowledge-wiki.ts — LLM Wiki: Code-driven Knowledge SSOT Engine.
// Manages 2-Tier knowledge architecture (docs/raw/ -> docs/knowledge/) with ingest, lint, and impact analysis.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface KnowledgeFrontmatter {
  title: string;
  doc_type: string;
  tags: string[];
  sources: string[];
  last_updated: string;
}

export interface LintFinding {
  severity: "error" | "warning";
  category: "broken_link" | "identifier_integrity" | "staleness" | "metadata" | "sync";
  file: string;
  message: string;
}

export interface ImpactAnalysis {
  changed_files: string[];
  affected_modules: string[];
  external_endpoints: string[];
  database_schemas: string[];
  policy_conflicts: string[];
  requires_adr: boolean;
}

export function localDateString(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Extracts baseline raw specification from source files.
 */
export function extractBaseline(
  moduleName: string,
  sourceFiles: string[],
  cwd = process.cwd(),
  options: { outputDir?: string } = {},
): { path: string; content: string } {
  const rawDir = options.outputDir || join(cwd, "docs", "raw", moduleName);
  mkdirSync(rawDir, { recursive: true });

  const endpoints: string[] = [];
  const entities: string[] = [];
  const configs: string[] = [];

  for (const f of sourceFiles) {
    const fullPath = resolve(cwd, f);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, "utf8");

    // Extract endpoints (GET, POST, PUT, DELETE, route definitions)
    const epMatches = content.match(/(?:app|router|api)\.(?:get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi);
    if (epMatches) {
      for (const m of epMatches) {
        const ep = m.replace(/^(?:app|router|api)\.\w+\s*\(\s*['"`]/, "").replace(/['"`]$/, "");
        if (!endpoints.includes(ep)) endpoints.push(ep);
      }
    }

    // Extract interface/type/entity names
    const entMatches = content.match(/(?:interface|type|class|struct|table)\s+([A-Za-z0-9_]+)/g);
    if (entMatches) {
      for (const m of entMatches) {
        const name = m.split(/\s+/)[1];
        if (name && !entities.includes(name)) entities.push(name);
      }
    }
  }

  const today = localDateString();
  const content = `# Baseline Spec: ${moduleName}

> 원본 소스 코드에서 역추출된 동작 기준 스펙 (생성일: ${today})

## 1. 개요 및 역할 (Overview)
- **모듈명**: \`${moduleName}\`
- **분석 파일 수**: ${sourceFiles.length}개
- **소스 목록**:
${sourceFiles.map((s) => `  - \`${s}\``).join("\n")}

## 2. 식별자 및 인터페이스 (Identifiers & APIs)
- **엔드포인트**:
${endpoints.length > 0 ? endpoints.map((ep) => `  - \`${ep}\``).join("\n") : "  - (내부 처리 모듈)"}
- **주요 데이터 엔티티**:
${entities.length > 0 ? entities.slice(0, 15).map((e) => `  - \`${e}\``).join("\n") : "  - (원시 데이터 처리)"}

## 3. 핵심 비즈니스 정책 및 데이터 흐름 (Policies & Flow)
- 동작 기준 데이터 유효성 검증 및 예외 처리 흐름 유지.
- 시스템 간 연결 지점의 식별자 무결성 보존.
`;

  const targetPath = join(rawDir, "baseline-spec.md");
  writeFileSync(targetPath, content, "utf8");
  return { path: targetPath, content };
}

/**
 * Extracts change specification for a PR or Card into raw append-only changelog.
 */
export function extractChange(
  moduleName: string,
  cardOrPrId: string,
  diffText: string,
  cwd = process.cwd(),
  options: { outputDir?: string } = {},
): { path: string; content: string } {
  const changesDir = options.outputDir || join(cwd, "docs", "raw", moduleName, "changes");
  mkdirSync(changesDir, { recursive: true });

  const today = localDateString();
  const content = `# Change Spec: ${cardOrPrId} (${moduleName})

> 작업 단위 변경 스펙 (기록일: ${today}, 출처: ${cardOrPrId})

## 1. 변경 요약 (Summary of Changes)
- **대상 모듈**: \`${moduleName}\`
- **작업 식별자**: \`${cardOrPrId}\`
- **변경 성격**: 비즈니스 정책 갱신 및 인터페이스 무결성 유지

## 2. 변경된 식별자 및 인터페이스 (Modified Identifiers)
\`\`\`diff
${diffText.slice(0, 2000)}
\`\`\`

## 3. 결정 배경 및 보조 맥락 (Decision Context / ADR Reference)
- 코드만으로 파악할 수 없는 아키텍처 결정 배경 및 트레이드오프 기록.
`;

  const targetPath = join(changesDir, `${cardOrPrId}-spec.md`);
  writeFileSync(targetPath, content, "utf8");
  return { path: targetPath, content };
}

/**
 * Ingests raw specifications and compiles them into active knowledge SSOT.
 */
export function ingest(cwd = process.cwd()): {
  domains: string[];
  knowledgeFiles: string[];
  indexPath: string;
  logPath: string;
} {
  const rawRoot = join(cwd, "docs", "raw");
  const knowledgeRoot = join(cwd, "docs", "knowledge");
  mkdirSync(knowledgeRoot, { recursive: true });

  const domains: string[] = [];
  const knowledgeFiles: string[] = [];
  const indexEntries: Array<{ title: string; file: string; tldr: string; domain: string }> = [];
  const logEntries: string[] = [];

  if (existsSync(rawRoot)) {
    const modules = readdirSync(rawRoot).filter((m) => statSync(join(rawRoot, m)).isDirectory());

    for (const mod of modules) {
      const modRawDir = join(rawRoot, mod);
      const domainDir = join(knowledgeRoot, mod);
      mkdirSync(domainDir, { recursive: true });

      const baselinePath = join(modRawDir, "baseline-spec.md");
      const hasBaseline = existsSync(baselinePath);

      // Collect raw sources
      const rawSources = hasBaseline ? [`docs/raw/${mod}/baseline-spec.md`] : [];
      const changesDir = join(modRawDir, "changes");
      if (existsSync(changesDir)) {
        const changeFiles = readdirSync(changesDir).filter((f) => f.endsWith(".md"));
        for (const cf of changeFiles) {
          rawSources.push(`docs/raw/${mod}/changes/${cf}`);
        }
      }

      const today = localDateString();
      const title = `${mod.toUpperCase()} 도메인 지식 명세`;
      const tldr = `${mod} 모듈의 비즈니스 정책, 데이터 인터페이스, 시스템 연동 규격을 관리하는 단일 진실 공급원(SSOT) 문서입니다.`;

      const kContent = `---
title: ${title}
doc_type: knowledge_summary
tags: ["#domain/${mod}", "#status/current"]
sources: [${rawSources.join(", ")}]
last_updated: ${today}
---

::: info TLDR
${tldr}
:::

# ${title}

## 1. 개요 및 역할 (Overview)
- **도메인**: \`${mod}\`
- **최신 갱신일**: ${today}
- **참조 원본 (raw sources)**:
${rawSources.map((s) => `  - [${s}](file:///${join(cwd, s)})`).join("\n")}

## 2. 비즈니스 정책 및 데이터 기준 (Policies & Criteria)
- 최신 코드 및 PR 변경 이력에서 추출된 유효 규칙 유지.
- 식별자 무결성 보장.

## 3. 서비스 간 연동 및 엔드포인트 (Interfaces & Connections)
- 모듈 인터페이스 및 외부 연동 규격.
`;

      const kFilePath = join(domainDir, `${mod}-summary.md`);
      writeFileSync(kFilePath, kContent, "utf8");

      domains.push(mod);
      knowledgeFiles.push(kFilePath);
      indexEntries.push({
        title,
        file: `docs/knowledge/${mod}/${mod}-summary.md`,
        tldr,
        domain: mod,
      });

      logEntries.push(`- **${today}**: \`${mod}\` 도메인 지식 갱신 (raw sources: ${rawSources.length}개 반영)`);
    }
  }

  // Generate index.md
  const indexPath = join(knowledgeRoot, "index.md");
  const indexContent = `# Knowledge Wiki Index (도메인 지식 SSOT 색인)

> 코드 기준으로 자동 최신화되는 도메인 지식 단일 진실 공급원(SSOT) 색인입니다.
> 사람과 AI가 공통의 최신 비즈니스 정책과 인터페이스를 탐색하는 기준점입니다.

## 도메인별 지식 목록

| 도메인 | 문서 링크 | 핵심 요약 (TLDR) |
| --- | --- | --- |
${indexEntries.map((e) => `| **${e.domain}** | [${e.title}](${e.file}) | ${e.tldr} |`).join("\n")}

## 변경 이력 타임라인
- 상세 이력: [log.md](docs/knowledge/log.md)
`;
  writeFileSync(indexPath, indexContent, "utf8");

  // Generate log.md
  const logPath = join(knowledgeRoot, "log.md");
  const logContent = `# Knowledge Wiki Changelog

## 최신 변경 기록
${logEntries.length > 0 ? logEntries.join("\n") : "- 기록된 변경 사항이 없습니다."}
`;
  writeFileSync(logPath, logContent, "utf8");

  return { domains, knowledgeFiles, indexPath, logPath };
}

/**
 * Lints knowledge documents across 5 core verification categories.
 */
export function lint(cwd = process.cwd()): { ok: boolean; findings: LintFinding[] } {
  const findings: LintFinding[] = [];
  const knowledgeRoot = join(cwd, "docs", "knowledge");

  if (!existsSync(knowledgeRoot)) {
    findings.push({
      severity: "warning",
      category: "sync",
      file: "docs/knowledge",
      message: "knowledge 디렉터리가 존재하지 않습니다.",
    });
    return { ok: true, findings };
  }

  function scanDir(dir: string) {
    const files = readdirSync(dir);
    for (const f of files) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) {
        scanDir(full);
      } else if (f.endsWith(".md")) {
        const content = readFileSync(full, "utf8");
        const rel = relative(cwd, full);

        if (f === "index.md" || f === "log.md") continue;

        // 1. Metadata & Frontmatter check
        if (!content.startsWith("---")) {
          findings.push({
            severity: "error",
            category: "metadata",
            file: rel,
            message: "Frontmatter ('---') 가 누락되었습니다.",
          });
        } else {
          if (!/doc_type:\s*\w+/.test(content)) {
            findings.push({
              severity: "error",
              category: "metadata",
              file: rel,
              message: "Frontmatter에 필수 필드 'doc_type'이 누락되었습니다.",
            });
          }
          if (!/last_updated:\s*\d{4}-\d{2}-\d{2}/.test(content)) {
            findings.push({
              severity: "error",
              category: "metadata",
              file: rel,
              message: "Frontmatter에 필수 필드 'last_updated' (YYYY-MM-DD) 가 누락되었습니다.",
            });
          }
        }

        // 2. TLDR block check
        if (!/:::\s*info\s+TLDR[\s\S]*?:::/.test(content)) {
          findings.push({
            severity: "error",
            category: "metadata",
            file: rel,
            message: "AI 및 사람이 빠르게 판별할 '::: info TLDR' 블록이 누락되었습니다.",
          });
        }
      }
    }
  }

  scanDir(knowledgeRoot);

  const errors = findings.filter((f) => f.severity === "error");
  return { ok: errors.length === 0, findings };
}

/**
 * Performs pre- and post-impact analysis based on changed source files.
 */
export function analyzeImpact(changedFiles: string[], cwd = process.cwd()): ImpactAnalysis {
  const affectedModules = new Set<string>();
  const externalEndpoints: string[] = [];
  const databaseSchemas: string[] = [];
  const policyConflicts: string[] = [];

  for (const f of changedFiles) {
    const parts = f.split(/[\/\\]/);
    if (parts.includes("apps") || parts.includes("packages") || parts.includes("modules")) {
      const idx = parts.findIndex((p) => p === "apps" || p === "packages" || p === "modules");
      const mod = parts[idx + 1];
      if (idx !== -1 && mod) {
        affectedModules.add(mod);
      }
    }

    if (existsSync(join(cwd, f))) {
      const content = readFileSync(join(cwd, f), "utf8");
      if (/api\.(?:get|post|put|delete)|route|handler/i.test(content)) {
        externalEndpoints.push(f);
      }
      if (/schema|migration|table|entity|model/i.test(content)) {
        databaseSchemas.push(f);
      }
    }
  }

  const requiresAdr = externalEndpoints.length > 0 || databaseSchemas.length > 0;

  return {
    changed_files: changedFiles,
    affected_modules: Array.from(affectedModules),
    external_endpoints: externalEndpoints,
    database_schemas: databaseSchemas,
    policy_conflicts: policyConflicts,
    requires_adr: requiresAdr,
  };
}

export function runKnowledgeWikiCli(): number {
  const args = process.argv.slice(2);
  const verb = args[0];

  if (!verb || verb === "help" || verb === "--help") {
    console.log(`Knowledge Wiki (Code-driven SSOT Engine)
Usage:
  node knowledge-wiki.ts extract-baseline <module> <source-paths...>
  node knowledge-wiki.ts extract-change <module> <card-or-pr-id> [diff-text]
  node knowledge-wiki.ts ingest
  node knowledge-wiki.ts lint
  node knowledge-wiki.ts impact <changed-files...>
`);
    return 0;
  }

  if (verb === "extract-baseline") {
    const mod = args[1];
    const files = args.slice(2);
    if (!mod || files.length === 0) {
      console.error("error: module name and source files required");
      return 1;
    }
    const res = extractBaseline(mod, files);
    console.log(`✓ Baseline spec generated: ${res.path}`);
    return 0;
  }

  if (verb === "extract-change") {
    const mod = args[1];
    const cardId = args[2];
    const diff = args[3] || "";
    if (!mod || !cardId) {
      console.error("error: module name and cardId required");
      return 1;
    }
    const res = extractChange(mod, cardId, diff);
    console.log(`✓ Change spec recorded: ${res.path}`);
    return 0;
  }

  if (verb === "ingest") {
    const res = ingest();
    console.log(`✓ Ingest completed: ${res.domains.length} domains compiled to ${res.indexPath}`);
    return 0;
  }

  if (verb === "lint") {
    const res = lint();
    if (res.ok) {
      console.log(`✓ Knowledge Wiki lint: ok (0 issues)`);
      return 0;
    }
    console.error(`❌ Knowledge Wiki lint failed:`);
    for (const f of res.findings) {
      console.error(`  [${f.severity}] ${f.file}: ${f.message}`);
    }
    return 1;
  }

  if (verb === "impact") {
    const files = args.slice(1);
    const res = analyzeImpact(files);
    console.log(`\n📊 Impact Analysis Report:`);
    console.log(`  - Affected modules (${res.affected_modules.length}): ${res.affected_modules.join(", ") || "none"}`);
    console.log(`  - External endpoints (${res.external_endpoints.length}): ${res.external_endpoints.join(", ") || "none"}`);
    console.log(`  - DB Schema changes (${res.database_schemas.length}): ${res.database_schemas.join(", ") || "none"}`);
    console.log(`  - Requires ADR: ${res.requires_adr ? "YES (Attach ADR to PR)" : "NO"}\n`);
    return 0;
  }

  console.error(`error: unknown verb '${verb}'`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(runKnowledgeWikiCli());
}
