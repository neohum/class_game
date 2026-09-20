// sloppiness.ts — deterministic static metrics for code sloppiness, erosion, and complexity.
//
// Based on empirical research (e.g. SlopCodeBench, Earendil "Measuring the sloppiness of code"):
//   - Verbosity: ratio of unnecessary duplicated/boilerplate lines
//   - Erosion: fraction of codebase mass concentrated in high-complexity functions (CC > 10)
//     Erosion = sum_{f: CC(f) > 10} mass(f) / sum_f mass(f), where mass(f) = SLOC(f) * CC(f)
//
// Designed to minimize Goodhart's law and builder-loop thrashing:
//   - Non-blocking (Soft Metric): informs reviewer and telemetry without hard-blocking builder
//   - Zero external dependencies: pure Node.js standard library
//   - Deterministic: objective AST/token analysis instead of subjective "AI as judge"

import { existsSync, readFileSync, statSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative, extname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface FunctionMetric {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  sloc: number;
  cc: number;
  mass: number;
  isHighComplexity: boolean; // cc > 10
}

export interface FileSloppiness {
  file: string;
  totalLines: number;
  totalSloc: number;
  functions: FunctionMetric[];
  highCcCount: number;
  highCcMass: number;
  totalMass: number;
  erosion: number; // 0.0 ~ 1.0
  duplicatedLineRatio: number;
}

export interface SloppinessReport {
  filesAnalyzed: number;
  totalLines: number;
  totalSloc: number;
  totalFunctions: number;
  highCcCount: number;
  highCcMass: number;
  totalMass: number;
  overallErosion: number;
  maxCc: number;
  duplicatedLineRatio: number;
  highCcFunctions: FunctionMetric[];
  status: "clean" | "warning";
  summary: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".cs"
]);

// Strip comments, strings, and regex literals to safely parse syntax tokens
export function stripCommentsAndStrings(source: string): { clean: string; originalLines: string[] } {
  const originalLines = source.split(/\r?\n/);
  let inBlockComment = false;
  let inString: string | null = null;
  let inRegex = false;
  let isEscaped = false;

  const chars = source.split("");
  const cleanChars: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1] || "";

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
        cleanChars.push(" ", " ");
      } else {
        cleanChars.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }

    if (inString !== null) {
      if (isEscaped) {
        isEscaped = false;
        cleanChars.push(ch === "\n" ? "\n" : " ");
      } else if (ch === "\\") {
        isEscaped = true;
        cleanChars.push(" ");
      } else if (ch === inString) {
        inString = null;
        cleanChars.push(" ");
      } else {
        cleanChars.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }

    if (inRegex) {
      if (isEscaped) {
        isEscaped = false;
        cleanChars.push(" ");
      } else if (ch === "\\") {
        isEscaped = true;
        cleanChars.push(" ");
      } else if (ch === "/") {
        inRegex = false;
        cleanChars.push(" ");
      } else {
        cleanChars.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }

    // Line comment
    if (ch === "/" && next === "/") {
      while (i < chars.length && chars[i] !== "\n") {
        cleanChars.push(" ");
        i++;
      }
      if (i < chars.length && chars[i] === "\n") {
        cleanChars.push("\n");
      }
      continue;
    }

    // Python comment
    if (ch === "#") {
      while (i < chars.length && chars[i] !== "\n") {
        cleanChars.push(" ");
        i++;
      }
      if (i < chars.length && chars[i] === "\n") {
        cleanChars.push("\n");
      }
      continue;
    }

    // Block comment start
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      cleanChars.push(" ", " ");
      continue;
    }

    // Regex literal heuristic: `/` preceded by operators, assignment, open paren, or return
    if (ch === "/" && next !== "/" && next !== "*") {
      let prevIdx = i - 1;
      while (prevIdx >= 0 && /\s/.test(chars[prevIdx] ?? "")) prevIdx--;
      const prevChar = prevIdx >= 0 ? (chars[prevIdx] ?? "") : "";
      if (/^[=(,:[!&|?+\-*%~^;<>]$/.test(prevChar)) {
        inRegex = true;
        cleanChars.push(" ");
        continue;
      }
    }

    // String start
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      cleanChars.push(" ");
      continue;
    }

    if (ch !== undefined) {
      cleanChars.push(ch);
    }
  }

  return { clean: cleanChars.join(""), originalLines };
}


// Compute cyclomatic complexity on a stripped code segment
export function computeComplexity(code: string): number {
  let cc = 1;

  // Branching keywords with word boundaries
  const keywordMatches = code.match(/\b(if|for|while|case|catch)\b/g);
  if (keywordMatches) {
    cc += keywordMatches.length;
  }

  // Logical operators: &&, ||, ??
  const opMatches = code.match(/(&&|\|\||\?\?)/g);
  if (opMatches) {
    cc += opMatches.length;
  }

  // Ternary operator: ? not followed by . or : or ?
  const ternaryMatches = code.match(/\?(?![.?:\w])/g);
  if (ternaryMatches) {
    cc += ternaryMatches.length;
  }

  return cc;
}

// Estimate line duplication / verbosity ratio
export function computeDuplicationRatio(lines: string[]): number {
  const nonEmpty = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 5 && !l.startsWith("//") && !l.startsWith("*"));

  if (nonEmpty.length < 10) return 0;

  const seen = new Map<string, number>();
  let duplicateCount = 0;

  for (const line of nonEmpty) {
    const count = (seen.get(line) || 0) + 1;
    seen.set(line, count);
    if (count > 1) duplicateCount++;
  }

  return Math.min(1, Math.round((duplicateCount / nonEmpty.length) * 100) / 100);
}

const RESERVED_KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "catch", "try",
  "finally", "return", "throw", "new", "typeof", "instanceof", "class",
  "interface", "type", "import", "export", "from", "as", "const", "let", "var"
]);

// Extract functions and measure their complexity
export function extractFunctions(filePath: string, source: string): FunctionMetric[] {
  const { clean, originalLines } = stripCommentsAndStrings(source);
  const functions: FunctionMetric[] = [];
  const lines = clean.split(/\r?\n/);

  // Pattern for function headers:
  // 1. (export )?(async )?function foo(...) {
  // 2. const foo = (async )?(...) => {
  // 3. const foo = (async )?function(...) {
  // 4. methodName(...) {
  const fnRegexes = [
    /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([a-zA-Z0-9_$]+)?\s*\(/,
    /(?:^|\s)(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>\s*\{/,
    /(?:^|\s)(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?function\s*([a-zA-Z0-9_$]+)?\s*\(/,
    /^\s*(?:(?:public|private|protected|static|async)\s+)*([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let fnName: string | null = null;

    for (const re of fnRegexes) {
      const match = re.exec(line);
      if (match) {
        const candidate = match[1] || match[2] || `<anonymous@L${i + 1}>`;
        if (!RESERVED_KEYWORDS.has(candidate)) {
          fnName = candidate;
          break;
        }
      }
    }

    if (fnName) {
      const startLine = i + 1;
      let braceDepth = 0;
      let foundStart = false;
      let endLine = startLine;
      const fnCodeChunks: string[] = [];

      for (let j = i; j < lines.length; j++) {
        const curLine = lines[j] ?? "";
        for (let k = 0; k < curLine.length; k++) {
          if (curLine[k] === "{") {
            braceDepth++;
            foundStart = true;
          } else if (curLine[k] === "}") {
            braceDepth--;
          }
        }
        fnCodeChunks.push(curLine);

        if (foundStart && braceDepth <= 0) {
          endLine = j + 1;
          // Advance outer loop to end of function to keep measurement clean and top-level focused
          i = j;
          break;
        }
      }


      const fnCode = fnCodeChunks.join("\n");
      const cc = computeComplexity(fnCode);

      // Compute SLOC for function
      const origFnLines = originalLines.slice(startLine - 1, endLine);
      const sloc = origFnLines.filter((l) => l.trim().length > 0).length;
      const mass = sloc * cc;

      functions.push({
        name: fnName,
        file: filePath,
        startLine,
        endLine,
        sloc,
        cc,
        mass,
        isHighComplexity: cc > 10,
      });
    }
  }

  return functions;
}


export function analyzeFile(filePath: string, content?: string): FileSloppiness {
  const source = content !== undefined ? content : readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const totalLines = lines.length;
  const totalSloc = lines.filter((l) => l.trim().length > 0 && !l.trim().startsWith("//")).length;

  const functions = extractFunctions(filePath, source);
  const highCcFunctions = functions.filter((f) => f.isHighComplexity);
  const highCcMass = highCcFunctions.reduce((sum, f) => sum + f.mass, 0);
  const totalMass = functions.reduce((sum, f) => sum + f.mass, 0);
  const erosion = totalMass > 0 ? Math.round((highCcMass / totalMass) * 100) / 100 : 0;
  const duplicatedLineRatio = computeDuplicationRatio(lines);

  return {
    file: filePath,
    totalLines,
    totalSloc,
    functions,
    highCcCount: highCcFunctions.length,
    highCcMass,
    totalMass,
    erosion,
    duplicatedLineRatio,
  };
}

export function aggregateReports(fileReports: FileSloppiness[]): SloppinessReport {
  let totalLines = 0;
  let totalSloc = 0;
  let totalFunctions = 0;
  let highCcCount = 0;
  let highCcMass = 0;
  let totalMass = 0;
  let maxCc = 1;
  let dupRatioSum = 0;
  const highCcFunctions: FunctionMetric[] = [];

  for (const report of fileReports) {
    totalLines += report.totalLines;
    totalSloc += report.totalSloc;
    totalFunctions += report.functions.length;
    highCcCount += report.highCcCount;
    highCcMass += report.highCcMass;
    totalMass += report.totalMass;
    dupRatioSum += report.duplicatedLineRatio;

    for (const fn of report.functions) {
      if (fn.cc > maxCc) maxCc = fn.cc;
      if (fn.isHighComplexity) highCcFunctions.push(fn);
    }
  }

  const overallErosion = totalMass > 0 ? Math.round((highCcMass / totalMass) * 100) / 100 : 0;
  const avgDupRatio = fileReports.length > 0 ? Math.round((dupRatioSum / fileReports.length) * 100) / 100 : 0;
  const isWarning = highCcFunctions.length > 0 || overallErosion >= 0.50;

  let summary = `Erosion: ${overallErosion} | Max CC: ${maxCc} | High-CC (CC>10): ${highCcCount}`;
  if (isWarning) {
    summary += ` (⚠️ Attention: ${highCcFunctions.length} complex functions detected)`;
  } else {
    summary += " (✓ Clean)";
  }

  return {
    filesAnalyzed: fileReports.length,
    totalLines,
    totalSloc,
    totalFunctions,
    highCcCount,
    highCcMass,
    totalMass,
    overallErosion,
    maxCc,
    duplicatedLineRatio: avgDupRatio,
    highCcFunctions,
    status: isWarning ? "warning" : "clean",
    summary,
  };
}

export function analyzeFiles(filePaths: string[], cwd = process.cwd()): SloppinessReport {
  const reports: FileSloppiness[] = [];
  for (const p of filePaths) {
    const fullPath = resolve(cwd, p);
    if (!existsSync(fullPath)) continue;
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
      const ext = extname(fullPath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      reports.push(analyzeFile(relative(cwd, fullPath).replace(/\\/g, "/")));
    } catch {
      // Best-effort: skip unreadable files
    }
  }
  return aggregateReports(reports);
}

// Git diff helper to find changed files
export function changedFilesForDiff(cwd = process.cwd(), baseline?: string | null): string[] {
  const set = new Set<string>();
  const git = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };

  if (baseline) {
    for (const f of git(["diff", "--name-only", baseline, "HEAD"]).split("\n")) {
      const trimmed = f.trim();
      if (trimmed) set.add(trimmed);
    }
  }

  for (const line of git(["status", "--porcelain", "-uall"]).split("\n")) {
    const trimmed = line.slice(3).trim();
    if (trimmed) set.add(trimmed.includes(" -> ") ? (trimmed.split(" -> ")[1] ?? trimmed) : trimmed);
  }

  return [...set].filter((f) => !f.startsWith(".harness/") && SUPPORTED_EXTENSIONS.has(extname(f).toLowerCase()));
}

export function analyzeDiff(cwd = process.cwd(), baseline?: string | null): SloppinessReport {
  const files = changedFilesForDiff(cwd, baseline);
  return analyzeFiles(files, cwd);
}

// Human-readable format for Reviewer prompt injection
export function formatSloppinessPrompt(report: SloppinessReport): string {
  if (report.filesAnalyzed === 0) return "";

  const lines = [
    `[CODE SLOPPINESS REPORT — deterministic static metrics]`,
    `Analyzed ${report.filesAnalyzed} changed file(s), ${report.totalFunctions} function(s).`,
    `Overall Erosion: ${report.overallErosion} (benchmarks: clean human code ~0.31, agent-slop ~0.68)`,
    `Max Cyclomatic Complexity: ${report.maxCc} (threshold: 10)`,
  ];

  if (report.highCcFunctions.length > 0) {
    lines.push(`High-Complexity Functions (CC > 10):`);
    for (const fn of report.highCcFunctions.slice(0, 10)) {
      lines.push(`  - ${fn.file}:${fn.startLine} ${fn.name}() — CC: ${fn.cc}, SLOC: ${fn.sloc}`);
    }
    if (report.highCcFunctions.length > 10) {
      lines.push(`  ... and ${report.highCcFunctions.length - 10} more`);
    }
    lines.push(`Guidance: Scrutinize whether these functions can be decomposed without artificial splitting. Do not reject on metric alone if complexity is inherently required, but prevent gratuitous slop accumulation.`);
  } else {
    lines.push(`No functions with CC > 10 detected. Complexity mass distribution is within healthy bounds.`);
  }

  lines.push(`[END SLOPPINESS REPORT]`);
  return lines.join("\n");
}

// Suggest a refactor card if erosion or high-CC functions warrant it
export function suggestRefactorCard(card: string, report: SloppinessReport): string | null {
  if (report.highCcFunctions.length === 0 && report.overallErosion < 0.5) return null;
  const topFn = [...report.highCcFunctions].sort((a, b) => b.cc - a.cc)[0];
  if (!topFn) return null;
  return `refactor: decompose complex function ${topFn.name}() in ${topFn.file} (CC: ${topFn.cc})`;
}

// --- CLI ---
export function runSloppinessCli(argv = process.argv.slice(2)): number {
  const jsonOutput = argv.includes("--json");
  const allFiles = argv.includes("--all");
  const targetPath = argv.find((a) => !a.startsWith("--"));

  let report: SloppinessReport;

  if (allFiles) {
    const scanDir = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...scanDir(full));
        else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) results.push(full);
      }
      return results;
    };
    report = analyzeFiles(scanDir(process.cwd()));
  } else if (targetPath) {
    const stat = existsSync(targetPath) ? statSync(targetPath) : null;
    if (stat?.isDirectory()) {
      const files = readdirSync(targetPath)
        .filter((f) => SUPPORTED_EXTENSIONS.has(extname(f).toLowerCase()))
        .map((f) => join(targetPath, f));
      report = analyzeFiles(files);
    } else {
      report = analyzeFiles([targetPath]);
    }
  } else {
    // Default: analyze git diff (staged + working tree)
    report = analyzeDiff();
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSloppinessPrompt(report));
  }

  return 0;
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
  process.exitCode = runSloppinessCli();
}

