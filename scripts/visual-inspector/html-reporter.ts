// scripts/visual-inspector/html-reporter.ts
// Generates a self-contained, standalone interactive HTML report for visual grid inspection.

import type { InspectionResult } from "./types.ts";
import { renderSvgOverlay } from "./overlay-renderer.ts";

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function generateHtmlReport(result: InspectionResult, title = "Visual Grid Inspection Report"): string {
  const { summary } = result;
  const svgOverlay = renderSvgOverlay(result);

  let scoreColor = "#10b981"; // green
  let scoreGrade = "Excellent";
  if (summary.score < 50) {
    scoreColor = "#ef4444";
    scoreGrade = "Poor / Reject";
  } else if (summary.score < 75) {
    scoreColor = "#f59e0b";
    scoreGrade = "Needs Improvement";
  } else if (summary.score < 90) {
    scoreColor = "#06b6d4";
    scoreGrade = "Good";
  }

  const passBadge = summary.passed
    ? `<span style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #059669; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 13px;">PASSED</span>`
    : `<span style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #dc2626; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 13px;">FAILED</span>`;

  // Defect rows
  const defectRows: string[] = [];

  for (const c of result.collisionViolations) {
    defectRows.push(`
      <tr style="border-bottom: 1px solid #334155;">
        <td style="padding: 10px 14px;"><span style="background:#ef4444; color:#fff; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:bold;">COLLISION</span></td>
        <td style="padding: 10px 14px; font-family: monospace; color:#cbd5e1;">${escapeHtml(c.id)}</td>
        <td style="padding: 10px 14px; color:#cbd5e1;">${escapeHtml(c.elementAId)} ⚡ ${escapeHtml(c.elementBId)}</td>
        <td style="padding: 10px 14px; color:#f87171; font-weight:bold;">${c.overlapWidth}×${c.overlapHeight}px (${c.overlapArea}px²)</td>
        <td style="padding: 10px 14px; color:#94a3b8;">${escapeHtml(c.message)}</td>
        <td style="padding: 10px 14px; color:#38bdf8;">두 요소의 마진 또는 그리드 배치를 분리하여 중첩을 제거하십시오.</td>
      </tr>
    `);
  }

  for (const t of result.touchTargetViolations) {
    defectRows.push(`
      <tr style="border-bottom: 1px solid #334155;">
        <td style="padding: 10px 14px;"><span style="background:#f59e0b; color:#000; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:bold;">TOUCH TARGET</span></td>
        <td style="padding: 10px 14px; font-family: monospace; color:#cbd5e1;">${escapeHtml(t.id)}</td>
        <td style="padding: 10px 14px; color:#cbd5e1;">${escapeHtml(t.elementId)}</td>
        <td style="padding: 10px 14px; color:#fbbf24; font-weight:bold;">${t.width}×${t.height}px (&lt; ${t.minRequired}px)</td>
        <td style="padding: 10px 14px; color:#94a3b8;">${escapeHtml(t.message)}</td>
        <td style="padding: 10px 14px; color:#38bdf8;">최소 터치 크기 확보 (min-w-[44px] min-h-[44px] 또는 패딩 확장).</td>
      </tr>
    `);
  }

  for (const a of result.alignmentViolations) {
    defectRows.push(`
      <tr style="border-bottom: 1px solid #334155;">
        <td style="padding: 10px 14px;"><span style="background:#f43f5e; color:#fff; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:bold;">ALIGN OFFSET</span></td>
        <td style="padding: 10px 14px; font-family: monospace; color:#cbd5e1;">${escapeHtml(a.id)}</td>
        <td style="padding: 10px 14px; color:#cbd5e1;">${escapeHtml(a.elementId)} ${a.siblingId ? `(↔ ${escapeHtml(a.siblingId)})` : ""}</td>
        <td style="padding: 10px 14px; color:#fb7185; font-weight:bold;">Δ ${a.offset}px (${a.edge})</td>
        <td style="padding: 10px 14px; color:#94a3b8;">${escapeHtml(a.message)}</td>
        <td style="padding: 10px 14px; color:#38bdf8;">기준선에 맞추어 좌표를 ${a.expected}px로 스냅하십시오.</td>
      </tr>
    `);
  }

  for (const s of result.spacingViolations) {
    defectRows.push(`
      <tr style="border-bottom: 1px solid #334155;">
        <td style="padding: 10px 14px;"><span style="background:#eab308; color:#000; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:bold;">SPACING ${s.gridBase}pt</span></td>
        <td style="padding: 10px 14px; font-family: monospace; color:#cbd5e1;">${escapeHtml(s.id)}</td>
        <td style="padding: 10px 14px; color:#cbd5e1;">${escapeHtml(s.elementAId)} ↔ ${escapeHtml(s.elementBId)}</td>
        <td style="padding: 10px 14px; color:#fde047; font-weight:bold;">${s.distance}px (${s.axis})</td>
        <td style="padding: 10px 14px; color:#94a3b8;">${escapeHtml(s.message)}</td>
        <td style="padding: 10px 14px; color:#38bdf8;">${s.nearestLower}px 또는 ${s.nearestUpper}px로 여백 수정 권장.</td>
      </tr>
    `);
  }

  // Elements inventory rows
  const elementRows = result.elements.map((el) => `
    <tr style="border-bottom: 1px solid #334155;">
      <td style="padding: 8px 12px; font-family: monospace; color: #38bdf8;">${escapeHtml(el.id)}</td>
      <td style="padding: 8px 12px; color: #94a3b8;">${escapeHtml(el.tag || "-")}</td>
      <td style="padding: 8px 12px; color: #94a3b8;">${escapeHtml(el.role || "-")}</td>
      <td style="padding: 8px 12px;">${el.interactive ? '<span style="color:#34d399;">✓ Yes</span>' : '<span style="color:#64748b;">No</span>'}</td>
      <td style="padding: 8px 12px; font-family: monospace; color: #cbd5e1;">X:${el.x}, Y:${el.y}</td>
      <td style="padding: 8px 12px; font-family: monospace; color: #cbd5e1;">${el.width} × ${el.height}</td>
    </tr>
  `).join("\n");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #030712;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.5;
      padding: 32px 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .card {
      background-color: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    .header-grid {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 16px;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-top: 20px;
    }
    .metric-box {
      background-color: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .metric-value {
      font-size: 28px;
      font-weight: 700;
      font-family: ui-monospace, monospace;
      margin-top: 4px;
    }
    .metric-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
    }
    .table-container {
      overflow-x: auto;
      margin-top: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }
    th {
      background-color: #1e293b;
      color: #94a3b8;
      padding: 12px 14px;
      font-weight: 600;
      border-bottom: 2px solid #334155;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
    }
    .canvas-container {
      overflow: auto;
      max-height: 700px;
      background: #020617;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header Card -->
    <div class="card">
      <div class="header-grid">
        <div>
          <h1 style="font-size: 26px; font-weight: 800; color: #f8fafc; margin-bottom: 6px;">${escapeHtml(title)}</h1>
          <p style="color: #94a3b8; font-size: 14px;">생성 일시: ${escapeHtml(result.timestamp)} &bull; create-agent-harness Visual Grid Inspector</p>
        </div>
        <div style="text-align: right;">
          ${passBadge}
        </div>
      </div>

      <!-- KPI Metrics -->
      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">정렬 품질 점수</div>
          <div class="metric-value" style="color: ${scoreColor};">${summary.score}<span style="font-size: 14px; color: #94a3b8;">/100</span></div>
          <div style="font-size: 11px; color: ${scoreColor}; font-weight: 600;">${scoreGrade}</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">총 요소 수</div>
          <div class="metric-value" style="color: #e2e8f0;">${summary.visibleElements}</div>
          <div style="font-size: 11px; color: #64748b;">(숨김 제외: ${summary.filteredElements})</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">총 결함 수</div>
          <div class="metric-value" style="color: ${summary.totalViolations > 0 ? '#f87171' : '#34d399'};">${summary.totalViolations}</div>
          <div style="font-size: 11px; color: #94a3b8;">위반 항목 합계</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">충돌(Collision)</div>
          <div class="metric-value" style="color: ${summary.collisionViolationsCount > 0 ? '#ef4444' : '#94a3b8'};">${summary.collisionViolationsCount}</div>
          <div style="font-size: 11px; color: #94a3b8;">Critical (-15점)</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">터치 타겟 미달</div>
          <div class="metric-value" style="color: ${summary.touchTargetViolationsCount > 0 ? '#f59e0b' : '#94a3b8'};">${summary.touchTargetViolationsCount}</div>
          <div style="font-size: 11px; color: #94a3b8;">Serious (-10점)</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">오정렬(Offset)</div>
          <div class="metric-value" style="color: ${summary.alignmentViolationsCount > 0 ? '#f43f5e' : '#94a3b8'};">${summary.alignmentViolationsCount}</div>
          <div style="font-size: 11px; color: #94a3b8;">Serious (-5점)</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">간격 규칙 위반</div>
          <div class="metric-value" style="color: ${summary.spacingViolationsCount > 0 ? '#eab308' : '#94a3b8'};">${summary.spacingViolationsCount}</div>
          <div style="font-size: 11px; color: #94a3b8;">Warning (-3점)</div>
        </div>
      </div>
    </div>

    <!-- Section: Visual Overlay Preview -->
    <div class="card">
      <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 12px; color: #f1f5f9;">시각적 정렬 오버레이 (Visual Alignment Overlay)</h2>
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 16px;">
        반투명 안내선(파랑: 수직 가이드, 보라: 수평 가이드) 및 감지된 결함(빨강: 충돌, 노랑: 간격/터치 타깃 미달, 분홍: 오정렬)입니다.
      </p>
      <div class="canvas-container">
        ${svgOverlay}
      </div>
    </div>

    <!-- Section: Defect Breakdown Table -->
    <div class="card">
      <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 8px; color: #f1f5f9;">결함 상세 내역 (${summary.totalViolations}건)</h2>
      ${
        defectRows.length > 0
          ? `
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>분류</th>
                <th>위반 ID</th>
                <th>대상 요소</th>
                <th>측정 오차/값</th>
                <th>상세 설명</th>
                <th>수정 권장 사항</th>
              </tr>
            </thead>
            <tbody>
              ${defectRows.join("\n")}
            </tbody>
          </table>
        </div>
      `
          : `<div style="padding: 24px; text-align: center; color: #34d399; font-weight: 600;">✓ 감지된 그리드 및 정렬 위반 사항이 없습니다. 완벽한 레이아웃입니다.</div>`
      }
    </div>

    <!-- Section: Elements Inventory -->
    <div class="card">
      <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 8px; color: #f1f5f9;">검사 대상 요소 목록 (${result.elements.length}개)</h2>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Element ID</th>
              <th>Tag</th>
              <th>Role</th>
              <th>Interactive</th>
              <th>Coordinates</th>
              <th>Dimensions</th>
            </tr>
          </thead>
          <tbody>
            ${elementRows}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</body>
</html>`;
}
