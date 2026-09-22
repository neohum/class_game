// planner-web.ts — Local Web Console for Harness Plan Documents & Project Reconnaissance.
//
// Zero-dependency web server (port 4790) enabling developers to:
//   1. Inspect projects and context in the workspace (structure, git, package, plans)
//   2. Draft, edit, and inspect Plan Documents (plans/<slug>.plan.md)
//   3. Validate plan specifications against harness gates (checkPlanDoc)
//   4. Approve plan documents and compile into the autonomous backlog (compilePlanDocs)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, join, basename } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { scanProjects, reconProject, type ProjectReconDetail } from "./project-recon.ts";
import { checkPlanDoc, compilePlanDocs } from "./plan-doc.ts";

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.HARNESS_PLANNER_PORT) || 4790;
const STUDIO_PORT = Number(process.env.HARNESS_DASHBOARD_PORT) || 4780;

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise<Record<string, any>>((res, rej) => {
    let body = "";
    req.on("data", (d: Buffer) => {
      body += d;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        res(body ? JSON.parse(body) : {});
      } catch (e) {
        rej(e);
      }
    });
    req.on("error", rej);
  });
}

function resolveTargetProject(url: URL): string {
  const projectParam = url.searchParams.get("project");
  if (projectParam && existsSync(resolve(projectParam))) {
    return resolve(projectParam);
  }
  return ROOT;
}

// SSE Subscribers
type Subscriber = {
  res: ServerResponse;
  projectPath: string;
};
const subscribers = new Set<Subscriber>();

function broadcast(projectPath: string, event: string, data: unknown): void {
  const payload = JSON.stringify(data);
  for (const sub of subscribers) {
    if (sub.projectPath.toLowerCase() === projectPath.toLowerCase()) {
      try {
        sub.res.write(`event: ${event}\ndata: ${payload}\n\n`);
      } catch {
        subscribers.delete(sub);
      }
    }
  }
}

export function openInBrowser(url: string): void {
  const chromeCmd =
    process.platform === "win32"
      ? `cmd /c start chrome "${url}"`
      : process.platform === "darwin"
      ? `open -a "Google Chrome" "${url}"`
      : `google-chrome "${url}" || chromium-browser "${url}" || chromium "${url}"`;

  exec(chromeCmd, (err) => {
    if (err) {
      const fallback =
        process.platform === "win32"
          ? `cmd /c start "" "${url}"`
          : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
      exec(fallback).unref();
    }
  });
}

export function generatePlanTemplate(slug: string, title: string, risk = "medium"): string {
  return `---
plan: ${slug}
status: draft
risk: ${risk}
owner: developer
---
# Plan: ${title}

## Intent
작업의 배경과 핵심 목표를 구체적으로 기술합니다.

## Non-goals
- 이번 계획에서 의도적으로 제외하는 사항 1
- 이번 계획에서 의도적으로 제외하는 사항 2

## Steps

### Step 1: ${slug}-core
- Goal: 핵심 모듈 및 인터페이스를 구현한다
- Files: src/index.ts, tests/index.test.ts
- Acceptance: AC-1: 단위 테스트를 통과하고 기대 동작을 검증한다
- Tests: npm test
- Risk: ${risk}
- Complexity: low
- Parallel: no

## Verification
Tier 1: \`npm run typecheck\`
Tier 2: \`npm test\`
Tier 3: 런타임 수동 검증 및 브라우저/콘솔 관찰

## Reviewer topology
builder=codex, reviewer=claude, challenge=on
`;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const projectPath = resolveTargetProject(url);
  const parts = url.pathname.slice(1).split("/"); // api/<action>/...
  const action = parts[1] || "";
  const subAction = parts[2] || "";

  // 1. Project discovery & recon
  if (req.method === "GET" && action === "projects") {
    const projects = scanProjects(ROOT);
    json(res, 200, { ok: true, current: ROOT, projects });
    return;
  }

  if (req.method === "GET" && action === "recon") {
    const recon = reconProject(projectPath);
    json(res, 200, { ok: true, recon });
    return;
  }

  // 2. Plans list (plans/*.plan.md)
  if (req.method === "GET" && action === "plans") {
    const plansDir = join(projectPath, "plans");
    const plans: Array<{ slug: string; title: string; status: string; risk: string; content: string; path: string }> = [];
    if (existsSync(plansDir)) {
      const files = readdirSync(plansDir).filter((f) => f.endsWith(".plan.md"));
      for (const f of files) {
        const fullPath = join(plansDir, f);
        const content = readFileSync(fullPath, "utf8");
        const slug = f.replace(/\.plan\.md$/, "");
        const statusMatch = content.match(/^status:\s*([a-z0-9_-]+)/im);
        const riskMatch = content.match(/^risk:\s*([a-z0-9_-]+)/im);
        const titleMatch = content.match(/^#\s+(?:Plan:\s*)?([^\r\n]+)/im);
        plans.push({
          slug,
          title: titleMatch && titleMatch[1] ? titleMatch[1].trim() : slug,
          status: statusMatch && statusMatch[1] ? statusMatch[1].trim() : "draft",
          risk: riskMatch && riskMatch[1] ? riskMatch[1].trim() : "medium",
          content,
          path: fullPath,
        });
      }
    }
    json(res, 200, { ok: true, plans });
    return;
  }

  // 3. Single Plan GET
  if (req.method === "GET" && action === "plan" && subAction) {
    const slug = subAction.replace(/\.plan\.md$/, "");
    const planPath = join(projectPath, "plans", `${slug}.plan.md`);
    if (!existsSync(planPath)) {
      json(res, 404, { ok: false, error: `Plan not found: ${slug}` });
      return;
    }
    const content = readFileSync(planPath, "utf8");
    const validation = checkPlanDoc(slug, { cwd: projectPath });
    json(res, 200, { ok: true, slug, content, validation });
    return;
  }

  // 4. Single Plan Save / Update
  if (req.method === "POST" && action === "plan" && subAction) {
    const slug = subAction.replace(/\.plan\.md$/, "");
    const body = await readBody(req);
    const content = String(body.content || "");
    const planPath = join(projectPath, "plans", `${slug}.plan.md`);
    mkdirSync(join(projectPath, "plans"), { recursive: true });
    writeFileSync(planPath, content, "utf8");
    const validation = checkPlanDoc(slug, { cwd: projectPath });
    broadcast(projectPath, "plan-updated", { slug });
    json(res, 200, { ok: true, slug, validation });
    return;
  }

  // 5. Create new plan from template
  if (req.method === "POST" && action === "plan-create") {
    const body = await readBody(req);
    const slug = String(body.slug || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const title = String(body.title || slug).trim();
    const risk = String(body.risk || "medium").trim();
    if (!slug) {
      json(res, 400, { ok: false, error: "slug is required" });
      return;
    }

    const planPath = join(projectPath, "plans", `${slug}.plan.md`);
    if (existsSync(planPath)) {
      json(res, 400, { ok: false, error: `Plan already exists: ${slug}` });
      return;
    }

    mkdirSync(join(projectPath, "plans"), { recursive: true });
    const content = generatePlanTemplate(slug, title, risk);
    writeFileSync(planPath, content, "utf8");
    const validation = checkPlanDoc(slug, { cwd: projectPath });

    broadcast(projectPath, "plan-created", { slug });
    json(res, 200, { ok: true, slug, content, validation });
    return;
  }

  // 6. Validate Plan
  if (req.method === "POST" && action === "plan-validate") {
    const body = await readBody(req);
    const slug = body.slug;
    if (!slug) {
      json(res, 400, { ok: false, error: "slug required" });
      return;
    }
    const validation = checkPlanDoc(slug, { cwd: projectPath });
    json(res, 200, { ok: true, validation });
    return;
  }

  // 7. Approve Plan and Compile to Backlog
  if (req.method === "POST" && action === "plan-approve") {
    const body = await readBody(req);
    const slug = body.slug;
    const planPath = join(projectPath, "plans", `${slug}.plan.md`);
    if (!existsSync(planPath)) {
      json(res, 404, { ok: false, error: `Plan not found: ${slug}` });
      return;
    }

    let content = readFileSync(planPath, "utf8");
    content = content.replace(/^status:\s*draft/im, "status: approved");
    writeFileSync(planPath, content, "utf8");

    // Compile into backlog
    let compileResult: any = null;
    try {
      compileResult = await compilePlanDocs({ cwd: projectPath });
    } catch (e: any) {
      compileResult = { error: e.message };
    }

    broadcast(projectPath, "plan-approved", { slug, compileResult });
    json(res, 200, { ok: true, slug, status: "approved", compileResult });
    return;
  }

  json(res, 404, { ok: false, error: `Unknown API: ${req.method} ${url.pathname}` });
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    // SSE Stream
    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write(": open\n\n");
      const projectPath = resolveTargetProject(url);
      const sub: Subscriber = { res, projectPath };
      subscribers.add(sub);
      req.on("close", () => subscribers.delete(sub));
      res.on("close", () => subscribers.delete(sub));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPlannerHtml());
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (err: any) {
    json(res, 500, { ok: false, error: err.message || String(err) });
  }
});

function renderPlannerHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Harness Plan Console</title>
  <style>
    :root {
      --bg: #0d1117;
      --panel: #161b22;
      --panel-hover: #1f242c;
      --line: #30363d;
      --fg: #c9d1d9;
      --fg-dim: #8b949e;
      --fg-bright: #f0f6fc;
      --acc: #58a6ff;
      --acc-glow: rgba(88, 166, 255, 0.15);
      --ok: #3fb950;
      --ok-glow: rgba(63, 185, 80, 0.15);
      --warn: #d29922;
      --warn-glow: rgba(210, 153, 34, 0.15);
      --err: #f85149;
      --err-glow: rgba(248, 81, 73, 0.15);
      --purple: #bc8cff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Top Navigation Bar */
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      flex-shrink: 0;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      color: var(--fg-bright);
      font-size: 14px;
    }
    .brand .logo { font-size: 18px; }
    .project-picker {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 4px 10px;
    }
    .project-picker select {
      background: transparent;
      border: none;
      color: var(--acc);
      font-size: 13px;
      font-weight: 600;
      outline: none;
      cursor: pointer;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn {
      background: var(--line);
      color: var(--fg-bright);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .btn:hover { background: var(--panel-hover); border-color: var(--fg-dim); }
    .btn-primary { background: #238636; border-color: rgba(240, 246, 252, 0.1); color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    .btn-accent { background: #1f6feb; border-color: rgba(240, 246, 252, 0.1); color: #fff; }
    .btn-accent:hover { background: #388bfd; }
    .pulse {
      width: 8px; height: 8px; border-radius: 50%; background: var(--ok);
      box-shadow: 0 0 8px var(--ok); animation: beat 2s infinite;
    }
    @keyframes beat { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }

    /* Main Grid Layout */
    .app-layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      flex: 1;
      overflow: hidden;
    }

    /* Left Sidebar: strictly left-aligned as per AGENTS.md rule */
    aside {
      background: var(--panel);
      border-right: 1px solid var(--line);
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow-y: auto;
    }
    .nav-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .nav-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--fg-dim);
      padding: 6px 10px 4px;
    }
    .nav-item {
      display: flex;
      align-items: center;
      justify-content: flex-start; /* MANDATORY RULE: 사이드바 메뉴 좌측 정렬 */
      gap: 10px;
      padding: 8px 12px;
      border-radius: 6px;
      color: var(--fg);
      background: transparent;
      border: none;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s ease;
      width: 100%;
    }
    .nav-item:hover { background: var(--panel-hover); color: var(--fg-bright); }
    .nav-item.active { background: var(--acc-glow); color: var(--acc); font-weight: 600; }
    .nav-badge {
      margin-left: auto;
      background: var(--line);
      color: var(--fg-dim);
      border-radius: 10px;
      padding: 1px 7px;
      font-size: 11px;
      font-weight: 600;
    }
    .nav-item.active .nav-badge { background: var(--acc); color: #000; }

    .sidebar-footer {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      font-size: 11px;
      color: var(--fg-dim);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    /* Main View Area */
    main {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg);
    }
    .tab-content {
      display: none;
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }
    .tab-content.active {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Plans Editor Layout */
    .plans-container {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 16px;
      flex: 1;
      min-height: 520px;
    }
    .plans-sidebar {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .plans-sidebar-header {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .plans-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .plan-item {
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 4px;
      border: 1px solid transparent;
    }
    .plan-item:hover { background: var(--panel-hover); }
    .plan-item.active { background: var(--acc-glow); border-color: var(--acc); }
    .plan-item-title { font-weight: 600; font-size: 12px; color: var(--fg-bright); }
    .plan-item-meta { display: flex; align-items: center; gap: 6px; font-size: 10px; }

    .plan-editor-pane {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .plan-editor-header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .plan-textarea {
      flex: 1;
      background: var(--bg);
      border: none;
      color: var(--fg-bright);
      font-family: monospace;
      font-size: 12px;
      padding: 16px;
      outline: none;
      resize: none;
      line-height: 1.6;
    }
    .plan-validation-bar {
      padding: 10px 16px;
      border-top: 1px solid var(--line);
      background: #11151c;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .validation-ok { color: var(--ok); font-weight: 600; }
    .validation-err { color: var(--err); font-weight: 500; }

    /* Recon Viewer */
    .recon-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }
    .recon-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .recon-card h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--fg-bright);
      border-bottom: 1px solid var(--line);
      padding-bottom: 6px;
    }
    .tree-box {
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      font-family: monospace;
      font-size: 12px;
      max-height: 220px;
      overflow-y: auto;
      color: var(--fg-dim);
    }

    /* Modal */
    .modal-backdrop {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      width: 500px;
      max-width: 90vw;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    .modal h2 { font-size: 15px; color: var(--fg-bright); }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-size: 11px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; }
    .form-control {
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--fg-bright);
      font-size: 13px;
      outline: none;
    }
    .form-control:focus { border-color: var(--acc); }

    .badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .badge-approved { background: var(--ok-glow); color: var(--ok); border: 1px solid var(--ok); }
    .badge-draft { background: var(--warn-glow); color: var(--warn); border: 1px solid var(--warn); }
    .badge-high { background: var(--err-glow); color: var(--err); border: 1px solid var(--err); }
    .badge-medium { background: var(--warn-glow); color: var(--warn); border: 1px solid var(--warn); }
    .badge-low { background: var(--ok-glow); color: var(--ok); border: 1px solid var(--ok); }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <span class="logo">📝</span>
      <span>Harness Plan Console</span>
      <span class="pulse" title="실시간 동기화 연결됨"></span>
    </div>

    <div class="project-picker">
      <span style="font-size: 11px; color: var(--fg-dim); font-weight: 600;">프로젝트:</span>
      <select id="projectSelect" onchange="onProjectChange(this.value)">
        <option value="">불러오는 중...</option>
      </select>
    </div>

    <div class="header-actions">
      <button class="btn btn-primary" onclick="openNewPlanModal()">+ 새 계획서 작성</button>
      <a class="btn" href="http://127.0.0.1:${STUDIO_PORT}" target="_blank" title="하네스 실시간 멀티에이전트 스튜디오 열기">📡 Studio</a>
    </div>
  </header>

  <div class="app-layout">
    <!-- Left Navigation Sidebar: strictly left-aligned -->
    <aside>
      <div class="nav-group">
        <div class="nav-label">Workspace Views</div>
        <button class="nav-item active" onclick="switchTab('plans')">
          <span>📝</span> <span>계획서 에디터 (Plans)</span>
          <span class="nav-badge" id="plansBadge">0</span>
        </button>
        <button class="nav-item" onclick="switchTab('recon')">
          <span>🔍</span> <span>프로젝트 정찰 (Recon)</span>
        </button>
      </div>

      <div class="sidebar-footer">
        <div><strong>현재 프로젝트:</strong> <span id="currentPath" style="word-break: break-all;">-</span></div>
        <div style="margin-top: 4px; color: var(--ok);">● 하네스 표준 계획서 규격 검증 (Fail-Closed)</div>
      </div>
    </aside>

    <!-- Main Content Area -->
    <main>
      <!-- 1. Plans Editor Tab -->
      <div id="tab-plans" class="tab-content active">
        <div class="plans-container">
          <div class="plans-sidebar">
            <div class="plans-sidebar-header">
              <span>계획서 목록 (plans/*.plan.md)</span>
              <button class="btn" style="padding: 2px 8px; font-size: 11px;" onclick="loadPlans()">🔄</button>
            </div>
            <div class="plans-list" id="plansList"></div>
          </div>

          <div class="plan-editor-pane">
            <div class="plan-editor-header">
              <div>
                <span style="font-weight: 600; color: var(--fg-bright); font-size: 14px;" id="activePlanTitle">선택된 계획서 없음</span>
                <span id="activePlanStatusBadge" style="margin-left: 8px;"></span>
                <span id="activePlanRiskBadge" style="margin-left: 4px;"></span>
              </div>
              <div style="display: flex; gap: 8px;">
                <button class="btn" onclick="validateCurrentPlan()">🔍 유효성 검사</button>
                <button class="btn btn-primary" onclick="saveActivePlan()">💾 저장</button>
                <button class="btn btn-accent" id="btnApprove" onclick="approveAndCompilePlan()">🚀 승인 & 백로그 컴파일</button>
              </div>
            </div>

            <textarea id="planEditorText" class="plan-textarea" placeholder="계획서를 선택하거나 [+ 새 계획서 작성] 버튼으로 생성하세요." oninput="onPlanEdited()"></textarea>

            <div class="plan-validation-bar" id="validationBar">
              <span id="validationMsg">계획서 규격을 확인하려면 [🔍 유효성 검사]를 누르세요.</span>
              <span id="validationStepsCount" style="color: var(--fg-dim);"></span>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Project Reconnaissance Tab -->
      <div id="tab-recon" class="tab-content">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <h2 style="font-size: 16px; color: var(--fg-bright);">🔍 프로젝트 정찰 (Context Exploration)</h2>
          <button class="btn" onclick="loadRecon()">🔄 정찰 새로고침</button>
        </div>

        <div class="recon-grid">
          <div class="recon-card">
            <h3>📦 패키지 & 환경 정보</h3>
            <div id="reconPackageInfo" style="display: flex; flex-direction: column; gap: 6px;"></div>
          </div>
          <div class="recon-card">
            <h3>🌿 Git 브랜치 및 변경 상태</h3>
            <div id="reconGitInfo" style="display: flex; flex-direction: column; gap: 6px;"></div>
          </div>
          <div class="recon-card">
            <h3>📁 주요 소스 파일</h3>
            <div class="tree-box" id="reconSourceTree"></div>
          </div>
          <div class="recon-card">
            <h3>🧪 테스트 스위트</h3>
            <div class="tree-box" id="reconTestTree"></div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <!-- New Plan Modal -->
  <div class="modal-backdrop" id="newPlanModal">
    <div class="modal">
      <h2>📝 새 하네스 계획서 생성</h2>
      <div class="form-group">
        <label>슬러그 (Slug - 파일명)</label>
        <input type="text" id="modalPlanSlug" class="form-control" placeholder="예: user-auth, fast-cache">
      </div>
      <div class="form-group">
        <label>계획서 제목</label>
        <input type="text" id="modalPlanTitle" class="form-control" placeholder="예: 사용자 인증 모듈 고도화">
      </div>
      <div class="form-group">
        <label>위험도 (Risk)</label>
        <select id="modalPlanRisk" class="form-control">
          <option value="low">Low (단순 수정/내부 개선)</option>
          <option value="medium" selected>Medium (기능 추가/API 변경)</option>
          <option value="high">High (인증/시크릿/DB 마이그레이션/결제)</option>
        </select>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px;">
        <button class="btn" onclick="closeNewPlanModal()">취소</button>
        <button class="btn btn-primary" onclick="submitNewPlan()">생성하기</button>
      </div>
    </div>
  </div>

  <script>
    let currentProject = "";
    let currentPlans = [];
    let activePlanSlug = "";

    async function init() {
      await loadProjects();
      await loadPlans();
      connectSse();
    }

    async function loadProjects() {
      try {
        const res = await fetch("/api/projects");
        const data = await res.json();
        const sel = document.getElementById("projectSelect");
        sel.innerHTML = "";
        currentProject = data.current;
        for (const p of data.projects) {
          const opt = document.createElement("option");
          opt.value = p.path;
          opt.textContent = p.name + (p.isCurrent ? " (현재)" : "") + (p.hasHarness ? " ⚡" : "");
          if (p.isCurrent) opt.selected = true;
          sel.appendChild(opt);
        }
        document.getElementById("currentPath").textContent = currentProject;
      } catch (e) {
        console.error("loadProjects failed:", e);
      }
    }

    async function onProjectChange(newPath) {
      if (!newPath) return;
      currentProject = newPath;
      document.getElementById("currentPath").textContent = currentProject;
      await loadPlans();
      await loadRecon();
    }

    function switchTab(tab) {
      document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

      const targetTab = document.getElementById("tab-" + tab);
      if (targetTab) targetTab.classList.add("active");

      const navBtn = Array.from(document.querySelectorAll(".nav-item")).find(b => b.getAttribute("onclick").includes("'" + tab + "'"));
      if (navBtn) navBtn.classList.add("active");

      if (tab === "recon") loadRecon();
    }

    async function loadPlans() {
      try {
        const res = await fetch("/api/plans?project=" + encodeURIComponent(currentProject));
        const data = await res.json();
        currentPlans = data.plans || [];
        document.getElementById("plansBadge").textContent = currentPlans.length;
        renderPlansList();

        if (currentPlans.length > 0 && !activePlanSlug) {
          openPlan(currentPlans[0].slug);
        } else if (activePlanSlug) {
          const stillExists = currentPlans.some(p => p.slug === activePlanSlug);
          if (stillExists) openPlan(activePlanSlug);
          else if (currentPlans.length > 0) openPlan(currentPlans[0].slug);
        }
      } catch (e) {
        console.error("loadPlans failed:", e);
      }
    }

    function renderPlansList() {
      const container = document.getElementById("plansList");
      container.innerHTML = "";
      if (currentPlans.length === 0) {
        container.innerHTML = '<div style="color: var(--fg-dim); padding: 12px; font-size: 12px;">등록된 계획서가 없습니다.</div>';
        return;
      }

      for (const p of currentPlans) {
        const item = document.createElement("div");
        item.className = "plan-item" + (p.slug === activePlanSlug ? " active" : "");
        item.onclick = () => openPlan(p.slug);

        const statusBadge = p.status === "approved"
          ? '<span class="badge badge-approved">승인됨</span>'
          : '<span class="badge badge-draft">초안</span>';

        const riskBadge = '<span class="badge badge-' + p.risk + '">' + p.risk + '</span>';

        item.innerHTML = \`
          <div class="plan-item-title">\${escapeHtml(p.title)}</div>
          <div class="plan-item-meta">
            \${statusBadge}
            \${riskBadge}
            <span style="color: var(--fg-dim);">\${p.slug}.plan.md</span>
          </div>
        \`;
        container.appendChild(item);
      }
    }

    async function openPlan(slug) {
      activePlanSlug = slug;
      renderPlansList();
      try {
        const res = await fetch(\`/api/plan/\${slug}?project=\` + encodeURIComponent(currentProject));
        const data = await res.json();
        if (data.ok) {
          document.getElementById("planEditorText").value = data.content;
          const plan = currentPlans.find(p => p.slug === slug);
          document.getElementById("activePlanTitle").textContent = plan ? plan.title : slug;

          const isApproved = plan && plan.status === "approved";
          document.getElementById("activePlanStatusBadge").innerHTML = isApproved
            ? '<span class="badge badge-approved">승인됨 (Approved)</span>'
            : '<span class="badge badge-draft">초안 (Draft)</span>';

          document.getElementById("activePlanRiskBadge").innerHTML = plan
            ? '<span class="badge badge-' + plan.risk + '">' + plan.risk + '</span>'
            : '';

          renderValidationResult(data.validation);
        }
      } catch (e) {
        console.error("openPlan failed:", e);
      }
    }

    function onPlanEdited() {
      document.getElementById("validationMsg").textContent = "편집 중... (저장 후 유효성 검사를 실행하세요)";
      document.getElementById("validationMsg").className = "";
    }

    async function saveActivePlan() {
      if (!activePlanSlug) return;
      const content = document.getElementById("planEditorText").value;
      try {
        const res = await fetch(\`/api/plan/\${activePlanSlug}?project=\` + encodeURIComponent(currentProject), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const data = await res.json();
        if (data.ok) {
          renderValidationResult(data.validation);
          await loadPlans();
        } else {
          alert("저장 실패: " + data.error);
        }
      } catch (e) {
        alert("오류: " + e.message);
      }
    }

    async function validateCurrentPlan() {
      if (!activePlanSlug) return;
      try {
        const res = await fetch("/api/plan-validate?project=" + encodeURIComponent(currentProject), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: activePlanSlug }),
        });
        const data = await res.json();
        renderValidationResult(data.validation);
      } catch (e) {
        alert("유효성 검사 실패: " + e.message);
      }
    }

    function renderValidationResult(val) {
      const msg = document.getElementById("validationMsg");
      const steps = document.getElementById("validationStepsCount");
      if (!val) return;

      if (val.ok) {
        msg.textContent = "✔ 하네스 계획서 표준 규격 준수 (검증 통과)";
        msg.className = "validation-ok";
      } else {
        const errs = (val.errors || []).join(", ");
        msg.textContent = "✖ 규격 위반: " + errs;
        msg.className = "validation-err";
      }

      if (val.plan && val.plan.steps) {
        steps.textContent = \`단계: \${val.plan.steps.length}개 step\`;
      }
    }

    async function approveAndCompilePlan() {
      if (!activePlanSlug) return;
      if (!confirm(\`계획서 [plans/\${activePlanSlug}.plan.md]를 승인하고 하네스 백로그 카드로 컴파일하시겠습니까?\`)) return;

      try {
        const res = await fetch("/api/plan-approve?project=" + encodeURIComponent(currentProject), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: activePlanSlug }),
        });
        const data = await res.json();
        if (data.ok) {
          alert(\`🚀 계획서가 성공적으로 승인 및 컴파일되었습니다!\`);
          await loadPlans();
          openPlan(activePlanSlug);
        } else {
          alert("승인 실패: " + data.error);
        }
      } catch (e) {
        alert("오류: " + e.message);
      }
    }

    function openNewPlanModal() {
      document.getElementById("modalPlanSlug").value = "";
      document.getElementById("modalPlanTitle").value = "";
      document.getElementById("newPlanModal").classList.add("open");
    }

    function closeNewPlanModal() {
      document.getElementById("newPlanModal").classList.remove("open");
    }

    async function submitNewPlan() {
      const slug = document.getElementById("modalPlanSlug").value.trim();
      const title = document.getElementById("modalPlanTitle").value.trim() || slug;
      const risk = document.getElementById("modalPlanRisk").value;

      if (!slug) {
        alert("슬러그를 입력하세요.");
        return;
      }

      try {
        const res = await fetch("/api/plan-create?project=" + encodeURIComponent(currentProject), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, title, risk }),
        });
        const data = await res.json();
        if (data.ok) {
          closeNewPlanModal();
          await loadPlans();
          openPlan(data.slug);
        } else {
          alert("계획서 생성 실패: " + data.error);
        }
      } catch (e) {
        alert("오류: " + e.message);
      }
    }

    async function loadRecon() {
      try {
        const res = await fetch("/api/recon?project=" + encodeURIComponent(currentProject));
        const data = await res.json();
        if (!data.ok) return;
        const r = data.recon;

        // Package
        const pkgDiv = document.getElementById("reconPackageInfo");
        pkgDiv.innerHTML = \`
          <div><strong>프로젝트명:</strong> \${r.packageJson?.name || r.name}</div>
          <div><strong>버전:</strong> \${r.packageJson?.version || "없음"}</div>
          <div><strong>설명:</strong> \${r.packageJson?.description || "설명 없음"}</div>
          <div><strong>계획서 현황:</strong> 총 \${r.plans.length}건</div>
        \`;

        // Git
        const gitDiv = document.getElementById("reconGitInfo");
        gitDiv.innerHTML = \`
          <div><strong>현재 브랜치:</strong> \${r.git.branch}</div>
          <div><strong>최근 커밋:</strong> \${r.git.head} - \${r.git.lastCommit}</div>
          <div><strong>수정 중인 파일:</strong> \${r.git.dirtyCount}개</div>
        \`;

        // Trees
        const srcBox = document.getElementById("reconSourceTree");
        srcBox.innerHTML = (r.structure.sourceFiles || []).map(f => \`<div>📄 \${escapeHtml(f)}</div>\`).join("") || "<em>소스 파일 없음</em>";

        const testBox = document.getElementById("reconTestTree");
        testBox.innerHTML = (r.structure.testFiles || []).map(f => \`<div>🧪 \${escapeHtml(f)}</div>\`).join("") || "<em>테스트 파일 없음</em>";
      } catch (e) {
        console.error("loadRecon failed:", e);
      }
    }

    function connectSse() {
      const evt = new EventSource("/api/stream?project=" + encodeURIComponent(currentProject));
      evt.addEventListener("plan-updated", () => loadPlans());
      evt.addEventListener("plan-created", () => loadPlans());
      evt.addEventListener("plan-approved", () => loadPlans());
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    init();
  </script>
</body>
</html>`;
}
