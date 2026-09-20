#!/usr/bin/env node
/**
 * collaborator-web.ts — Interactive Developer Typing Guide & Rationale Web Viewer.
 *
 * Provides a zero-dependency web interface (default port 4785) for Collaborator Mode:
 *   1. Exact code typing location (File, Line range, Symbol)
 *   2. Code snippet / diff with syntax view & copy button
 *   3. Deep architectural explanations, rationale, and alternatives/trade-offs
 *   4. Interactive typing checklist and developer feedback submission
 *   5. Instant 1-click mode switching (Collaborator ⇄ Autonomous)
 *
 * Usage:
 *   node scripts/loop/collaborator-web.ts [--port=4785] [--open]
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { getCurrentMode, toggleMode, setMode, type ModeInfo } from "./mode.ts";
import { log } from "./telemetry.ts";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const GUIDE_FILE = resolve(STATE_DIR, "collaborator-guide.json");
const FEEDBACK_FILE = resolve(STATE_DIR, "collaborator-feedback.json");
const PORT = Number(process.env.HARNESS_COLLABORATOR_PORT) || 4785;

export interface TypingGuide {
  id: string;
  timestamp: string;
  title: string;
  targetFile: string;
  lineRange?: string;
  symbol?: string;
  action: "insert" | "replace" | "create" | "review";
  codeSnippet: string;
  explanation: string;
  rationale: string;
  alternatives?: Array<{ title: string; pros: string; cons: string }>;
  checklist: Array<{ text: string; done: boolean }>;
  testCommand?: string;
}

export function loadCurrentGuide(): TypingGuide {
  if (existsSync(GUIDE_FILE)) {
    try {
      return JSON.parse(readFileSync(GUIDE_FILE, "utf8"));
    } catch {}
  }
  return {
    id: "guide-sample",
    timestamp: new Date().toISOString(),
    title: "협업 모드: 타이핑 가이드 대기 중",
    targetFile: "src/example.ts",
    lineRange: "L1-L20",
    symbol: "exampleFunction()",
    action: "insert",
    codeSnippet: `// 에이전트와 대화하면서 협업 가이드가 발행되면 이곳에 실시간으로 표시됩니다.\nexport function calculateScore(items: number[]): number {\n  return items.reduce((acc, cur) => acc + cur, 0);\n}`,
    explanation: "협업 모드에서는 에이전트가 코드를 직접 수정하지 않고, 개발자가 직접 작성할 수 있도록 코드 위치와 설명을 제공합니다.",
    rationale: "개발자의 코드 통제권과 학습을 보장하며, 복잡한 비즈니스 로직에 대해 충분한 검토 후 적용할 수 있도록 돕습니다.",
    alternatives: [
      {
        title: "방안 A (함수형 reduce)",
        pros: "간결하고 불변성을 유지함",
        cons: "대규모 배열에서 미세한 오버헤드 가능",
      },
      {
        title: "방안 B (전통적인 for loop)",
        pros: "최대의 실행 속도",
        cons: "가변 상태 변수 필요",
      },
    ],
    checklist: [
      { text: "대상 파일 열기 및 위치 확인", done: false },
      { text: "코드 작성 및 타이핑 완료", done: false },
      { text: "단위 테스트 실행 및 확인", done: false },
    ],
    testCommand: "npm test",
  };
}

export function saveGuide(guide: TypingGuide): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(GUIDE_FILE, JSON.stringify(guide, null, 2), "utf8");
}

function renderHtml(mode: ModeInfo, guide: TypingGuide): string {
  const isCollab = mode.id === "collaborator";
  const guideJson = JSON.stringify(guide);
  const modeJson = JSON.stringify(mode);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Harness Collaborator — Developer Typing Guide</title>
  <style>
    :root {
      --bg: #0f1217;
      --paper: #161b22;
      --card-bg: #1c2129;
      --border: #28303d;
      --border-focus: #3b82f6;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --cobalt: #2563eb;
      --cobalt-hover: #1d4ed8;
      --green: #238636;
      --amber: #d29922;
      --red: #f85149;
      --code-bg: #0d1117;
      --font-display: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "JetBrains Mono", SFMono-Regular, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-display);
      font-size: 14px;
      line-height: 1.6;
      padding: 24px;
    }
    .container { max-width: 1040px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .logo-area { display: flex; align-items: center; gap: 12px; }
    .logo-badge {
      background: var(--cobalt);
      color: #fff;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 12px;
      letter-spacing: 0.5px;
    }
    h1 { font-size: 20px; font-weight: 600; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .mode-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      background: ${isCollab ? "rgba(37,99,235,0.15)" : "rgba(35,134,54,0.15)"};
      color: ${isCollab ? "#60a5fa" : "#4ade80"};
      border: 1px solid ${isCollab ? "rgba(37,99,235,0.4)" : "rgba(35,134,54,0.4)"};
    }
    .mode-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: ${isCollab ? "#3b82f6" : "#22c55e"};
      box-shadow: 0 0 8px ${isCollab ? "#3b82f6" : "#22c55e"};
    }
    button.btn {
      background: var(--card-bg);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    button.btn:hover { background: var(--border); border-color: var(--text-muted); }
    button.btn-primary {
      background: var(--cobalt);
      color: white;
      border-color: var(--cobalt);
    }
    button.btn-primary:hover { background: var(--cobalt-hover); }

    .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--paper);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .location-banner {
      background: #1c2433;
      border: 1px solid #2b3952;
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
    }
    .loc-item strong { color: var(--text-muted); font-size: 11px; display: block; text-transform: uppercase; }
    .loc-item span { color: #60a5fa; font-weight: 500; }

    .code-container {
      position: relative;
      margin-bottom: 16px;
    }
    pre.code-block {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 13px;
      color: #e6edf3;
      line-height: 1.5;
    }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      font-size: 11px;
      padding: 4px 8px;
    }

    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 16px 0 8px 0;
    }
    .prose { color: #c9d1d9; line-height: 1.6; }
    .prose p { margin-bottom: 8px; }

    .alt-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 13px;
    }
    .alt-table th, .alt-table td {
      padding: 8px 12px;
      border: 1px solid var(--border);
      text-align: left;
    }
    .alt-table th { background: var(--card-bg); color: var(--text-muted); }

    .checklist-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
    }
    .checklist-item input[type="checkbox"] {
      width: 16px; height: 16px; cursor: pointer;
    }

    textarea.feedback-input {
      width: 100%;
      height: 90px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      color: var(--text);
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      margin-bottom: 10px;
    }
    textarea.feedback-input:focus { outline: none; border-color: var(--border-focus); }
    .toast {
      display: none;
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #238636;
      color: white;
      padding: 10px 16px;
      border-radius: 6px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-area">
        <span class="logo-badge">HARNESS</span>
        <h1>Collaborator Guide & Rationale</h1>
      </div>
      <div class="header-actions">
        <div class="mode-pill">
          <div class="mode-dot"></div>
          <span id="mode-text">${mode.label}</span>
        </div>
        <button class="btn" id="toggle-mode-btn" onclick="toggleHarnessMode()">
          ${isCollab ? "자율 모드로 전환 ➔" : "협업 모드로 전환 ➔"}
        </button>
      </div>
    </header>

    <div class="grid">
      <main>
        <div class="card">
          <div class="card-title">
            <span id="guide-title">${escapeHtml(guide.title)}</span>
            <span style="font-size:12px; color:var(--text-muted);">${guide.timestamp.slice(11, 19)}</span>
          </div>

          <div class="location-banner">
            <div class="loc-item">
              <strong>타이핑 대상 파일 (File)</strong>
              <span id="guide-file">${escapeHtml(guide.targetFile)}</span>
            </div>
            <div class="loc-item">
              <strong>코드 위치 (Line Range)</strong>
              <span id="guide-lines">${escapeHtml(guide.lineRange || "Whole file / End of file")}</span>
            </div>
            <div class="loc-item">
              <strong>심볼 / 스코프 (Symbol)</strong>
              <span id="guide-symbol">${escapeHtml(guide.symbol || "Global")}</span>
            </div>
            <div class="loc-item">
              <strong>작업 유형 (Action)</strong>
              <span style="color:#fbbf24; text-transform:uppercase;">${guide.action}</span>
            </div>
          </div>

          <div class="section-title">작성할 코드 내용 (Code Snippet)</div>
          <div class="code-container">
            <button class="btn copy-btn" onclick="copyCode()">복사 (Copy)</button>
            <pre class="code-block" id="code-snippet">${escapeHtml(guide.codeSnippet)}</pre>
          </div>

          <div class="section-title">코드 상세 설명 (Explanation)</div>
          <div class="prose">
            <p id="guide-explanation">${escapeHtml(guide.explanation)}</p>
          </div>

          <div class="section-title">설계 결정 이유 및 배경 (Rationale)</div>
          <div class="prose">
            <p id="guide-rationale">${escapeHtml(guide.rationale)}</p>
          </div>

          ${guide.alternatives && guide.alternatives.length ? `
          <div class="section-title">대안 및 트레이드오프 (Alternatives & Trade-offs)</div>
          <table class="alt-table">
            <thead>
              <tr><th>방안</th><th>장점 (Pros)</th><th>단점 (Cons)</th></tr>
            </thead>
            <tbody>
              ${guide.alternatives.map((a) => `<tr><td><strong>${escapeHtml(a.title)}</strong></td><td>${escapeHtml(a.pros)}</td><td>${escapeHtml(a.cons)}</td></tr>`).join("")}
            </tbody>
          </table>` : ""}
        </div>
      </main>

      <aside>
        <div class="card">
          <div class="card-title">타이핑 확인 체크리스트</div>
          <div id="checklist-container">
            ${guide.checklist.map((item, idx) => `
              <div class="checklist-item">
                <input type="checkbox" id="chk-${idx}" ${item.done ? "checked" : ""} onchange="updateChecklist(${idx})">
                <label for="chk-${idx}" style="cursor:pointer;">${escapeHtml(item.text)}</label>
              </div>
            `).join("")}
          </div>
          ${guide.testCommand ? `
            <div style="margin-top:16px;">
              <div class="section-title">테스트 검증 명령</div>
              <pre class="code-block" style="padding:8px; font-size:12px;">${escapeHtml(guide.testCommand)}</pre>
            </div>
          ` : ""}
        </div>

        <div class="card">
          <div class="card-title">개발자 메모 / 에이전트 질문</div>
          <textarea class="feedback-input" id="feedback-text" placeholder="코드 수정 요청, 질문 또는 코멘트를 남겨주세요..."></textarea>
          <button class="btn btn-primary" style="width:100%;" onclick="submitFeedback()">에이전트에 메모 전송</button>
        </div>
      </aside>
    </div>
  </div>

  <div class="toast" id="toast">복사되었습니다!</div>

  <script>
    let currentGuide = ${guideJson};
    let currentMode = ${modeJson};

    function escapeHtml(s) {
      return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function showToast(msg) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.style.display = "block";
      setTimeout(() => { t.style.display = "none"; }, 2000);
    }

    function copyCode() {
      const code = document.getElementById("code-snippet").textContent;
      navigator.clipboard.writeText(code).then(() => {
        showToast("코드가 클립보드에 복사되었습니다!");
      });
    }

    async function toggleHarnessMode() {
      const res = await fetch("/api/mode/toggle", { method: "POST" });
      const data = await res.json();
      showToast("모드가 " + data.next.label + "으로 전환되었습니다.");
      setTimeout(() => { window.location.reload(); }, 600);
    }

    async function submitFeedback() {
      const text = document.getElementById("feedback-text").value.trim();
      if (!text) return;
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, timestamp: new Date().toISOString() })
      });
      document.getElementById("feedback-text").value = "";
      showToast("메모가 저장되었습니다.");
    }

    function updateChecklist(idx) {
      if (currentGuide.checklist[idx]) {
        currentGuide.checklist[idx].done = document.getElementById("chk-" + idx).checked;
        fetch("/api/guide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(currentGuide)
        });
      }
    }
  </script>
</body>
</html>`;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function startCollaboratorServer(port = PORT): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const mode = getCurrentMode();
      const guide = loadCurrentGuide();
      const html = renderHtml(mode, guide);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      const mode = getCurrentMode();
      const guide = loadCurrentGuide();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ mode, guide }));
      return;
    }

    if (url.pathname === "/api/mode/toggle" && req.method === "POST") {
      const result = toggleMode();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === "/api/guide" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const guide = JSON.parse(body);
          saveGuide(guide);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, guide }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid json" }));
        }
      });
      return;
    }

    if (url.pathname === "/api/feedback" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const feedback = JSON.parse(body);
          mkdirSync(STATE_DIR, { recursive: true });
          writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2), "utf8");
          log("collaborator.feedback", { detail: feedback });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[Collaborator Web] 실행 중: http://127.0.0.1:${port}`);
  });

  return server;
}

export function openBrowser(url: string): void {
  const cmd = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
    ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd).unref();
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  return process.argv[1].endsWith("collaborator-web.ts");
})();

if (isMainModule) {
  const shouldOpen = process.argv.includes("--open");
  const portArg = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
  const port = Number(portArg) || PORT;

  startCollaboratorServer(port);
  if (shouldOpen) {
    openBrowser(`http://127.0.0.1:${port}`);
  }
}
