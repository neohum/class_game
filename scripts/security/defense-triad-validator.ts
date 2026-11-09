// scripts/security/defense-triad-validator.ts
// Anti-Reverse-Engineering Defense Triad Validator
// Audits source files and build configurations across three mandatory security pillars:
// 1. Encryption (AEAD/KDF standards, no plaintext sensitive storage, no weak ciphers/hashes/PRNG)
// 2. Obfuscation (no production sourcemap exposure, no global window debug/secret hooks, symbol protection)
// 3. Server Verification (no client-only privilege/payment/license decisions, mandatory HMAC/Ed25519/Nonce attestation)

import ts from "typescript";
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TriadAxis = "encryption" | "obfuscation" | "server-verification";
export type TriadSeverity = "critical" | "high" | "medium" | "low";

export interface TriadViolation {
  ruleId: string;
  axis: TriadAxis;
  severity: TriadSeverity;
  file: string;
  line: number;
  column: number;
  message: string;
  snippet: string;
  remediation: string;
}

export interface TriadSnippetInput {
  file?: string;
  path?: string;
  content: string;
}

export type TriadInputItem = string | TriadSnippetInput;

export interface TriadValidatorOptions {
  rootDir?: string;
  includeTests?: boolean;
  failOnHigh?: boolean;
}

export interface TriadValidationResult {
  passed: boolean;
  score: number;
  grade: TriadSeverity;
  riskLevel: TriadSeverity;
  axisScores: {
    encryption: number;
    obfuscation: number;
    serverVerification: number;
  };
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
  violations: TriadViolation[];
  positiveSignals: {
    encryption: string[];
    obfuscation: string[];
    serverVerification: string[];
  };
  recommendations: string[];
  totalFiles: number;
  summary: string;
}

const SEVERITY_WEIGHTS: Record<TriadSeverity, number> = {
  critical: 30,
  high: 18,
  medium: 10,
  low: 4,
};

const AXIS_PENALTY: Record<TriadSeverity, number> = {
  critical: 45,
  high: 25,
  medium: 15,
  low: 5,
};

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".go",
  ".html",
  ".vue",
]);

const DEFAULT_IGNORE_DIRS = new Set([
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

const SENSITIVE_KEY_PATTERN =
  /\b(password|passwd|secret|secretKey|secret_key|apiKey|api_key|privateKey|private_key|licenseKey|license_key|masterKey|master_key|accessToken|access_token|refreshToken|refresh_token|authToken|auth_token|seedPhrase|mnemonic|vaultKey|creditCard)\b/i;

const ENCRYPTION_GUARD_PATTERN =
  /\b(encrypt|cipher|createCipheriv|aes-256-gcm|chacha20-poly1305|argon2|argon2id|scrypt|pbkdf2|hkdf|seal|aead|subtle\.encrypt|crypto\.subtle)\b/i;

const SERVER_VERIFICATION_GUARD_PATTERN =
  /\b(createHmac|hmac|ed25519|timingSafeEqual|crypto\.verify|subtle\.verify|verifySignature|verifyAttestation|verifyLicenseSignature|verifyToken|jwt\.verify|challenge|nonce|attestation)\b/i;

const STANDARD_CRYPTO_PATTERNS: Array<{ label: string; axis: TriadAxis; regex: RegExp }> = [
  { label: "AES-256-GCM", axis: "encryption", regex: /aes-256-gcm/i },
  { label: "ChaCha20-Poly1305", axis: "encryption", regex: /chacha20-poly1305/i },
  { label: "Argon2id", axis: "encryption", regex: /argon2id?/i },
  { label: "HKDF", axis: "encryption", regex: /\bhkdf(?:Sync)?\b/i },
  { label: "scrypt", axis: "encryption", regex: /\bscrypt(?:Sync)?\b/i },
  { label: "PBKDF2", axis: "encryption", regex: /\bpbkdf2(?:Sync)?\b/i },
  { label: "Obfuscation/Minification", axis: "obfuscation", regex: /\b(obfuscator|terser|esbuild|minify\s*:\s*true|sourcemap\s*:\s*false)\b/i },
  { label: "HMAC-SHA256", axis: "server-verification", regex: /\bcreateHmac\s*\(\s*["']sha256["']|\bhmac[-_]?sha256\b/i },
  { label: "Ed25519", axis: "server-verification", regex: /\bed25519\b/i },
  { label: "timingSafeEqual", axis: "server-verification", regex: /\btimingSafeEqual\b/ },
  { label: "Challenge-Response Nonce", axis: "server-verification", regex: /\b(nonce|challengeResponse|verifyNonce)\b/i },
];

function getLineAndColumn(content: string, index: number): { line: number; column: number; snippet: string } {
  const safeIndex = Math.max(0, Math.min(index, content.length));
  const prefix = content.slice(0, safeIndex);
  const lines = prefix.split(/\r?\n/);
  const line = lines.length;
  const lastLine = lines[lines.length - 1] ?? "";
  const column = lastLine.length + 1;
  const allLines = content.split(/\r?\n/);
  const rawLine = allLines[line - 1] ?? "";
  return {
    line,
    column,
    snippet: rawLine.trim().slice(0, 180),
  };
}

function addRegexViolations(
  content: string,
  file: string,
  regex: RegExp,
  build: (match: RegExpExecArray) => Omit<TriadViolation, "file" | "line" | "column" | "snippet"> | null,
  out: TriadViolation[],
): void {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const cloned = new RegExp(regex.source, flags);
  let match: RegExpExecArray | null;
  while ((match = cloned.exec(content)) !== null) {
    const info = build(match);
    if (!info) continue;
    const loc = getLineAndColumn(content, match.index);
    out.push({
      ...info,
      file,
      line: loc.line,
      column: loc.column,
      snippet: loc.snippet,
    });
  }
}

/**
 * Analyze a single file or source snippet across the 3 Defense Triad pillars.
 */
export function analyzeSourceTriad(
  content: string,
  file = "snippet.ts",
): {
  violations: TriadViolation[];
  positiveSignals: {
    encryption: string[];
    obfuscation: string[];
    serverVerification: string[];
  };
} {
  const violations: TriadViolation[] = [];
  const positiveSignals = {
    encryption: new Set<string>(),
    obfuscation: new Set<string>(),
    serverVerification: new Set<string>(),
  };

  for (const item of STANDARD_CRYPTO_PATTERNS) {
    if (item.regex.test(content)) {
      if (item.axis === "encryption") positiveSignals.encryption.add(item.label);
      else if (item.axis === "obfuscation") positiveSignals.obfuscation.add(item.label);
      else positiveSignals.serverVerification.add(item.label);
    }
  }

  const hasServerVerificationGuard = SERVER_VERIFICATION_GUARD_PATTERN.test(content);

  // =========================================================================
  // Pillar 1: Encryption (암호화)
  // =========================================================================

  // 1A. Plaintext sensitive storage in localStorage / sessionStorage / AsyncStorage
  addRegexViolations(
    content,
    file,
    /\b(?:localStorage|sessionStorage|AsyncStorage)\.setItem\s*\(\s*([^,]+),\s*([^)]+)\)/g,
    (match) => {
      const keyArg = match[1] ?? "";
      const valArg = match[2] ?? "";
      const combined = `${keyArg} ${valArg}`;
      if (!SENSITIVE_KEY_PATTERN.test(combined)) return null;
      if (ENCRYPTION_GUARD_PATTERN.test(valArg)) return null;
      return {
        ruleId: "TRIAD-ENC-PLAINTEXT-STORAGE",
        axis: "encryption",
        severity: "critical",
        message: "민감 데이터(암호·시크릿·토큰·라이선스 키·마스터 키)를 암호화(AEAD) 없이 로컬 스토리지에 평문 저장하고 있습니다.",
        remediation:
          "클라이언트에 민감 데이터를 저장할 때는 Argon2id/HKDF로 파생한 키와 AES-256-GCM(AEAD)으로 암호화하거나 서버 세션/HttpOnly 쿠키로 이전하세요.",
      };
    },
    violations,
  );

  // 1B. Plaintext sensitive storage via direct property assignment or JSON file write
  addRegexViolations(
    content,
    file,
    /\b(?:localStorage|sessionStorage)\s*\.\s*(password|passwd|secret|token|licenseKey|masterKey|privateKey|apiKey)\s*=/gi,
    () => ({
      ruleId: "TRIAD-ENC-PLAINTEXT-STORAGE",
      axis: "encryption",
      severity: "critical",
      message: "로컬/세션 스토리지 프로퍼티에 민감 식별자 또는 키를 평문으로 직접 대입하고 있습니다.",
      remediation: "평문 스토리지 기록을 제거하고 AES-256-GCM 암호화 볼트 또는 서버 측 세션 검증을 사용하세요.",
    }),
    violations,
  );

  // 1C. Weak cipher algorithms (ECB mode, DES, 3DES, RC4, deprecated createCipher)
  addRegexViolations(
    content,
    file,
    /\b(?:createCipheriv|createDecipheriv)\s*\(\s*["']([^"']*(?:ecb|des|rc4|bf|blowfish)[^"']*)["']/gi,
    (match) => ({
      ruleId: "TRIAD-ENC-WEAK-CIPHER",
      axis: "encryption",
      severity: "critical",
      message: `취약한 대칭키 암호 알고리즘/운용 모드('${match[1] ?? "weak-cipher"}')가 사용되었습니다. ECB 및 레거시 블록 암호는 패턴 노출 및 블록 재조립 공격에 취약합니다.`,
      remediation: "인증된 암호화 표준인 'aes-256-gcm' 또는 'chacha20-poly1305'(AEAD)와 고유한 96-bit IV(Nonce)를 사용하세요.",
    }),
    violations,
  );

  addRegexViolations(
    content,
    file,
    /\bcrypto\.createCipher\s*\(/g,
    () => ({
      ruleId: "TRIAD-ENC-WEAK-CIPHER",
      axis: "encryption",
      severity: "critical",
      message: "폐기된 crypto.createCipher() API는 정적 MD5 기반 키 파생과 IV 미사용으로 역공학 및 암호 해독에 취약합니다.",
      remediation: "Argon2id/scrypt/HKDF로 파생된 32바이트 키와 crypto.createCipheriv('aes-256-gcm', key, iv)를 사용하세요.",
    }),
    violations,
  );

  // 1D. Weak hash algorithms (MD5, SHA1)
  addRegexViolations(
    content,
    file,
    /\b(?:createHash|createHmac)\s*\(\s*["'](md5|sha1|sha-1|md4|ripemd160)["']\s*\)/gi,
    (match) => ({
      ruleId: "TRIAD-ENC-WEAK-HASH",
      axis: "encryption",
      severity: "high",
      message: `충돌 저항성이 깨진 취약 해시 알고리즘('${(match[1] ?? "").toUpperCase()}')이 사용되었습니다.`,
      remediation:
        "무결성 검증에는 HMAC-SHA256 또는 SHA-256/SHA-512를 사용하고, 패스워드/키 파생에는 Argon2id, scrypt, PBKDF2-HMAC-SHA256, HKDF를 사용하세요.",
    }),
    violations,
  );

  // 1E. Math.random() used for security tokens, keys, nonces, salts, or secrets
  addRegexViolations(
    content,
    file,
    /\b(?:const|let|var)?\s*([A-Za-z0-9_$]*(?:token|secret|nonce|salt|masterKey|secretKey|apiKey|privateKey|licenseKey|sessionKey|authKey|otp|challenge)[A-Za-z0-9_$]*)\s*[:=][^\n;]*\bMath\.random\s*\(\s*\)/gi,
    (match) => ({
      ruleId: "TRIAD-ENC-INSECURE-RANDOM",
      axis: "encryption",
      severity: "high",
      message: `암호학적 안전성이 없는 Math.random()이 보안 값('${match[1] ?? "token"}') 생성에 사용되었습니다.`,
      remediation: "예측 불가능한 CSPRNG인 crypto.randomBytes(), crypto.getRandomValues(), 또는 crypto.randomUUID()를 사용하세요.",
    }),
    violations,
  );

  addRegexViolations(
    content,
    file,
    /\bfunction\s+([A-Za-z0-9_$]*(?:Token|Secret|Nonce|Key|Salt|Challenge|License)[A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{[^}]*\bMath\.random\s*\(\s*\)/gs,
    (match) => ({
      ruleId: "TRIAD-ENC-INSECURE-RANDOM",
      axis: "encryption",
      severity: "high",
      message: `보안 생성 함수('${match[1] ?? "generateToken"}') 내부에서 취약한 의사난수 생성기 Math.random()을 사용하고 있습니다.`,
      remediation: "crypto.randomBytes() 또는 Web Crypto API의 crypto.getRandomValues()로 교체하세요.",
    }),
    violations,
  );

  // =========================================================================
  // Pillar 2: Obfuscation (난독화 및 빌드 노출 차단)
  // =========================================================================

  // 2A. Sourcemap enabled in build/compiler config or inline sourceMappingURL
  addRegexViolations(
    content,
    file,
    /(?:["']?sourcemap["']?\s*:\s*(?:true|["']inline["']|["']both["'])|["']?sourceMap["']?\s*:\s*true|["']?inlineSourceMap["']?\s*:\s*true|devtool\s*:\s*["'](?:inline-source-map|eval-source-map|source-map|cheap-module-source-map)["']|\/\/[#@]\s*sourceMappingURL=)/g,
    (match) => ({
      ruleId: "TRIAD-OBF-SOURCEMAP-EXPOSED",
      axis: "obfuscation",
      severity: "critical",
      message: `프로덕션/번들 설정에서 소스맵 노출('${match[0].trim()}')이 감지되었습니다. 역공학자가 원본 소스 트리와 심볼을 그대로 복원할 수 있습니다.`,
      remediation: "프로덕션 빌드에서는 sourcemap: false로 설정하고, .map 파일 및 sourceMappingURL 주석을 배포 산출물에서 완전히 제거하세요.",
    }),
    violations,
  );

  // 2B. Global window / globalThis debug or secret hooks exposed
  addRegexViolations(
    content,
    file,
    /\b(?:window|globalThis)\s*(?:\.\s*__(?:SECRET|DEBUG|VAULT|KEYS?|MASTER_KEY|INTERNAL|ADMIN|PRIVILEGE|TOKEN)[A-Za-z0-9_]*|\[\s*["']__(?:SECRET|DEBUG|VAULT|KEYS?|MASTER_KEY|INTERNAL|ADMIN|PRIVILEGE|TOKEN)[A-Za-z0-9_]*["']\s*\])\s*=/gi,
    (match) => ({
      ruleId: "TRIAD-OBF-DEBUG-SYMBOL-LEAK",
      axis: "obfuscation",
      severity: "high",
      message: `전역 객체(window/globalThis)에 역공학 디버그·시크릿 심볼('${match[0].replace(/\s*=$/, "").trim()}')이 노출되어 있습니다.`,
      remediation: "전역 디버그 훅과 내부 볼트 참조를 제거하고, 클로저 격리 및 프로덕션 심볼 난독화(Terser/esbuild mangling)를 적용하세요.",
    }),
    violations,
  );

  // 2C. Explicit minification disabled in production config
  addRegexViolations(
    content,
    file,
    /\bminify\s*:\s*false\b/g,
    () => ({
      ruleId: "TRIAD-OBF-MINIFY-DISABLED",
      axis: "obfuscation",
      severity: "medium",
      message: "빌드 설정에서 코드 압축·난독화(minify: false)가 비활성화되어 식별자와 제어 흐름이 평문으로 노출됩니다.",
      remediation: "프로덕션 빌드에서는 minify: true (또는 'terser' / 'esbuild') 및 식별자 난독화(mangle)를 활성화하세요.",
    }),
    violations,
  );

  // =========================================================================
  // Pillar 3: Server Verification (서버 무결성 검증)
  // =========================================================================

  // 3A. Client-side-only privilege / payment / license / score decision from localStorage/sessionStorage
  addRegexViolations(
    content,
    file,
    /\b(?:localStorage|sessionStorage)\.getItem\s*\(\s*["'](isPremium|isPro|isPaid|isAdmin|isLicensed|licenseValid|vip|role|subscriptionTier|highScore|coins|credits)["']\s*\)\s*(?:===?\s*["'](?:true|1|admin|pro|premium|valid)["'])?/gi,
    (match) => {
      if (hasServerVerificationGuard) return null;
      return {
        ruleId: "TRIAD-SRV-CLIENT-SIDE-TRUST",
        axis: "server-verification",
        severity: "critical",
        message: `클라이언트 스토리지 값('${match[1] ?? "isPro"}')을 서버 서명 검증 없이 신뢰하여 권한·결제·라이선스 상태를 판정하고 있습니다.`,
        remediation:
          "클라이언트 스토리지 값은 공격자가 DevTools에서 즉시 변조할 수 있습니다. 서버에서 발급한 Ed25519/HMAC-SHA256 서명 토큰과 Nonce(Challenge-Response)를 서버 측에서 재검증하세요.",
      };
    },
    violations,
  );

  // 3B. Client-side conditional gate on mutable user/client object properties without server attestation
  addRegexViolations(
    content,
    file,
    /\bif\s*\(\s*(?:!?\s*)?(?:user|account|client|profile|state|license|subscription|player)\.(isPremium|isPro|isPaid|isLicensed|isVerified|isAdmin|hasValidLicense|canAccessVault)\b[^)]*\)/g,
    (match) => {
      if (hasServerVerificationGuard) return null;
      return {
        ruleId: "TRIAD-SRV-CLIENT-SIDE-TRUST",
        axis: "server-verification",
        severity: "critical",
        message: `서버 측 무결성 재검증(HMAC/Ed25519/Nonce) 없이 플래그('${match[1] ?? "isPremium"}')만으로 권한·유료 기능·라이선스를 판정하고 있습니다.`,
        remediation:
          "중요 권한·결제·라이선스 판정은 반드시 서버 측에서 암호학적 서명(HMAC-SHA256, Ed25519) 또는 Challenge-Response Nonce 검증을 거친 후 수행하세요.",
      };
    },
    violations,
  );

  // 3C. Sensitive state/entitlement/vault/license handler missing server-side signature/nonce verification
  const isSensitiveDomainModule =
    /\b(verifyLicense|activateLicense|unlockVault|grantEntitlement|processPayment|submitScore|claimReward|upgradeTier)\b/.test(content) ||
    /\b(?:app|router)\.(?:post|put|patch)\s*\(\s*["']\/api\/(?:license|payment|billing|vault|entitlement|score|reward|admin)/i.test(content);

  if (isSensitiveDomainModule && !hasServerVerificationGuard) {
    // Find first sensitive domain match for accurate line reporting
    const domainMatch =
      /\b(verifyLicense|activateLicense|unlockVault|grantEntitlement|processPayment|submitScore|claimReward|upgradeTier)\b/.exec(content) ??
      /\b(?:app|router)\.(?:post|put|patch)\s*\(\s*["']\/api\/(?:license|payment|billing|vault|entitlement|score|reward|admin)/i.exec(content);
    const loc = getLineAndColumn(content, domainMatch?.index ?? 0);
    violations.push({
      ruleId: "TRIAD-SRV-MISSING-INTEGRITY-ATTESTATION",
      axis: "server-verification",
      severity: "critical",
      file,
      line: loc.line,
      column: loc.column,
      snippet: loc.snippet,
      message:
        "라이선스·결제·볼트·보상 등 중요 데이터를 처리하는 모듈에 서버 측 무결성 검증(HMAC-SHA256/Ed25519 서명 또는 Challenge-Response Nonce) 경로가 누락되어 있습니다.",
      remediation:
        "요청 페이로드와 타임스탬프·Nonce에 대해 crypto.createHmac('sha256', secret) + crypto.timingSafeEqual() 또는 Ed25519 crypto.verify() 검증을 강제하세요.",
    });
  }

  // Optional TypeScript AST pass for deeper call-expression inspection on TS/JS files
  if (/\.(?:[cm]?[tj]sx?)$/i.test(file)) {
    try {
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        // Detect Object.assign(window, { __SECRET... }) or Reflect.set(window, '__SECRET...', ...)
        if (ts.isCallExpression(node)) {
          const exprText = node.expression.getText(sourceFile);
          if (
            (exprText === "Object.assign" || exprText === "Reflect.set") &&
            node.arguments.length >= 2
          ) {
            const firstArg = node.arguments[0]?.getText(sourceFile) ?? "";
            const secondArg = node.arguments[1]?.getText(sourceFile) ?? "";
            if (
              (firstArg === "window" || firstArg === "globalThis") &&
              /__(?:SECRET|DEBUG|VAULT|KEY|MASTER_KEY|INTERNAL)/i.test(secondArg)
            ) {
              const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
              const alreadyLogged = violations.some(
                (v) => v.ruleId === "TRIAD-OBF-DEBUG-SYMBOL-LEAK" && v.line === pos.line + 1,
              );
              if (!alreadyLogged) {
                violations.push({
                  ruleId: "TRIAD-OBF-DEBUG-SYMBOL-LEAK",
                  axis: "obfuscation",
                  severity: "high",
                  file,
                  line: pos.line + 1,
                  column: pos.character + 1,
                  snippet: node.getText(sourceFile).slice(0, 180),
                  message: `전역 객체(${firstArg})에 Object.assign/Reflect.set으로 민감 디버그·시크릿 심볼을 주입하고 있습니다.`,
                  remediation: "전역 객체에 내부 상태나 시크릿을 바인딩하지 말고 모듈 스코프 내 비공개 상태로 캡슐화하세요.",
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    } catch {
      // AST inspection is supplemental to deterministic pattern rules
    }
  }

  // Deduplicate identical ruleId + file + line combinations
  const seen = new Set<string>();
  const deduped = violations.filter((v) => {
    const key = `${v.ruleId}:${v.file}:${v.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    violations: deduped,
    positiveSignals: {
      encryption: [...positiveSignals.encryption],
      obfuscation: [...positiveSignals.obfuscation],
      serverVerification: [...positiveSignals.serverVerification],
    },
  };
}

function collectFilesFromDir(dir: string, rootDir: string, includeTests: boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
    if (!includeTests && (entry.name === "tests" || entry.name === "__tests__")) continue;
    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
    if (
      !includeTests &&
      (relPath === "scripts/security" ||
        relPath.startsWith("scripts/security/") ||
        relPath === "template/scripts/security" ||
        relPath.startsWith("template/scripts/security/") ||
        relPath === "scripts/loop/redact.ts" ||
        relPath === "template/scripts/loop/redact.ts")
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      collectFilesFromDir(fullPath, rootDir, includeTests, out);
    } else if (entry.isFile()) {
      if (!includeTests && /\.(?:test|spec)\.[cm]?[tj]sx?$/i.test(entry.name)) continue;
      if (SCANNABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

/**
 * Validate a set of files, directory paths, or in-memory code snippets against the Defense Triad.
 */
export function validateDefenseTriad(
  filesOrSnippets: TriadInputItem[] | TriadInputItem | { files?: TriadInputItem[]; snippets?: TriadSnippetInput[]; rootDir?: string },
  options: TriadValidatorOptions = {},
): TriadValidationResult {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const includeTests = options.includeTests ?? false;

  const items: TriadInputItem[] = [];
  if (Array.isArray(filesOrSnippets)) {
    items.push(...filesOrSnippets);
  } else if (typeof filesOrSnippets === "string") {
    items.push(filesOrSnippets);
  } else if (filesOrSnippets && typeof filesOrSnippets === "object") {
    if ("content" in filesOrSnippets) {
      items.push(filesOrSnippets);
    } else {
      if (Array.isArray(filesOrSnippets.files)) items.push(...filesOrSnippets.files);
      if (Array.isArray(filesOrSnippets.snippets)) items.push(...filesOrSnippets.snippets);
    }
  }

  const snippetTargets: Array<{ file: string; content: string }> = [];

  for (const item of items) {
    if (typeof item === "string") {
      const candidatePath = resolve(rootDir, item);
      if (existsSync(candidatePath)) {
        const st = statSync(candidatePath);
        if (st.isDirectory()) {
          const files = collectFilesFromDir(candidatePath, candidatePath, includeTests);
          for (const f of files) {
            snippetTargets.push({
              file: relative(rootDir, f).replace(/\\/g, "/") || f,
              content: readFileSync(f, "utf8"),
            });
          }
        } else if (st.isFile()) {
          snippetTargets.push({
            file: relative(rootDir, candidatePath).replace(/\\/g, "/") || item,
            content: readFileSync(candidatePath, "utf8"),
          });
        }
      } else {
        // Treat raw string that isn't an existing path as an inline code snippet
        snippetTargets.push({ file: "inline-snippet.ts", content: item });
      }
    } else if (item && typeof item === "object" && typeof item.content === "string") {
      snippetTargets.push({
        file: item.file ?? item.path ?? "inline-snippet.ts",
        content: item.content,
      });
    }
  }

  const allViolations: TriadViolation[] = [];
  const positiveEncryption = new Set<string>();
  const positiveObfuscation = new Set<string>();
  const positiveServer = new Set<string>();

  for (const target of snippetTargets) {
    const res = analyzeSourceTriad(target.content, target.file);
    allViolations.push(...res.violations);
    for (const s of res.positiveSignals.encryption) positiveEncryption.add(s);
    for (const s of res.positiveSignals.obfuscation) positiveObfuscation.add(s);
    for (const s of res.positiveSignals.serverVerification) positiveServer.add(s);
  }

  let encScore = 100;
  let obfScore = 100;
  let srvScore = 100;
  let totalDeduction = 0;

  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const v of allViolations) {
    const weight = SEVERITY_WEIGHTS[v.severity];
    const axisPenalty = AXIS_PENALTY[v.severity];
    totalDeduction += weight;

    if (v.axis === "encryption") encScore = Math.max(0, encScore - axisPenalty);
    else if (v.axis === "obfuscation") obfScore = Math.max(0, obfScore - axisPenalty);
    else if (v.axis === "server-verification") srvScore = Math.max(0, srvScore - axisPenalty);

    if (v.severity === "critical") criticalCount++;
    else if (v.severity === "high") highCount++;
    else if (v.severity === "medium") mediumCount++;
    else lowCount++;
  }

  const score = Math.max(0, Math.min(100, 100 - totalDeduction));

  let grade: TriadSeverity = "low";
  if (criticalCount > 0 || score < 40) {
    grade = "critical";
  } else if (highCount > 0 || score < 70) {
    grade = "high";
  } else if (mediumCount > 0 || score < 90) {
    grade = "medium";
  }

  const failOnHigh = options.failOnHigh ?? false;
  const passed = criticalCount === 0 && (!failOnHigh || highCount === 0) && score >= 70;

  const recommendations: string[] = [];
  if (encScore < 100 || positiveEncryption.size === 0) {
    recommendations.push(
      "[암호화] 중요 데이터 저장·전송 시 표준 AEAD(AES-256-GCM, ChaCha20-Poly1305)와 KDF(Argon2id, HKDF, scrypt)를 사용하세요.",
    );
  }
  if (obfScore < 100) {
    recommendations.push(
      "[난독화] 프로덕션 번들에서 sourcemap을 비활성화하고 전역 window/globalThis 디버그 심볼 노출을 제거하세요.",
    );
  }
  if (srvScore < 100) {
    recommendations.push(
      "[서버 무결성 검증] 클라이언트 측 상태(isPremium, isPro, localStorage)를 신뢰하지 말고 서버에서 HMAC-SHA256/Ed25519 서명과 Challenge-Response Nonce를 재검증하세요.",
    );
  }

  const summary = passed
    ? `방어 3대 축(암호화·난독화·서버 무결성 검증) 점검 통과 — 점수 ${score}/100 (위반 ${allViolations.length}건)`
    : `방어 3대 축 점검 실패(Fail-closed) — 점수 ${score}/100, 등급 ${grade.toUpperCase()} (critical ${criticalCount}건, high ${highCount}건, medium ${mediumCount}건)`;

  return {
    passed,
    score,
    grade,
    riskLevel: grade,
    axisScores: {
      encryption: encScore,
      obfuscation: obfScore,
      serverVerification: srvScore,
    },
    counts: {
      critical: criticalCount,
      high: highCount,
      medium: mediumCount,
      low: lowCount,
      total: allViolations.length,
    },
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    violations: allViolations,
    positiveSignals: {
      encryption: [...positiveEncryption],
      obfuscation: [...positiveObfuscation],
      serverVerification: [...positiveServer],
    },
    recommendations,
    totalFiles: snippetTargets.length,
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
  const result = validateDefenseTriad(targets.length > 0 ? targets : [process.cwd()]);
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[DEFENSE TRIAD] ${result.summary}`);
    for (const v of result.violations) {
      console.log(` - [${v.severity.toUpperCase()}] [${v.ruleId}] ${v.file}:${v.line}:${v.column} — ${v.message}`);
    }
  }
  process.exit(result.passed ? 0 : 1);
}
