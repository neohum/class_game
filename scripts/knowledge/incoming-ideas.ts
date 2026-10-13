/**
 * incoming-ideas.ts — Idea Bank (i-bank) integration and project plans inspector.
 *
 * Checks for:
 * 1. Newly arrived or pending plans in `<projectRoot>/plans/*.plan.md`
 * 2. Incoming, analyzed, planned, or exported ideas in the Idea Bank SQLite database (`idea-bank.db`)
 * 3. Cross-platform path matching (Windows, macOS, Linux)
 * 4. On-demand import of plan documents from Idea Bank database into project's `plans/` directory
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

export interface IncomingPlanItem {
  file: string; // relative to projectRoot, e.g. "plans/2026-10-08-마일스톤-앱-만들기-b391.plan.md"
  slug: string;
  title: string;
  status: string; // "draft", "proposed", "approved", "done", etc.
  risk?: string;
  source_idea?: string;
  created_at?: string;
  mtime: string;
  is_new: boolean;
}

export interface IdeaBankItem {
  id: string;
  title: string;
  project: string | null;
  status: "proposed" | "analyzed" | "planned" | "done" | "in-progress" | "rejected" | string;
  priority?: string | null;
  plan_slug?: string | null;
  exported_to?: string | null;
  created_at: string;
  updated_at: string;
  has_plan_file: boolean;
  local_plan_file?: string;
}

export interface IncomingIdeasReport {
  project_name: string;
  project_root: string;
  idea_bank_connected: boolean;
  idea_bank_db_path?: string;
  plans: IncomingPlanItem[];
  pending_ideas: IdeaBankItem[]; // ideas with status proposed, analyzed, planned
  exported_ideas: IdeaBankItem[]; // ideas with plans exported or completed
  unassigned_ideas: IdeaBankItem[]; // ideas with no project assigned
  summary: {
    total_plans: number;
    new_plans: number;
    pending_ideas: number;
    exported_ideas: number;
    unassigned_ideas: number;
  };
}

export interface CheckIncomingIdeasOptions {
  project?: string;
  dbPath?: string;
  allPlans?: boolean;
}

/**
 * Cross-platform basename extractor that handles both / and \
 */
export function getCrossPlatformBasename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : "";
}

/**
 * Finds the local Idea Bank SQLite database path.
 */
export function findIdeaBankDbPath(customPath?: string): string | null {
  if (customPath && existsSync(customPath)) {
    return customPath;
  }
  if (process.env.IDEA_BANK_DB && existsSync(process.env.IDEA_BANK_DB)) {
    return process.env.IDEA_BANK_DB;
  }

  const home = homedir();

  // 1. Windows: %LOCALAPPDATA%\idea-bank\idea-bank.db
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    const p = join(localAppData, "idea-bank", "idea-bank.db");
    if (existsSync(p)) return p;
  }

  // 2. Standard XDG / macOS: ~/.local/share/idea-bank/idea-bank.db
  const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  const pXdg = join(xdgData, "idea-bank", "idea-bank.db");
  if (existsSync(pXdg)) return pXdg;

  // 3. macOS Application Support: ~/Library/Application Support/idea-bank/idea-bank.db
  const pMac = join(home, "Library", "Application Support", "idea-bank", "idea-bank.db");
  if (existsSync(pMac)) return pMac;

  // 4. Works folder fallback: ~/works/i-bank/data/idea-bank.db or similar
  const pWorks = join(home, "works", "i-bank", "data", "idea-bank.db");
  if (existsSync(pWorks)) return pWorks;

  return null;
}

/**
 * Parses a .plan.md file into an IncomingPlanItem
 */
export function parsePlanFile(projectRoot: string, filename: string): IncomingPlanItem | null {
  const fullPath = join(projectRoot, "plans", filename);
  if (!existsSync(fullPath)) return null;

  try {
    const content = readFileSync(fullPath, "utf8");
    const stat = statSync(fullPath);

    let slug = filename.replace(/\.plan\.md$/, "");
    let title = slug;
    let status = "draft";
    let risk: string | undefined;
    let source_idea: string | undefined;
    let created: string | undefined;

    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch && fmMatch[1]) {
      const lines = fmMatch[1].split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        const kv = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
        if (kv && kv[1] && kv[2]) {
          const key = kv[1].toLowerCase();
          const val = kv[2].replace(/^["']|["']$/g, "").trim();
          if (key === "slug") slug = val;
          else if (key === "title") title = val;
          else if (key === "status") status = val;
          else if (key === "risk") risk = val;
          else if (key === "source_idea") source_idea = val;
          else if (key === "created") created = val;
        }
      }
    }

    if (title === slug) {
      // Try to find first markdown header
      const headerMatch = content.match(/^#\s+(.+)$/m);
      if (headerMatch && headerMatch[1]) {
        title = headerMatch[1].trim();
      }
    }

    // Determine if it is newly arrived or pending
    const statusLower = status.toLowerCase();
    const daysSinceMod = (Date.now() - new Date(stat.mtime).getTime()) / (1000 * 60 * 60 * 24);
    const isRecent = daysSinceMod <= 14;
    const isExplicitDraft = statusLower === "draft" || statusLower === "proposed" || statusLower === "new";
    const isFromIdeaBank = Boolean(source_idea);
    const isNotDone = statusLower !== "done" && statusLower !== "completed" && statusLower !== "cancelled";

    // New if:
    // 1) explicitly linked to an Idea Bank source idea and not completed
    // 2) explicit draft/proposed/new
    // 3) modified recently (within 14 days) and not completed
    const isNew = isNotDone && (isFromIdeaBank || isExplicitDraft || isRecent);

    return {
      file: `plans/${filename}`,
      slug,
      title,
      status,
      risk,
      source_idea,
      created_at: created,
      mtime: stat.mtime.toISOString(),
      is_new: isNew,
    };
  } catch {
    return null;
  }
}

/**
 * Scans `<projectRoot>/plans/*.plan.md` files.
 */
export function scanProjectPlans(projectRoot: string): IncomingPlanItem[] {
  const plansDir = join(projectRoot, "plans");
  if (!existsSync(plansDir)) return [];

  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith(".plan.md"))
      .sort();

    const items: IncomingPlanItem[] = [];
    for (const f of files) {
      const parsed = parsePlanFile(projectRoot, f);
      if (parsed) items.push(parsed);
    }

    // Sort: new/pending plans first, then by mtime descending
    return items.sort((a, b) => {
      if (a.is_new !== b.is_new) return a.is_new ? -1 : 1;
      return a.mtime > b.mtime ? -1 : a.mtime < b.mtime ? 1 : 0;
    });
  } catch {
    return [];
  }
}

/**
 * Queries Idea Bank database for ideas related to the project.
 */
export function queryIdeaBank(
  projectRoot: string,
  projectName: string,
  dbPathOverride?: string,
  existingPlans: IncomingPlanItem[] = [],
): {
  connected: boolean;
  dbPath?: string;
  pendingIdeas: IdeaBankItem[];
  exportedIdeas: IdeaBankItem[];
  unassignedIdeas: IdeaBankItem[];
} {
  const dbPath = findIdeaBankDbPath(dbPathOverride);
  if (!dbPath) {
    return {
      connected: false,
      pendingIdeas: [],
      exportedIdeas: [],
      unassignedIdeas: [],
    };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    try {
      db = new DatabaseSync(dbPath);
    } catch {
      return {
        connected: false,
        dbPath,
        pendingIdeas: [],
        exportedIdeas: [],
        unassignedIdeas: [],
      };
    }
  }

  try {
    // Check if table 'ideas' exists
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ideas'")
      .get() as { name: string } | undefined;

    if (!tableExists) {
      db.close();
      return { connected: false, dbPath, pendingIdeas: [], exportedIdeas: [], unassignedIdeas: [] };
    }

    // Check projects table for path or canonical name alias
    let projectAliases = [projectName];
    const projectsTableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .get() as { name: string } | undefined;

    if (projectsTableExists) {
      const allProjects = db.prepare("SELECT name, path FROM projects WHERE deleted_at IS NULL").all() as Array<{
        name: string;
        path: string | null;
      }>;

      for (const p of allProjects) {
        if (!p.name) continue;
        const pNameLower = p.name.toLowerCase();
        const targetLower = projectName.toLowerCase();

        if (pNameLower === targetLower) {
          projectAliases.push(p.name);
        } else if (p.path) {
          const basePath = getCrossPlatformBasename(p.path).toLowerCase();
          if (basePath === targetLower) {
            projectAliases.push(p.name);
          }
        }
      }
    }
    projectAliases = Array.from(new Set(projectAliases));

    // Query ideas for this project
    const placeholders = projectAliases.map(() => "?").join(", ");
    const ideaQuery = `
      SELECT id, project, title, status, priority, plan_slug, exported_to, created_at, updated_at
      FROM ideas
      WHERE deleted_at IS NULL
        AND (
          project IN (${placeholders})
          OR exported_to LIKE ?
        )
      ORDER BY updated_at DESC
    `;

    const args = [...projectAliases, `%${projectName}%`];
    const rawIdeas = db.prepare(ideaQuery).all(...args) as Array<{
      id: string;
      project: string | null;
      title: string;
      status: string;
      priority: string | null;
      plan_slug: string | null;
      exported_to: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const plansDir = join(projectRoot, "plans");
    const localPlanFiles = existsSync(plansDir) ? readdirSync(plansDir) : [];

    const pendingIdeas: IdeaBankItem[] = [];
    const exportedIdeas: IdeaBankItem[] = [];

    for (const row of rawIdeas) {
      // Check if plan file exists in local plans/ directory or matches existingPlans
      let hasPlan = false;
      let localPlanFile: string | undefined;

      // 1. Match via existingPlans (source_idea or slug)
      const matchedPlan = existingPlans.find(
        (p) =>
          p.source_idea === row.id ||
          p.slug === row.plan_slug ||
          p.slug === row.id ||
          p.file.includes(row.id),
      );

      if (matchedPlan) {
        hasPlan = true;
        localPlanFile = matchedPlan.file;
      } else {
        // 2. Direct filename candidate match
        const candidates = [
          row.plan_slug ? `${row.plan_slug}.plan.md` : null,
          `${row.id}.plan.md`,
          row.exported_to ? getCrossPlatformBasename(row.exported_to) : null,
        ].filter(Boolean) as string[];

        for (const cand of candidates) {
          if (localPlanFiles.includes(cand)) {
            hasPlan = true;
            localPlanFile = `plans/${cand}`;
            break;
          }
        }
      }

      const item: IdeaBankItem = {
        id: row.id,
        title: row.title,
        project: row.project,
        status: row.status,
        priority: row.priority,
        plan_slug: row.plan_slug,
        exported_to: row.exported_to,
        created_at: row.created_at,
        updated_at: row.updated_at,
        has_plan_file: hasPlan,
        local_plan_file: localPlanFile,
      };

      const statusLower = (row.status || "").toLowerCase();
      if (statusLower === "proposed" || statusLower === "analyzed" || statusLower === "planned") {
        pendingIdeas.push(item);
      } else {
        exportedIdeas.push(item);
      }
    }

    // Query recent unassigned ideas (project IS NULL or empty)
    const unassignedQuery = `
      SELECT id, project, title, status, priority, plan_slug, exported_to, created_at, updated_at
      FROM ideas
      WHERE deleted_at IS NULL
        AND (project IS NULL OR project = '')
        AND status IN ('proposed', 'analyzed', 'planned')
      ORDER BY created_at DESC
      LIMIT 5
    `;
    const rawUnassigned = db.prepare(unassignedQuery).all() as Array<{
      id: string;
      project: string | null;
      title: string;
      status: string;
      priority: string | null;
      plan_slug: string | null;
      exported_to: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const unassignedIdeas: IdeaBankItem[] = rawUnassigned.map((row) => ({
      id: row.id,
      title: row.title,
      project: null,
      status: row.status,
      priority: row.priority,
      plan_slug: row.plan_slug,
      exported_to: row.exported_to,
      created_at: row.created_at,
      updated_at: row.updated_at,
      has_plan_file: false,
    }));

    db.close();

    return {
      connected: true,
      dbPath,
      pendingIdeas,
      exportedIdeas,
      unassignedIdeas,
    };
  } catch {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    return {
      connected: false,
      dbPath,
      pendingIdeas: [],
      exportedIdeas: [],
      unassignedIdeas: [],
    };
  }
}

/**
 * Imports a plan draft stored in the Idea Bank database directly into the project's plans/ directory.
 */
export function importPlanFromIdeaBank(
  projectRoot: string,
  planSlugOrIdeaId: string,
  dbPathOverride?: string,
): { success: boolean; file?: string; title?: string; error?: string } {
  const dbPath = findIdeaBankDbPath(dbPathOverride);
  if (!dbPath) {
    return { success: false, error: "Idea Bank 데이터베이스를 찾을 수 없습니다." };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return { success: false, error: "Idea Bank 데이터베이스 열기에 실패했습니다." };
  }

  try {
    const row = db
      .prepare(
        "SELECT slug, idea_id, markdown FROM plans WHERE slug = ? OR idea_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(planSlugOrIdeaId, planSlugOrIdeaId) as
      | { slug: string; idea_id: string; markdown: string }
      | undefined;

    if (!row || !row.markdown) {
      db.close();
      return { success: false, error: `Idea Bank에서 '${planSlugOrIdeaId}'에 대한 계획서 내용을 찾을 수 없습니다.` };
    }

    const plansDir = join(projectRoot, "plans");
    if (!existsSync(plansDir)) {
      mkdirSync(plansDir, { recursive: true });
    }

    const filename = `${row.slug}.plan.md`;
    const targetFile = join(plansDir, filename);

    writeFileSync(targetFile, row.markdown, "utf8");
    db.close();

    return {
      success: true,
      file: `plans/${filename}`,
      title: row.slug,
    };
  } catch (err: any) {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    return { success: false, error: err.message };
  }
}

/**
 * Sends desktop notification on macOS via osascript (fail-open).
 */
export function notifyDesktop(title: string, subtitle: string, message: string): void {
  try {
    if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} subtitle ${JSON.stringify(subtitle)}`;
      const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
      child.unref();
    }
  } catch {
    // Fail-open
  }
}

export interface AutoImportResult {
  imported: Array<{
    id: string;
    slug: string;
    file: string;
    title: string;
  }>;
  count: number;
  dbPath?: string;
  error?: string;
}

/**
 * Automatically imports all pending plans for the target project from Idea Bank DB into <projectRoot>/plans/.
 */
export function autoImportPendingPlans(
  projectRoot: string,
  options: { dbPath?: string; quiet?: boolean; project?: string } = {},
): AutoImportResult {
  const dbPath = findIdeaBankDbPath(options.dbPath);
  if (!dbPath) {
    return { imported: [], count: 0, error: "Idea Bank DB를 찾을 수 없습니다." };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e: any) {
      return { imported: [], count: 0, error: `DB 열기 실패: ${e.message}` };
    }
  }

  const imported: Array<{ id: string; slug: string; file: string; title: string }> = [];

  try {
    const root = resolve(projectRoot);
    const projectName = options.project || getCrossPlatformBasename(root);
    let projectAliases = [projectName];

    const projectsTableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
      .get() as { name: string } | undefined;

    if (projectsTableExists) {
      const allProjects = db.prepare("SELECT name, path FROM projects WHERE deleted_at IS NULL").all() as Array<{
        name: string;
        path: string | null;
      }>;

      for (const p of allProjects) {
        if (!p.name) continue;
        const pNameLower = p.name.toLowerCase();
        const targetLower = projectName.toLowerCase();
        if (pNameLower === targetLower) {
          projectAliases.push(p.name);
        } else if (p.path) {
          const basePath = getCrossPlatformBasename(p.path).toLowerCase();
          if (basePath === targetLower) {
            projectAliases.push(p.name);
          }
        }
      }
    }
    projectAliases = Array.from(new Set(projectAliases));

    const placeholders = projectAliases.map(() => "?").join(", ");
    const query = `
      SELECT p.slug, p.idea_id, p.markdown, i.id, i.title, i.project, i.status, i.exported_to
      FROM plans p
      JOIN ideas i ON (p.slug = i.plan_slug OR p.idea_id = i.id OR p.slug = i.id)
      WHERE i.deleted_at IS NULL
        AND (i.project IN (${placeholders}) OR i.exported_to LIKE ?)
      ORDER BY p.updated_at DESC
    `;
    const args = [...projectAliases, `%${projectName}%`];
    const rows = db.prepare(query).all(...args) as Array<{
      slug: string;
      idea_id: string;
      markdown: string;
      id: string;
      title: string;
      project: string | null;
      status: string;
      exported_to: string | null;
    }>;

    const plansDir = join(root, "plans");
    if (rows.length > 0 && !existsSync(plansDir)) {
      mkdirSync(plansDir, { recursive: true });
    }

    const localFiles = existsSync(plansDir) ? new Set(readdirSync(plansDir)) : new Set<string>();

    for (const row of rows) {
      if (!row.markdown) continue;
      const slug = row.slug || row.idea_id || row.id;
      const filename = slug.endsWith(".plan.md") ? slug : `${slug}.plan.md`;
      const fullPath = join(plansDir, filename);

      if (!localFiles.has(filename) && !existsSync(fullPath)) {
        writeFileSync(fullPath, row.markdown, "utf8");
        localFiles.add(filename);

        try {
          db.prepare("UPDATE ideas SET status = 'done', exported_to = ? WHERE id = ?").run(fullPath, row.id);
        } catch {
          // Read-only fallback is fine
        }

        notifyDesktop("Idea Bank -> Harness", projectName, `새 플랜 생성: ${filename}`);

        imported.push({
          id: row.id,
          slug,
          file: `plans/${filename}`,
          title: row.title || slug,
        });

        if (!options.quiet) {
          console.log(`\x1b[32m[Idea Bank]\x1b[0m 새 플랜 파일 생성 완료: \x1b[1mplans/${filename}\x1b[0m (${row.title || slug})`);
        }
      }
    }

    db.close();
    return {
      imported,
      count: imported.length,
      dbPath,
    };
  } catch (err: any) {
    if (db) {
      try { db.close(); } catch {}
    }
    return { imported, count: imported.length, dbPath, error: err.message };
  }
}

/**
 * Live watcher for Idea Bank changes. Automatically creates plan files in plans/ when detected.
 */
export async function watchIdeaBank(
  projectRoot: string,
  options: { dbPath?: string; intervalMs?: number; signal?: AbortSignal; project?: string } = {},
): Promise<void> {
  const root = resolve(projectRoot);
  const projectName = options.project || getCrossPlatformBasename(root);
  const dbPath = findIdeaBankDbPath(options.dbPath);
  const intervalMs = options.intervalMs || 5000;

  console.log(`\x1b[1m\x1b[36m================================================================================\x1b[0m`);
  console.log(`\x1b[1m\x1b[33m👀 [Idea Bank Watcher] '${projectName}' 프로젝트 감시 시작\x1b[0m`);
  console.log(`   데이터베이스: \x1b[90m${dbPath || "검색 중..."}\x1b[0m`);
  console.log(`   감시 주기: ${intervalMs / 1000}초 | 종료: Ctrl+C`);
  console.log(`\x1b[1m\x1b[36m================================================================================\x1b[0m\n`);

  // Initial sync run
  const initial = autoImportPendingPlans(root, { dbPath: options.dbPath, quiet: false, project: options.project });
  if (initial.count > 0) {
    console.log(`\x1b[32m✓ 초기 동기화 완료: ${initial.count}건의 새 플랜 생성\x1b[0m\n`);
  } else {
    console.log(`\x1b[90m✓ 현재 대기 중인 새 플랜 없음. 실시간 감시 대기 중...\x1b[0m\n`);
  }

  let lastMtime = 0;
  if (dbPath && existsSync(dbPath)) {
    try { lastMtime = statSync(dbPath).mtimeMs; } catch {}
  }

  return new Promise((resolvePromise) => {
    const timer = setInterval(() => {
      if (options.signal?.aborted) {
        clearInterval(timer);
        resolvePromise();
        return;
      }

      try {
        const curDbPath = findIdeaBankDbPath(options.dbPath);
        if (curDbPath && existsSync(curDbPath)) {
          const mtime = statSync(curDbPath).mtimeMs;
          if (mtime !== lastMtime) {
            lastMtime = mtime;
            const res = autoImportPendingPlans(root, { dbPath: curDbPath, quiet: false, project: options.project });
            if (res.count > 0) {
              console.log(`\x1b[32m[${new Date().toLocaleTimeString()}] ✓ ${res.count}건의 새 플랜 파일 생성 완료!\x1b[0m\n`);
            }
          }
        }
      } catch {
        // fail-open
      }
    }, intervalMs);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        clearInterval(timer);
        resolvePromise();
      });
    }
  });
}

/**
 * Checks incoming ideas and plans for the project.
 */
export function checkIncomingIdeas(
  projectRoot: string,
  options: CheckIncomingIdeasOptions = {},
): IncomingIdeasReport {
  let root = resolve(projectRoot);
  let projectName = options.project || getCrossPlatformBasename(root);

  // Smart directory resolution if project is specified
  if (options.project) {
    if (existsSync(options.project)) {
      root = resolve(options.project);
      projectName = getCrossPlatformBasename(root);
    } else {
      const sibling = join(resolve(projectRoot, ".."), options.project);
      if (existsSync(sibling)) {
        root = sibling;
        projectName = options.project;
      }
    }
  }

  // 1. Scan plans in project plans/ directory
  const allPlans = scanProjectPlans(root);
  const plans = options.allPlans ? allPlans : allPlans;

  // 2. Query Idea Bank DB
  const ideaBank = queryIdeaBank(root, projectName, options.dbPath, allPlans);

  const newPlans = plans.filter((p) => p.is_new);

  return {
    project_name: projectName,
    project_root: root,
    idea_bank_connected: ideaBank.connected,
    idea_bank_db_path: ideaBank.dbPath,
    plans,
    pending_ideas: ideaBank.pendingIdeas,
    exported_ideas: ideaBank.exportedIdeas,
    unassigned_ideas: ideaBank.unassignedIdeas,
    summary: {
      total_plans: plans.length,
      new_plans: newPlans.length,
      pending_ideas: ideaBank.pendingIdeas.length,
      exported_ideas: ideaBank.exportedIdeas.length,
      unassigned_ideas: ideaBank.unassignedIdeas.length,
    },
  };
}

/**
 * Formats a user-friendly Korean report for terminal output.
 */
export function formatIncomingIdeasReport(report: IncomingIdeasReport): string {
  const lines: string[] = [];

  lines.push(`\x1b[1m\x1b[36m================================================================================\x1b[0m`);
  lines.push(`\x1b[1m💡 [${report.project_name}] 새로 들어온 아이디어 & 계획서 현황\x1b[0m`);
  lines.push(`\x1b[1m\x1b[36m================================================================================\x1b[0m\n`);

  // 1. Local plans in plans/ folder
  lines.push(`\x1b[1m\x1b[33m📂 로컬 계획서 (plans/ 폴더):\x1b[0m 총 ${report.summary.total_plans}개 계획서 (대기/신규: ${report.summary.new_plans}개)`);

  if (report.plans.length === 0) {
    lines.push(`  \x1b[90m(아직 작성되거나 수신된 plans/*.plan.md 파일이 없습니다)\x1b[0m\n`);
  } else {
    // Show new/pending plans first, up to 10
    const displayedPlans = report.plans.slice(0, 10);
    for (const p of displayedPlans) {
      const badge = p.is_new
        ? `\x1b[32m[신규 대기]\x1b[0m`
        : `\x1b[90m[완료/보관]\x1b[0m`;
      const dateStr = p.created_at ? p.created_at.slice(0, 10) : p.mtime.slice(0, 10);
      lines.push(`  • ${badge} \x1b[1m${p.title}\x1b[0m (\x1b[34m${p.file}\x1b[0m)`);
      const details = [
        `상태: ${p.status}`,
        p.risk ? `위험도: ${p.risk}` : null,
        `생성/수정: ${dateStr}`,
        p.source_idea ? `Idea Bank 출처: ${p.source_idea}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      lines.push(`    - ${details}`);
    }
    if (report.plans.length > 10) {
      lines.push(`  \x1b[90m... 외 ${report.plans.length - 10}개의 계획서 생략\x1b[0m`);
    }
    lines.push("");
  }

  // 2. Idea Bank DB connection and ideas
  if (report.idea_bank_connected) {
    lines.push(`\x1b[1m\x1b[33m🏦 Idea Bank 앱 연동 (i-bank):\x1b[0m \x1b[32m연결됨\x1b[0m \x1b[90m(${report.idea_bank_db_path})\x1b[0m`);

    if (report.pending_ideas.length === 0 && report.exported_ideas.length === 0) {
      lines.push(`  \x1b[90m(Idea Bank에 이 프로젝트용으로 등록된 아이디어가 없습니다)\x1b[0m`);
    } else {
      if (report.pending_ideas.length > 0) {
        lines.push(`  \x1b[1m\x1b[35m[대기/신규 아이디어 (${report.pending_ideas.length}건)]\x1b[0m`);
        for (const idea of report.pending_ideas) {
          const statusTag =
            idea.status === "planned"
              ? `\x1b[32m[계획서 준비]\x1b[0m`
              : idea.status === "analyzed"
              ? `\x1b[34m[분석 완료]\x1b[0m`
              : `\x1b[33m[신규 제안]\x1b[0m`;
          lines.push(`  • ${statusTag} \x1b[1m${idea.title}\x1b[0m`);
          const info = [
            `상태: ${idea.status}`,
            idea.plan_slug ? `계획서 슬러그: ${idea.plan_slug}` : null,
            `등록일: ${idea.created_at.slice(0, 10)}`,
          ]
            .filter(Boolean)
            .join(" | ");
          lines.push(`    - ${info}`);
        }
      }

      if (report.exported_ideas.length > 0) {
        lines.push(`  \x1b[90m[계획서 생성/완료된 아이디어 (${report.exported_ideas.length}건)]\x1b[0m`);
        for (const idea of report.exported_ideas.slice(0, 5)) {
          const target = idea.has_plan_file
            ? `\x1b[32m(${idea.local_plan_file} 에 저장됨)\x1b[0m`
            : idea.exported_to
            ? `\x1b[90m(${idea.exported_to})\x1b[0m`
            : "";
          lines.push(`  • \x1b[90m[완료]\x1b[0m ${idea.title} ${target}`);
        }
        if (report.exported_ideas.length > 5) {
          lines.push(`    \x1b[90m... 외 ${report.exported_ideas.length - 5}건\x1b[0m`);
        }
      }
    }
    lines.push("");
  } else {
    lines.push(`\x1b[1m\x1b[33m🏦 Idea Bank 앱 연동 (i-bank):\x1b[0m \x1b[90m미연결 (idea-bank.db를 찾을 수 없어 로컬 plans/ 폴더만 확인했습니다)\x1b[0m\n`);
  }

  // 3. Unassigned ideas from Idea Bank
  if (report.unassigned_ideas.length > 0) {
    lines.push(`\x1b[1m\x1b[33m🌐 Idea Bank 미분류 신규 아이디어 (${report.unassigned_ideas.length}건):\x1b[0m`);
    for (const idea of report.unassigned_ideas) {
      lines.push(`  • \x1b[36m[미할당]\x1b[0m ${idea.title} \x1b[90m(${idea.created_at.slice(0, 10)})\x1b[0m`);
    }
    lines.push("");
  }

  // 4. Action Guide
  lines.push(`\x1b[36m--------------------------------------------------------------------------------\x1b[0m`);
  lines.push(`\x1b[1m👉 다음 작업 안내:\x1b[0m`);
  if (report.summary.new_plans > 0) {
    const firstPlan = report.plans.find((p) => p.is_new);
    const slug = firstPlan?.slug || "<slug>";
    lines.push(`  • \x1b[32m계획서 검증 및 웨이브 분석:\x1b[0m ca plan ${slug} check`);
    lines.push(`  • \x1b[32m작업 적합 에이전트 라우팅:\x1b[0m  ca route "${firstPlan?.title || "작업 내용"}"`);
  }
  if (report.pending_ideas.length > 0) {
    lines.push(`  • \x1b[35mIdea Bank 계획서 자동 생성:\x1b[0m ca ideas --sync`);
    lines.push(`  • \x1b[35mIdea Bank 실시간 감시/동기화:\x1b[0m ca ideas --watch`);
  }
  lines.push(`  • \x1b[32m지식 라이브러리 도구 발굴:\x1b[0m  ca ideas "<기능 또는 문제 설명>"`);
  lines.push(`  • \x1b[32m최신 외부 지식 동기화:\x1b[0m      ca sync`);
  lines.push(`\x1b[1m\x1b[36m================================================================================\x1b[0m`);

  return lines.join("\n");
}
