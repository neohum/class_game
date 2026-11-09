// scripts/visual-inspector/inspect-web.ts
// Live Web Page Mathematical Visual Inspector
// Extracts 0.01px precision DOM bounding boxes via Headless Chrome CDP,
// evaluates 4/8pt grids, alignment offsets, collisions, and touch targets,
// and outputs an interactive HTML report and JSON statistics.

import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inspectLayout } from "./alignment-rule-engine.ts";
import { generateHtmlReport } from "./html-reporter.ts";
import type { InspectorOptions } from "./types.ts";

function findChromePath(): string {
  const candidates = [
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.CHROME_BIN,
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "google-chrome";
}

async function getWsUrl(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const list = JSON.parse(data);
          const pageTarget = list.find((t: { type: string }) => t.type === "page");
          resolve(pageTarget ? pageTarget.webSocketDebuggerUrl : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
  });
}

export async function inspectLiveWebPage(options: {
  url?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  reportPath?: string;
  jsonPath?: string;
  screenshotPath?: string;
  tolerance?: number;
  gridBase?: 4 | 8;
  minTouchTarget?: number;
  maxErrors?: number;
}): Promise<number> {
  const url = options.url || "http://127.0.0.1:3000/";
  const width = options.viewportWidth || 1440;
  const height = options.viewportHeight || 1080;
  const reportPath = options.reportPath || "evidence/visual-inspection-report.html";
  const jsonPath = options.jsonPath || "evidence/visual-inspection-result.json";
  const screenshotPath = options.screenshotPath || "evidence/visual-inspection-screenshot.png";
  const tolerance = options.tolerance ?? 2;
  const gridBase = options.gridBase ?? 4;
  const minTouchTarget = options.minTouchTarget ?? 44;
  const maxErrors = options.maxErrors ?? 0;

  console.log(`\n📐 [VISUAL INSPECTOR] Live Page Inspection: ${url}`);
  console.log(`- 뷰포트 규격: ${width}x${height}px`);
  console.log(`- 그리드 기준: ${gridBase}pt (오차 허용: ±${tolerance}px, 최소 터치: ${minTouchTarget}px)\n`);

  const chromePath = findChromePath();
  const debugPort = 9222 + Math.floor(Math.random() * 200);

  const chromeProc = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--window-size=${width},${height}`,
    "--disable-gpu",
    "--no-sandbox",
    url,
  ]);

  // Wait for remote debugging endpoint
  let wsUrl: string | null = null;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    wsUrl = await getWsUrl(debugPort);
    if (wsUrl) break;
  }

  if (!wsUrl) {
    console.error(`❌ Chrome 원격 디버깅 연결 실패 (${url}). 대상 서버가 실행 중인지 확인하세요.`);
    chromeProc.kill();
    return 1;
  }

  const ws = new WebSocket(wsUrl);
  let id = 1;
  const pending = new Map<number, (res: any) => void>();

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg.result);
        pending.delete(msg.id);
      }
    } catch {}
  };

  await new Promise((r) => (ws.onopen = r as () => void));

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const curId = id++;
      pending.set(curId, resolve);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

  // Wait for rendering & hydration
  await new Promise((r) => setTimeout(r, 1200));

  // Extract Bounding Boxes of visible elements
  const evalResult = await send("Runtime.evaluate", {
    expression: `
      (() => {
        const elements = [];
        const seen = new Set();
        const ignoredTags = new Set([
          'script', 'style', 'meta', 'link', 'head', 'noscript', 'template',
          'br', 'wbr', 'hr', 'defs', 'clippath', 'pattern', 'filter', 'mask',
          'lineargradient', 'radialgradient', 'stop'
        ]);

        // Prioritize major layout sections, containers, cards, and interactive elements
        const prioritySelector = [
          'header', 'nav', 'main', 'footer', 'section', 'article', 'aside', 'form',
          'button', 'a', 'input', 'select', 'textarea',
          '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
          '[class*="pc-"]', '[class*="card"]', '[class*="btn"]',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table'
        ].join(', ');

        let candidates = Array.from(document.querySelectorAll(prioritySelector));
        if (candidates.length < 20) {
          candidates = Array.from(document.querySelectorAll('body *'));
        }

        for (let i = 0; i < candidates.length; i++) {
          if (elements.length >= 350) break; // Safe limit for graph comparison O(N^2)

          const el = candidates[i];
          if (seen.has(el)) continue;

          const tag = el.tagName.toLowerCase();
          if (ignoredTags.has(tag)) continue;
          if (el.closest('svg') && tag !== 'svg') continue;

          const rect = el.getBoundingClientRect();
          if (rect.width <= 2 || rect.height <= 2) continue;

          const comp = getComputedStyle(el);
          if (comp.display === 'none' || comp.visibility === 'hidden' || parseFloat(comp.opacity || '1') <= 0.01) continue;

          // Filter out full-page wrappers to focus on meaningful components
          const isDocRoot = el === document.documentElement || el === document.body;
          if (isDocRoot) continue;

          const role = el.getAttribute('role') || undefined;
          const isInteractive = ['button', 'a', 'input', 'select', 'textarea'].includes(tag) ||
                                comp.cursor === 'pointer' ||
                                Boolean(role && ['button', 'link', 'tab', 'menuitem'].includes(role));

          // Retain component candidates
          const hasClasses = el.className && typeof el.className === 'string' && el.className.trim().length > 0;
          const hasId = Boolean(el.id);
          if (!hasClasses && !hasId && !isInteractive && rect.width > window.innerWidth * 0.95 && rect.height > window.innerHeight * 0.95) {
            continue;
          }

          seen.add(el);
          elements.push({
            id: el.id || ('el_' + tag + '_' + elements.length),
            selector: hasId ? ('#' + el.id) : (tag + (hasClasses ? ('.' + el.className.trim().split(/\\s+/)[0]) : '')),
            tag,
            role,
            interactive: isInteractive,
            visible: true,
            left: Math.round(rect.left * 100) / 100,
            top: Math.round(rect.top * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
            right: Math.round(rect.right * 100) / 100,
            bottom: Math.round(rect.bottom * 100) / 100,
            centerX: Math.round((rect.left + rect.width / 2) * 100) / 100,
            centerY: Math.round((rect.top + rect.height / 2) * 100) / 100
          });
        }

        return elements;
      })()
    `,
    returnByValue: true,
  });

  const rawElements = evalResult?.result?.value || [];

  // Capture screenshot
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot?.data && screenshotPath) {
    const fullShotPath = resolve(process.cwd(), screenshotPath);
    mkdirSync(dirname(fullShotPath), { recursive: true });
    writeFileSync(fullShotPath, Buffer.from(shot.data, "base64"));
  }

  ws.close();
  chromeProc.kill();

  // Run Rule Engine
  const inspectorOpts: InspectorOptions = {
    tolerance,
    gridBase,
    minTouchTarget,
    maxErrors,
  };

  const result = inspectLayout(rawElements, inspectorOpts);

  // Write HTML report
  if (reportPath) {
    const fullReportPath = resolve(process.cwd(), reportPath);
    mkdirSync(dirname(fullReportPath), { recursive: true });
    const html = generateHtmlReport(result);
    writeFileSync(fullReportPath, html, "utf8");
  }

  // Write JSON
  if (jsonPath) {
    const fullJsonPath = resolve(process.cwd(), jsonPath);
    mkdirSync(dirname(fullJsonPath), { recursive: true });
    writeFileSync(fullJsonPath, JSON.stringify(result, null, 2), "utf8");
  }

  // Output terminal summary
  console.log(`[수학적 정렬 및 그리드 감사 결과]`);
  console.log(`- 결과: ${result.summary.passed ? "✓ 통과 (PASSED)" : "❌ 결함 발견 (FAILED)"}`);
  console.log(`- 정렬 품질 점수: ${result.summary.score} / 100`);
  console.log(`- 감지된 요소: ${result.summary.visibleElements}개`);
  console.log(`- 물리적 충돌(Overlap): ${result.summary.collisionViolationsCount}건`);
  console.log(`- 터치 타겟 미달(<${minTouchTarget}px): ${result.summary.touchTargetViolationsCount}건`);
  console.log(`- 4/8pt 그리드 여백 위반: ${result.summary.spacingViolationsCount}건`);
  console.log(`- 시각적 축 오정렬(Offset): ${result.summary.alignmentViolationsCount}건`);
  console.log(`\n📊 시각 보고서: ${reportPath}`);
  console.log(`📄 JSON 데이터: ${jsonPath}\n`);

  return result.summary.passed ? 0 : (maxErrors > 0 && result.summary.totalViolations > maxErrors ? 1 : 0);
}

// CLI Execution entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    const prefix = flag + "=";
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };

  const url = getArg("--url") || args.find((a) => a.startsWith("http")) || "http://127.0.0.1:3000/";
  const reportPath = getArg("--report") || "evidence/visual-inspection-report.html";
  const jsonPath = getArg("--json") || "evidence/visual-inspection-result.json";
  const screenshotPath = getArg("--screenshot") || "evidence/visual-inspection-screenshot.png";
  const gridBase = (parseInt(getArg("--grid") || "4", 10) === 8 ? 8 : 4) as 4 | 8;
  const tolerance = parseFloat(getArg("--tolerance") || "2");
  const minTouchTarget = parseInt(getArg("--min-touch") || "44", 10);
  const maxErrors = parseInt(getArg("--max-errors") || "0", 10);

  inspectLiveWebPage({
    url,
    reportPath,
    jsonPath,
    screenshotPath,
    gridBase,
    tolerance,
    minTouchTarget,
    maxErrors,
  }).then((code) => process.exit(code));
}
