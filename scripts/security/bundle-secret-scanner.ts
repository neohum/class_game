// scripts/security/bundle-secret-scanner.ts
// Bundle & Artifact Reverse-Engineering Secret Scanner
// Detects hardcoded cryptographic keys/salts/IVs, high-entropy secrets, private key blocks,
// credential URLs, production sourcemap (.map / sourceMappingURL / config) exposure,
// and client-side window debug hooks. Compatible with scripts/loop/redact.ts.

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText } from "../loop/redact.ts";

export type BundleFindingSeverity = "critical" | "high" | "medium" | "low";

export type BundleFindingCategory =
  | "private-key"
  | "api-secret"
  | "hardcoded-crypto-key"
  | "high-entropy-secret"
  | "credential-url"
  | "sourcemap-exposure"
  | "debug-hook"
  | "protocol-constant";

export interface BundleSecretFinding {
  ruleId: string;
  category: BundleFindingCategory;
  severity: BundleFindingSeverity;
  file: string;
  line: number;
  column: number;
  message: string;
  redactedPreview: string;
  remediation: string;
  entropy?: number;
}

export interface BundleSnippetInput {
  file?: string;
  path?: string;
  content: string;
}

export type BundleScanTarget = string | BundleSnippetInput;

export interface BundleScanOptions {
  rootDir?: string;
  targets?: BundleScanTarget[];
  includeTests?: boolean;
  entropyThreshold?: number;
}

export interface BundleScanResult {
  passed: boolean;
  blocked: boolean;
  findings: BundleSecretFinding[];
  violations: BundleSecretFinding[];
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  scannedFiles: number;
  summary: string;
}

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".map",
  ".env",
  ".yaml",
  ".yml",
  ".toml",
  ".go",
  ".html",
  ".vue",
]);

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".harness",
  ".claude",
  ".agents",
  ".codex",
  ".gemini",
  "coverage",
  "evidence",
  "plans",
  "docs",
  "studio",
  "scratch",
  "evals",
  "current_tasks",
  "skills",
  "knowledge",
  "deploy",
]);

/**
 * Calculate Shannon entropy (bits per character) of a candidate secret string.
 */
export function calculateShannonEntropy(value: string): number {
  if (!value || value.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = value.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(3));
}

function getLineCol(content: string, index: number): { line: number; column: number; lineText: string } {
  const clamped = Math.max(0, Math.min(index, content.length));
  const prefix = content.slice(0, clamped);
  const lines = prefix.split(/\r?\n/);
  const line = lines.length;
  const column = (lines[lines.length - 1] ?? "").length + 1;
  const allLines = content.split(/\r?\n/);
  const lineText = (allLines[line - 1] ?? "").trim();
  return { line, column, lineText };
}

function maskPreview(rawLine: string): string {
  const scrubbed = redactText(rawLine);
  return scrubbed.slice(0, 180);
}

function isPlaceholderOrSafeValue(candidate: string): boolean {
  if (!candidate) return true;
  if (/^(?:\[REDACTED.*\]|\{\{.*\}\}|\$\{.*\}|<.*>|your[-_].*|example.*|placeholder.*|dummy.*|test[-_]?key|user|username|pass|password|pwd|none|null|undefined|auto|true|false)$/i.test(candidate)) {
    return true;
  }
  if (/^[/.~]|[/\\]/.test(candidate) && !candidate.includes("://")) {
    // Looks like a file path
    return true;
  }
  return false;
}

/**
 * Scan a single file's content (and path metadata) for bundle reverse-engineering exposures.
 */
export function scanTextForSecrets(
  content: string,
  file = "bundle.js",
  entropyThreshold = 3.65,
): BundleSecretFinding[] {
  const findings: BundleSecretFinding[] = [];
  const normalizedFile = file.replace(/\\/g, "/");
  const base = basename(normalizedFile);

  // 1. Physical .map file in bundle/artifact output
  if (normalizedFile.endsWith(".map")) {
    findings.push({
      ruleId: "BUNDLE-SEC-SOURCEMAP-FILE",
      category: "sourcemap-exposure",
      severity: "critical",
      file: normalizedFile,
      line: 1,
      column: 1,
      message: `프로덕션 번들 산출물에 소스맵 파일('${base}')이 포함되어 원본 소스 코드와 식별자가 그대로 노출됩니다.`,
      redactedPreview: maskPreview(content.slice(0, 120)),
      remediation: "프로덕션 빌드 파이프라인에서 .map 파일 생성을 끄거나 배포 아티팩트에서 즉시 삭제하세요.",
    });
  }

  // 2. Private key PEM/OpenSSH blocks
  const privateKeyRegex = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g;
  let match: RegExpExecArray | null;
  while ((match = privateKeyRegex.exec(content)) !== null) {
    const loc = getLineCol(content, match.index);
    findings.push({
      ruleId: "BUNDLE-SEC-PRIVATE-KEY",
      category: "private-key",
      severity: "critical",
      file: normalizedFile,
      line: loc.line,
      column: loc.column,
      message: "번들 또는 소스 파일에 비대칭 개인키(PEM/OpenSSH Private Key) 블록이 평문으로 내장되어 있습니다.",
      redactedPreview: "-----BEGIN [REDACTED] PRIVATE KEY-----",
      remediation: "개인키는 즉시 폐기(Revoke) 및 재발급하고, 서명 연산은 서버 측 KMS/HSM 또는 서버 전용 환경변수에서만 수행하세요.",
    });
  }

  // 3. Well-known API / Cloud / Provider secret tokens (OpenAI, AWS, GitHub, GitLab, Slack, Stripe)
  const tokenRegex =
    /\b(sk-proj-[A-Za-z0-9_-]{12,}|sk-live-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g;
  while ((match = tokenRegex.exec(content)) !== null) {
    const loc = getLineCol(content, match.index);
    findings.push({
      ruleId: "BUNDLE-SEC-API-KEY",
      category: "api-secret",
      severity: "critical",
      file: normalizedFile,
      line: loc.line,
      column: loc.column,
      message: `외부 API/클라우드 시크릿 토큰('${(match[1] ?? "").slice(0, 8)}...')이 코드 또는 번들에 하드코딩되어 있습니다.`,
      redactedPreview: maskPreview(loc.lineText),
      remediation: "하드코딩된 시크릿 토큰을 즉시 제거·재발급하고 서버 측 환경변수 및 백엔드 프록시를 통해 호출하세요.",
    });
  }

  // 4. Plaintext credentials embedded in URLs (https://user:pass@host)
  const credUrlRegex = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'`<>]+):([^\s/@:"'`<>]+)@([a-zA-Z0-9.-]+)/gi;
  while ((match = credUrlRegex.exec(content)) !== null) {
    const user = match[2] ?? "";
    const pass = match[3] ?? "";
    if (isPlaceholderOrSafeValue(user) || isPlaceholderOrSafeValue(pass)) continue;
    const loc = getLineCol(content, match.index);
    findings.push({
      ruleId: "BUNDLE-SEC-CREDENTIAL-URL",
      category: "credential-url",
      severity: "critical",
      file: normalizedFile,
      line: loc.line,
      column: loc.column,
      message: "엔드포인트 URL 내부에 평문 사용자명:비밀번호 자격증명이 포함되어 있습니다.",
      redactedPreview: `${match[1] ?? ""}[REDACTED]@[${match[4] ?? "host"}]`,
      remediation: "URL 내 자격증명을 제거하고 안전한 헤더 인증이나 런타임 시크릿 주입 방식을 사용하세요.",
    });
  }

  // 5. Hardcoded symmetric encryption keys, master keys, static salts, or static IVs
  const hardcodedCryptoRegex =
    /\b(masterKey|master_key|MASTER_KEY|encryptionKey|encryption_key|ENCRYPTION_KEY|aesKey|aes_key|AES_KEY|hmacSecret|hmac_secret|HMAC_SECRET|vaultSecret|vault_secret|VAULT_SECRET|staticSalt|static_salt|STATIC_SALT|hardcodedSalt|STATIC_IV|staticIv|protocolSecret|PROTOCOL_SECRET)\s*[:=]\s*["'`]([^"'`\r\n]{8,})["'`]/g;
  while ((match = hardcodedCryptoRegex.exec(content)) !== null) {
    const varName = match[1] ?? "masterKey";
    const secretVal = match[2] ?? "";
    if (isPlaceholderOrSafeValue(secretVal)) continue;
    const loc = getLineCol(content, match.index);
    findings.push({
      ruleId: "BUNDLE-SEC-HARDCODED-CRYPTO",
      category: "hardcoded-crypto-key",
      severity: "critical",
      file: normalizedFile,
      line: loc.line,
      column: loc.column,
      message: `암호화 키·솔트·프로토콜 시크릿('${varName}')이 고정 문자열 리터럴로 하드코딩되어 있습니다.`,
      redactedPreview: `${varName} = "[REDACTED]"`,
      remediation:
        "클라이언트 번들에 마스터 키나 고정 솔트를 내장하지 마세요. 사용자 패스워드/시드에서 Argon2id/HKDF로 동적 파생하거나 서버 측에서 처리하세요.",
    });
  }

  // 6. High-entropy secret literals assigned to secret/token/password/apiKey identifiers
  const candidateSecretAssignRegex =
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|signing[_-]?key|auth[_-]?key)[A-Za-z0-9_]*)\s*[:=]\s*["'`]([A-Za-z0-9+/=_-]{20,})["'`]/gi;
  while ((match = candidateSecretAssignRegex.exec(content)) !== null) {
    const keyName = match[1] ?? "secret";
    const rawValue = match[2] ?? "";
    if (isPlaceholderOrSafeValue(rawValue)) continue;
    // Skip if already caught by hardcodedCryptoRegex or tokenRegex
    if (/^(?:sk-proj-|sk-live-|sk-ant-|AKIA|ghp_|github_pat_|glpat-|xox[baprs]-)/.test(rawValue)) continue;
    const isHexSecret = /^[0-9a-fA-F]{32,}$/.test(rawValue);
    const hasMixedClasses = /[a-z]/.test(rawValue) && /[A-Z]/.test(rawValue) && /[0-9]/.test(rawValue);
    if (!isHexSecret && !hasMixedClasses) continue;
    const entropy = calculateShannonEntropy(rawValue);
    if (entropy < entropyThreshold) continue;
    const loc = getLineCol(content, match.index);
    findings.push({
      ruleId: "BUNDLE-SEC-HIGH-ENTROPY",
      category: "high-entropy-secret",
      severity: entropy >= 4.0 ? "critical" : "high",
      file: normalizedFile,
      line: loc.line,
      column: loc.column,
      message: `고엔트로피 시크릿 리터럴('${keyName}', 엔트로피 ${entropy} bits/char)이 하드코딩되어 있습니다.`,
      redactedPreview: `${keyName} = "[REDACTED_HIGH_ENTROPY]"`,
      remediation: "고엔트로피 시크릿 상수를 코드에서 제거하고 안전한 서버 환경변수 또는 시크릿 볼트로 이동하세요.",
      entropy,
    });
  }

  // 7. Sourcemap comment or production build config enabling sourcemaps
  const sourcemapRegex =
    /(?:\/\/[#@]\s*sourceMappingURL=([^\s*]+)|["']?sourcemap["']?\s*:\s*(?:true|["']inline["']|["']both["'])|["']?sourceMap["']?\s*:\s*true|["']?inlineSourceMap["']?\s*:\s*true|["']?productionBrowserSourceMaps["']?\s*:\s*true|devtool\s*:\s*["'](?:inline-source-map|eval-source-map|source-map|cheap-module-source-map)["'])/g;
  while ((match = sourcemapRegex.exec(content)) !== null) {
    const loc = getLineCol(content, match.index);
    findings.push({
      ruleId: match[1] ? "BUNDLE-SEC-SOURCEMAP-COMMENT" : "BUNDLE-SEC-SOURCEMAP-CONFIG",
      category: "sourcemap-exposure",
      severity: "critical",
      file: normalizedFile,
      line: loc.line,
      column: loc.column,
      message: `번들 또는 빌드 설정에서 소스맵 노출('${match[0].trim()}')이 감지되었습니다.`,
      redactedPreview: maskPreview(loc.lineText),
      remediation: "프로덕션 빌드 설정에서 sourcemap: false를 강제하고 번들에서 sourceMappingURL을 제거하세요.",
    });
  }

  // 8. Global window / globalThis debug hooks exposing internal state or vault
  const debugHookRegex =
    /\b(?:window|globalThis)\s*(?:\.\s*__(?:SECRET|DEBUG|VAULT|KEYS?|MASTER_KEY|INTERNAL|ADMIN|PRIVILEGE|TOKEN)[A-Za-z0-9_]*|\[\s*["']__(?:SECRET|DEBUG|VAULT|KEYS?|MASTER_KEY|INTERNAL|ADMIN|PRIVILEGE|TOKEN)[A-Za-z0-9_]*["']\s*\])\s*=/gi;
  while ((match = debugHookRegex.exec(content)) !== null) {
    const loc = getLineCol(content, match.index);
    findings.push({
      ruleId: "BUNDLE-SEC-DEBUG-HOOK",
      category: "debug-hook",
      severity: "high",
      file: normalizedFile,
      line: loc.line,
      column: loc.column,
      message: `클라이언트 전역 객체(window/globalThis)에 역공학 위험 디버그 훅('${match[0].replace(/\s*=$/, "").trim()}')이 노출되어 있습니다.`,
      redactedPreview: maskPreview(loc.lineText),
      remediation: "전역 window 디버그 프로퍼티 할당을 제거하고 내부 상태를 모듈 클로저로 격리하세요.",
    });
  }

  // Deduplicate by ruleId + file + line
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.ruleId}:${f.file}:${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function walkScannableFiles(dir: string, rootDir: string, includeTests: boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (!includeTests && (entry.name === "tests" || entry.name === "__tests__")) continue;
    const full = join(dir, entry.name);
    const rel = relative(rootDir, full).replace(/\\/g, "/");
    if (
      !includeTests &&
      (rel === "scripts/security" ||
        rel.startsWith("scripts/security/") ||
        rel === "template/scripts/security" ||
        rel.startsWith("template/scripts/security/") ||
        rel === "scripts/loop/redact.ts" ||
        rel === "template/scripts/loop/redact.ts")
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      walkScannableFiles(full, rootDir, includeTests, out);
    } else if (entry.isFile()) {
      if (!includeTests && /\.(?:test|spec)\.[cm]?[tj]sx?$/i.test(entry.name)) continue;
      if (SCANNABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Scan bundle directories, files, or in-memory snippets for reverse-engineering secret and sourcemap exposures.
 */
export function scanBundleSecrets(
  targetsOrOptions?:
    | BundleScanTarget
    | BundleScanTarget[]
    | BundleScanOptions,
  maybeOptions: BundleScanOptions = {},
): BundleScanResult {
  let options: BundleScanOptions = { ...maybeOptions };
  const rawTargets: BundleScanTarget[] = [];

  if (typeof targetsOrOptions === "string") {
    rawTargets.push(targetsOrOptions);
  } else if (Array.isArray(targetsOrOptions)) {
    rawTargets.push(...targetsOrOptions);
  } else if (targetsOrOptions && typeof targetsOrOptions === "object") {
    if ("content" in targetsOrOptions) {
      rawTargets.push(targetsOrOptions);
    } else {
      options = { ...options, ...targetsOrOptions };
      if (Array.isArray(targetsOrOptions.targets)) {
        rawTargets.push(...targetsOrOptions.targets);
      }
    }
  }

  const rootDir = resolve(options.rootDir ?? process.cwd());
  const includeTests = options.includeTests ?? false;
  const entropyThreshold = options.entropyThreshold ?? 3.65;

  if (rawTargets.length === 0) {
    rawTargets.push(rootDir);
  }

  const fileItems: Array<{ file: string; content: string }> = [];

  for (const target of rawTargets) {
    if (typeof target === "string") {
      const resolved = resolve(rootDir, target);
      if (existsSync(resolved)) {
        const st = statSync(resolved);
        if (st.isDirectory()) {
          const files = walkScannableFiles(resolved, resolved, includeTests);
          for (const f of files) {
            fileItems.push({
              file: relative(rootDir, f).replace(/\\/g, "/") || f,
              content: readFileSync(f, "utf8"),
            });
          }
        } else if (st.isFile()) {
          fileItems.push({
            file: relative(rootDir, resolved).replace(/\\/g, "/") || target,
            content: readFileSync(resolved, "utf8"),
          });
        }
      } else {
        fileItems.push({ file: "inline-bundle.js", content: target });
      }
    } else if (target && typeof target === "object" && typeof target.content === "string") {
      fileItems.push({
        file: target.file ?? target.path ?? "inline-bundle.js",
        content: target.content,
      });
    }
  }

  const findings: BundleSecretFinding[] = [];
  for (const item of fileItems) {
    findings.push(...scanTextForSecrets(item.content, item.file, entropyThreshold));
  }

  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const f of findings) {
    if (f.severity === "critical") criticalCount++;
    else if (f.severity === "high") highCount++;
    else if (f.severity === "medium") mediumCount++;
    else lowCount++;
  }

  const passed = criticalCount === 0 && highCount === 0;
  const summary = passed
    ? `번들 시크릿·소스맵 스캔 통과 — 스캔 파일 ${fileItems.length}건, 치명적 노출 0건`
    : `번들 시크릿·소스맵 노출 차단(Fail-closed) — critical ${criticalCount}건, high ${highCount}건 (총 ${findings.length}건)`;

  return {
    passed,
    blocked: !passed,
    findings,
    violations: findings,
    counts: {
      critical: criticalCount,
      high: highCount,
      medium: mediumCount,
      low: lowCount,
      total: findings.length,
    },
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    scannedFiles: fileItems.length,
    summary,
  };
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
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const targets = args.filter((a) => !a.startsWith("-"));
  const result = scanBundleSecrets(targets.length > 0 ? targets : [process.cwd()]);
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[BUNDLE SECRET SCANNER] ${result.summary}`);
    for (const f of result.findings) {
      console.log(` - [${f.severity.toUpperCase()}] [${f.ruleId}] ${f.file}:${f.line}:${f.column} — ${f.message}`);
    }
  }
  process.exit(result.passed ? 0 : 1);
}
