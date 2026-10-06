// assess-ideas.ts — Parses, serializes project ideas & tasks, and drafts/updates
// executable plan documents (plans/<slug>.plan.md) from ideas and project recon.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { reconProject, type ProjectReconDetail } from "./project-recon.ts";
import { checkPlanDoc, compilePlanDocs } from "./plan-doc.ts";

export interface IdeaItem {
  id: string;
  title: string;
  status: "proposed" | "in-review" | "planned" | "completed" | "rejected";
  priority: "low" | "medium" | "high";
  tags: string[];
  targetFiles: string[];
  planSlug?: string;
  description: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskItem {
  id: string;
  text: string;
  done: boolean;
  priority: "P0" | "P1" | "P2" | "P3";
  tags: string[];
  files: string[];
  notes?: string;
  planSlug?: string;
}

export interface ProjectBoard {
  projectPath: string;
  title: string;
  lastUpdated: string;
  ideas: IdeaItem[];
  tasks: TaskItem[];
  rawMarkdown?: string;
}

export const DEFAULT_BOARD_TEMPLATE = `# Project Ideas & Tasks
<!-- Last updated: ${new Date().toISOString()} -->

## 💡 Ideas

### [idea-1] 로컬 웹 플래너 대시보드 및 실시간 연동
- Status: planned
- Priority: high
- Tags: planner, ui, ideas
- Target: scripts/planner.ts, scripts/loop/planner-web.ts
- Plan: plans/local-planner-board.plan.md
- Description: 각 프로젝트마다 해야할 일과 아이디어를 기록하고 계획서로 연계하는 로컬 웹 UI를 제공한다.

## 📋 Tasks

- [ ] [P1] 프로젝트 정찰 및 문맥 분석 모듈 (Files: scripts/loop/project-recon.ts)
- [ ] [P1] 마크다운 양방향 동기화 및 아이디어 계획서 변환 엔진 (Files: scripts/loop/assess-ideas.ts)
- [ ] [P1] 웹서버 HTTP 라우터 및 실시간 SSE 스트림 (Files: scripts/loop/planner-web.ts)
- [x] [P0] 하네스 아키텍처 및 요구사항 분석
`;

/**
 * Slugifies a title or string into a lowercase hyphen-separated slug.
 */
export function slugify(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-");
  return cleaned || `plan-${Date.now().toString(36)}`;
}

/**
 * Parses markdown into structured ProjectBoard.
 */
export function parseProjectBoard(mdText: string, projectPath = process.cwd()): ProjectBoard {
  const titleMatch = mdText.match(/^#\s+(.*?)$/m);
  const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : `${basename(projectPath)} Ideas & Tasks`;

  const ideas: IdeaItem[] = [];
  const tasks: TaskItem[] = [];

  const lines = mdText.split(/\r?\n/);
  let currentSection: "none" | "ideas" | "tasks" = "none";
  let currentIdea: Partial<IdeaItem> | null = null;
  let ideaDescriptionLines: string[] = [];

  function flushIdea() {
    if (currentIdea && currentIdea.title) {
      if (ideaDescriptionLines.length > 0) {
        const desc = ideaDescriptionLines.join("\n").trim();
        if (desc && !currentIdea.description) {
          currentIdea.description = desc;
        } else if (desc && currentIdea.description) {
          currentIdea.description = `${currentIdea.description}\n${desc}`;
        }
      }
      ideas.push({
        id: currentIdea.id || `idea-${ideas.length + 1}`,
        title: currentIdea.title || "새 아이디어",
        status: (currentIdea.status as any) || "proposed",
        priority: (currentIdea.priority as any) || "medium",
        tags: currentIdea.tags || [],
        targetFiles: currentIdea.targetFiles || [],
        planSlug: currentIdea.planSlug,
        description: currentIdea.description || "",
        createdAt: currentIdea.createdAt,
        updatedAt: currentIdea.updatedAt,
      });
    }
    currentIdea = null;
    ideaDescriptionLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();

    // Section detection
    if (/^##\s+(?:💡\s*)?(?:Ideas|아이디어)/i.test(trimmed)) {
      flushIdea();
      currentSection = "ideas";
      continue;
    } else if (/^##\s+(?:📋\s*)?(?:Tasks|할\s*일|해야할\s*일|Todos?)/i.test(trimmed)) {
      flushIdea();
      currentSection = "tasks";
      continue;
    } else if (/^##\s+/i.test(trimmed)) {
      flushIdea();
      currentSection = "none";
      continue;
    }

    if (currentSection === "ideas") {
      const ideaHead = trimmed.match(/^###\s+\[(.*?)\]\s*(.*)$/);
      if (ideaHead && ideaHead[1] && ideaHead[2]) {
        flushIdea();
        currentIdea = {
          id: ideaHead[1].trim(),
          title: ideaHead[2].trim(),
          tags: [],
          targetFiles: [],
        };
        continue;
      }

      if (currentIdea) {
        const fieldMatch = trimmed.match(/^-\s+([a-zA-Z0-9_\s]+):\s*(.*)$/);
        if (fieldMatch && fieldMatch[1] && fieldMatch[2]) {
          const key = fieldMatch[1].trim().toLowerCase();
          const val = fieldMatch[2].trim();
          if (key === "status") {
            const lower = val.toLowerCase();
            if (["proposed", "in-review", "planned", "completed", "rejected"].includes(lower)) {
              currentIdea.status = lower as any;
            }
          } else if (key === "priority") {
            const lower = val.toLowerCase();
            if (["low", "medium", "high"].includes(lower)) {
              currentIdea.priority = lower as any;
            }
          } else if (key === "tags" || key === "tag") {
            currentIdea.tags = val.split(/[,;\s]+/).filter(Boolean);
          } else if (key === "target" || key === "files" || key === "file") {
            currentIdea.targetFiles = val.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
          } else if (key === "plan" || key === "planslug") {
            currentIdea.planSlug = val.replace(/^plans\//, "").replace(/\.plan\.md$/, "");
          } else if (key === "description" || key === "desc") {
            currentIdea.description = val;
          }
        } else if (trimmed) {
          ideaDescriptionLines.push(trimmed);
        }
      }
    } else if (currentSection === "tasks") {
      // Task matching: - [ ] [P1] text (Files: ...) #tags
      const taskMatch = trimmed.match(/^-\s+\[([ xX])\]\s*(.*)$/);
      if (taskMatch && taskMatch[1] && taskMatch[2]) {
        const done = taskMatch[1].toLowerCase() === "x";
        let rest = taskMatch[2].trim();

        let priority: TaskItem["priority"] = "P2";
        const priMatch = rest.match(/^\[(P[0-3])\]\s*/i);
        if (priMatch && priMatch[0] && priMatch[1]) {
          priority = priMatch[1].toUpperCase() as any;
          rest = rest.slice(priMatch[0].length).trim();
        }

        let files: string[] = [];
        const filesMatch = rest.match(/\(Files?:\s*([^)]+)\)/i);
        if (filesMatch && filesMatch[0] && filesMatch[1]) {
          files = filesMatch[1].split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
          rest = rest.replace(filesMatch[0], "").trim();
        }

        const tags: string[] = [];
        const tagMatches = rest.match(/#([a-zA-Z0-9_-]+)/g);
        if (tagMatches) {
          for (const t of tagMatches) {
            tags.push(t.slice(1));
            rest = rest.replace(t, "").trim();
          }
        }

        const taskId = `task-${tasks.length + 1}`;
        tasks.push({
          id: taskId,
          text: rest,
          done,
          priority,
          tags,
          files,
        });
      }
    }
  }

  flushIdea();

  return {
    projectPath,
    title,
    lastUpdated: new Date().toISOString(),
    ideas,
    tasks,
    rawMarkdown: mdText,
  };
}

/**
 * Serializes ProjectBoard into markdown text.
 */
export function serializeProjectBoard(board: ProjectBoard): string {
  const parts: string[] = [];
  parts.push(`# ${board.title || "Project Ideas & Tasks"}`);
  parts.push(`<!-- Last updated: ${new Date().toISOString()} -->\n`);

  parts.push("## 💡 Ideas\n");
  if (board.ideas.length === 0) {
    parts.push("_등록된 아이디어가 없습니다._\n");
  } else {
    for (const idea of board.ideas) {
      parts.push(`### [${idea.id}] ${idea.title}`);
      parts.push(`- Status: ${idea.status || "proposed"}`);
      parts.push(`- Priority: ${idea.priority || "medium"}`);
      if (idea.tags && idea.tags.length > 0) {
        parts.push(`- Tags: ${idea.tags.join(", ")}`);
      }
      if (idea.targetFiles && idea.targetFiles.length > 0) {
        parts.push(`- Target: ${idea.targetFiles.join(", ")}`);
      }
      if (idea.planSlug) {
        parts.push(`- Plan: plans/${idea.planSlug.replace(/^plans\//, "").replace(/\.plan\.md$/, "")}.plan.md`);
      }
      if (idea.description) {
        parts.push(`- Description: ${idea.description}`);
      }
      parts.push("");
    }
  }

  parts.push("## 📋 Tasks\n");
  if (board.tasks.length === 0) {
    parts.push("_등록된 할 일이 없습니다._\n");
  } else {
    for (const task of board.tasks) {
      const check = task.done ? "[x]" : "[ ]";
      const pri = `[${task.priority || "P2"}]`;
      const filesPart = task.files && task.files.length > 0 ? ` (Files: ${task.files.join(", ")})` : "";
      const tagPart = task.tags && task.tags.length > 0 ? ` ${task.tags.map((t) => `#${t}`).join(" ")}` : "";
      parts.push(`- ${check} ${pri} ${task.text}${filesPart}${tagPart}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Resolves the primary board markdown file path for a project.
 */
export function getBoardFilePath(projectPath = process.cwd()): string {
  const target = resolve(projectPath);
  const candidates = [
    join(target, "IDEAS.md"),
    join(target, "ideas.md"),
    join(target, "TODO.md"),
    join(target, "todo.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(target, "IDEAS.md");
}

/**
 * Loads and parses the project board from disk.
 */
export function loadProjectBoard(projectPath = process.cwd()): ProjectBoard {
  const filePath = getBoardFilePath(projectPath);
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, "utf8");
      return parseProjectBoard(content, projectPath);
    } catch {}
  }
  // If not found, return default
  return parseProjectBoard(DEFAULT_BOARD_TEMPLATE, projectPath);
}

/**
 * Saves project board to disk as markdown.
 */
export function saveProjectBoard(projectPath = process.cwd(), board: ProjectBoard): string {
  const filePath = getBoardFilePath(projectPath);
  mkdirSync(resolve(projectPath), { recursive: true });
  const md = serializeProjectBoard(board);
  writeFileSync(filePath, md, "utf8");
  return filePath;
}

/**
 * Drafts an executable plan document (plans/<slug>.plan.md) from an idea and project context.
 */
export function generatePlanDraftFromIdea(
  projectPath: string,
  idea: IdeaItem,
  tasks?: TaskItem[]
): { slug: string; path: string; content: string } {
  const recon = reconProject(projectPath);
  const rawSlug = idea.planSlug ? idea.planSlug.replace(/^plans\//, "").replace(/\.plan\.md$/, "") : slugify(idea.id || idea.title);
  const slug = rawSlug.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "feature-plan";

  const plansDir = join(projectPath, "plans");
  mkdirSync(plansDir, { recursive: true });
  const planPath = join(plansDir, `${slug}.plan.md`);

  // Target files inference
  const candidateFiles = new Set<string>(idea.targetFiles || []);
  if (tasks && tasks.length > 0) {
    for (const t of tasks) {
      if (t.files) t.files.forEach((f) => candidateFiles.add(f));
    }
  }

  // Fallback candidate files from project reconnaissance
  if (candidateFiles.size === 0) {
    if (recon.structure.sourceFiles.length > 0 && recon.structure.sourceFiles[0]) {
      candidateFiles.add(recon.structure.sourceFiles[0]);
    } else {
      candidateFiles.add(`src/${slug}.ts`);
    }
    if (recon.structure.testFiles.length > 0 && recon.structure.testFiles[0]) {
      candidateFiles.add(recon.structure.testFiles[0]);
    } else {
      candidateFiles.add(`tests/${slug}.test.ts`);
    }
  }

  const filesArray = Array.from(candidateFiles);
  const primaryFiles = filesArray.slice(0, 3).join(", ");
  const secondaryFiles = filesArray.length > 3 ? filesArray.slice(3, 6).join(", ") : primaryFiles;

  // Test command inference
  let testCmd = "npm test";
  if (recon.packageJson?.scripts?.["test:fast"]) {
    testCmd = "npm run test:fast";
  } else if (recon.packageJson?.scripts?.test) {
    testCmd = `npm test -- ${slug}`;
  }

  const risk = idea.priority === "high" ? "high" : idea.priority === "low" ? "low" : "medium";
  const owner = "developer";

  const relatedTasks = tasks && tasks.length > 0 ? tasks : [];
  const step1Goal = relatedTasks[0]?.text || `${idea.title} 핵심 모듈 및 인터페이스 구현`;
  const step2Goal = relatedTasks[1]?.text || `${idea.title} 연동 및 검증 테스트 구축`;

  const planContent = `---
plan: ${slug}
status: draft
risk: ${risk}
owner: ${owner}
---
# Plan: ${idea.title}

## Intent
${idea.description || `${idea.title} 기능을 프로젝트 구조에 맞춰 안정적이고 검증 가능하게 구현한다.`}

## Non-goals
- 요구사항 범위를 벗어나는 임의의 아키텍처 개편
- 검증되지 않은 외부 무거운 의존성 추가

## Steps

### Step 1: ${slug}-core
- Goal: ${step1Goal}
- Files: ${primaryFiles}
- Acceptance: AC-1: 핵심 로직이 인터페이스 계약을 만족하고 정상 동작한다
- Tests: ${testCmd}
- Risk: ${risk}
- Complexity: low
- Parallel: no

### Step 2: ${slug}-verify
- Goal: ${step2Goal}
- Files: ${secondaryFiles}
- Acceptance: AC-1: 단위 및 통합 검증을 완료하고 코너 케이스를 방어한다
- Tests: ${testCmd}
- Risk: low
- Complexity: low
- Depends on: ${slug}-core

## Verification
Tier 1: \`npm run typecheck\` (정적 타입 점검)
Tier 2: \`${testCmd}\` (자동화 단위 테스트 스위트)
Tier 3: 런타임 실행 및 결과물 직접 확인

## Reviewer topology
builder=codex, reviewer=claude, challenge=on
`;

  writeFileSync(planPath, planContent, "utf8");

  // Update idea with plan link
  idea.planSlug = slug;
  if (idea.status === "proposed") {
    idea.status = "in-review";
  }

  return {
    slug,
    path: planPath,
    content: planContent,
  };
}

/**
 * Autonomous project ideas assessment & plan drafting routine.
 * Can be run during loop idle ticks or via CLI.
 */
export async function assessProjectIdeas(opts: {
  projectPath?: string;
  dryRun?: boolean;
}): Promise<{
  project: string;
  scannedIdeas: number;
  draftedPlans: Array<{ slug: string; title: string }>;
}> {
  const projectPath = resolve(opts.projectPath || process.cwd());
  const board = loadProjectBoard(projectPath);
  const draftedPlans: Array<{ slug: string; title: string }> = [];

  // Find proposed or un-planned ideas
  const targetIdeas = board.ideas.filter(
    (idea) => idea.status === "proposed" || !idea.planSlug
  );

  for (const idea of targetIdeas) {
    if (opts.dryRun) {
      draftedPlans.push({
        slug: slugify(idea.id || idea.title),
        title: idea.title,
      });
      continue;
    }

    const matchingTasks = board.tasks.filter(
      (t) =>
        t.tags.some((tag) => idea.tags.includes(tag)) ||
        (idea.targetFiles && t.files.some((f) => idea.targetFiles.includes(f)))
    );

    const result = generatePlanDraftFromIdea(projectPath, idea, matchingTasks);
    draftedPlans.push({ slug: result.slug, title: idea.title });
  }

  if (!opts.dryRun && draftedPlans.length > 0) {
    saveProjectBoard(projectPath, board);
  }

  return {
    project: basename(projectPath),
    scannedIdeas: board.ideas.length,
    draftedPlans,
  };
}
