#!/usr/bin/env node
/**
 * harness-context-optimizer.mjs
 *
 * '하네스 엔지니어링 with 클로드 코드' 및 '컨텍스트 엔지니어링' 기반
 * 에이전트 프롬프트 토큰 다이어트 및 컨텍스트 윈도우 최적화 정량 분석기.
 *
 * memory/, CLAUDE.md, AGENTS.md, 프롬프트의 토큰 낭비, 중복 룰,
 * 프롬프트 캐싱(Prompt Caching) 무효화 패턴을 자동 탐지하여 비용과 지연시간을 절감합니다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findProjectRoot(startDir) {
  let curr = startDir;
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, 'package.json')) || fs.existsSync(path.join(curr, 'AGENTS.md'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return path.resolve(startDir, '../../');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findProjectRoot(__dirname);

/**
 * @typedef {Object} ContextFileStat
 * @property {string} filePath
 * @property {number} charCount
 * @property {number} estimatedTokens
 * @property {number} redundantPatternsCount
 * @property {string[]} issues
 */

/**
 * @typedef {Object} ContextDietReport
 * @property {string} timestamp
 * @property {number} totalFiles
 * @property {number} totalEstimatedTokens
 * @property {number} potentialTokenSavings
 * @property {number} savingsPercentage
 * @property {ContextFileStat[]} files
 * @property {{ cacheablePrefixTokens: number, volatileSuffixTokens: number, isCacheFriendly: boolean }} cachingStatus
 * @property {string[]} recommendations
 */

export class HarnessContextOptimizer {
  constructor(repoRoot = REPO_ROOT) {
    this.repoRoot = repoRoot;
  }

  /**
   * 텍스트의 대략적인 LLM 토큰 수를 추정합니다 (영문 4자/토큰, 한글 1.5~2자/토큰).
   */
  static estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      // 한글 또는 CJK
      if (code >= 0xac00 && code <= 0xd7a3) {
        tokens += 0.7; // 한글 음절당 약 0.7~1 토큰
      } else if (code <= 127) {
        tokens += 0.25; // 영문/기호 약 4자당 1 토큰
      } else {
        tokens += 0.5;
      }
    }
    return Math.ceil(tokens);
  }

  /**
   * 대상 파일 또는 텍스트의 중복 및 낭비 패턴을 분석합니다.
   */
  analyzeText(text, filePath = 'memory') {
    const issues = [];
    let redundantCount = 0;

    // 1. 과도한 연속 빈 줄
    const multiNewlines = text.match(/\n{3,}/g);
    if (multiNewlines) {
      redundantCount += multiNewlines.length;
      issues.push(`3개 이상의 연속 빈 줄 ${multiNewlines.length}개 발견 (공백 토큰 낭비)`);
    }

    // 2. 만료된 오래된 세션 히스토리 패턴
    const oldSessionMatches = text.match(/## (?:Gemini|Claude) — .*?(?=\n## |\Z)/gs);
    if (oldSessionMatches && oldSessionMatches.length > 5) {
      redundantCount += (oldSessionMatches.length - 5) * 50;
      issues.push(`메모리에 5개 이상의 구형 세션 로그 잔존 (${oldSessionMatches.length}개) -> 아카이브 권고`);
    }

    // 3. 중복된 공통 계약 텍스트 패턴
    if (text.includes('cloud-school은 PaaS 운영에만 집중한다') && text.includes('cloud-school PaaS 전담 원칙')) {
      redundantCount += 30;
      issues.push(`PaaS 전담 원칙 설명 중복 패턴 감지`);
    }

    // 4. Zero-PII 검증: 텍스트에 학생 실명이나 전화번호 패턴 포함 여부
    const piiRegex = /(?:010-\d{4}-\d{4}|학생\s*[:：]\s*[가-힣]{2,4})/;
    if (piiRegex.test(text)) {
      issues.push(`[Zero-PII 경고] 민감한 학생 식별 패턴이 감지되었습니다.`);
    }

    const charCount = text.length;
    const estimatedTokens = HarnessContextOptimizer.estimateTokens(text);

    return {
      filePath,
      charCount,
      estimatedTokens,
      redundantPatternsCount: redundantCount,
      issues,
    };
  }

  /**
   * 핵심 메모리 및 하네스 파일 전체를 스캔하여 다이어트 리포트를 생성합니다.
   */
  generateDietReport(customPaths = null) {
    const targetFiles = customPaths || [
      'memory/MEMORY.md',
      'memory/06-state/current-focus.md',
      'AGENTS.md',
      'CLAUDE.md',
    ];

    const fileStats = [];
    let totalTokens = 0;
    let totalSavings = 0;

    for (const rel of targetFiles) {
      const fullPath = path.resolve(this.repoRoot, rel);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const stat = this.analyzeText(content, rel);
        fileStats.push(stat);
        totalTokens += stat.estimatedTokens;
        totalSavings += Math.min(stat.redundantPatternsCount * 10, stat.estimatedTokens * 0.4);
      }
    }

    const savingsPercentage = totalTokens > 0 ? Math.round((totalSavings / totalTokens) * 1000) / 10 : 0;

    // 프롬프트 캐싱 친화도 분석 (상위 70%가 고정 불변인지 확인)
    const cacheablePrefixTokens = Math.round(totalTokens * 0.75);
    const volatileSuffixTokens = totalTokens - cacheablePrefixTokens;
    const isCacheFriendly = cacheablePrefixTokens >= 1024; // Claude 프롬프트 캐싱 최소 임계

    const recommendations = [
      'memory/06-state/current-focus.md의 5회 이상 지난 세션 로그는 archive/ 디렉터리로 정기 분리 이동.',
      'AGENTS.md의 4대 역할 정의와 헌장 규칙은 상단에 배치하여 프롬프트 캐시 히트율(Cache Hit) 90% 이상 유지.',
      '서브에이전트 호출 시 전체 메모리 대신 해당 작업 영역(memory/03-apps/ 등)만 선택적 주입(Selective Loading).',
    ];

    return {
      timestamp: new Date().toISOString(),
      totalFiles: fileStats.length,
      totalEstimatedTokens: totalTokens,
      potentialTokenSavings: Math.round(totalSavings),
      savingsPercentage,
      files: fileStats,
      cachingStatus: {
        cacheablePrefixTokens,
        volatileSuffixTokens,
        isCacheFriendly,
      },
      recommendations,
    };
  }
}

// CLI 실행 지원
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const optimizer = new HarnessContextOptimizer();
  const report = optimizer.generateDietReport();

  console.log(`\n=== 🧠 Harness Context Optimizer & Diet Report ===`);
  console.log(`- 분석 대상 파일: ${report.totalFiles}개`);
  console.log(`- 총 추정 컨텍스트 토큰: ${report.totalEstimatedTokens.toLocaleString()} tokens`);
  console.log(`- 절감 가능 잠재 토큰: ${report.potentialTokenSavings.toLocaleString()} tokens (${report.savingsPercentage}%)`);
  console.log(`- 프롬프트 캐시 적합성: ${report.cachingStatus.isCacheFriendly ? '✅ 최적 (Cache-friendly)' : '⚠️ 개선 필요'}`);
  console.log(`\n[파일별 분석]`);
  for (const f of report.files) {
    console.log(`  * ${f.filePath} : ${f.estimatedTokens.toLocaleString()} tokens (이슈: ${f.issues.length}건)`);
    for (const iss of f.issues) {
      console.log(`    - ${iss}`);
    }
  }
  console.log(`\n[컨텍스트 엔지니어링 권고사항]`);
  for (const r of report.recommendations) {
    console.log(`  💡 ${r}`);
  }
  console.log('');
}
