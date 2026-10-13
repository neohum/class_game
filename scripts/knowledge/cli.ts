#!/usr/bin/env node
/**
 * cli.ts — Unified CLI for the Harness Knowledge Library.
 *
 * Implements Step 14 / AC-5:
 * - Single entry point combining:
 *   - sources [add|update|disable|list|import-bookmarks]
 *   - sync [--force]
 *   - search <query> [--json]
 *   - ideas <taskOrQuery> [--plan-slug <slug>] [--json]
 *   - feedback <sourceId> <accepted|dismissed|deferred|excluded> [--reason <reason>]
 *   - status [--json]
 *   - doctor [--json]
 *   - producer [--dry-run]
 *   - schedule [plan|install|remove]
 * - Strictly uses array-based argument passing (execFile/spawnSync), never shell concatenation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { IntakeService, inferSourceKind, type ListSourcesFilter } from "./intake.ts";
import { createReader } from "./reader.ts";
import { SearchService } from "./search.ts";
import { generateIdeaBundle, formatIdeaAsPlanDraft } from "./ideas.ts";
import { checkIncomingIdeas, formatIncomingIdeasReport, autoImportPendingPlans, watchIdeaBank } from "./incoming-ideas.ts";
import { recordFeedback, type FeedbackStatus } from "./feedback.ts";
import { getLibraryStatus, formatLibraryStatusText } from "./status.ts";
import { checkRuntimeDoctor } from "./runtime.ts";
import { runProducerCycle, calculateRequiredDiskSpace } from "./producer.ts";
import { planTaskSchedule, installTaskSchedule, removeTaskSchedule } from "./schedule.ts";
import type { SourceKind, SourceProvenance, ProjectContext, SourceSpec } from "./contracts.ts";

export interface ParsedArgs {
  command?: string;
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  const command = positionals[0]?.toLowerCase();
  const subcommand = positionals[1]?.toLowerCase();

  return { command, subcommand, positionals, flags };
}

function resolveRegistryDir(explicitDir?: string | boolean): string {
  if (typeof explicitDir === "string" && explicitDir) {
    return resolve(explicitDir);
  }
  if (process.env.KNOWLEDGE_REGISTRY_DIR) {
    return resolve(process.env.KNOWLEDGE_REGISTRY_DIR);
  }
  // Default to repo root knowledge directory or cwd/knowledge
  const cwdKnowledge = resolve(process.cwd(), "knowledge");
  return cwdKnowledge;
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleSources(parsed: ParsedArgs): Promise<number> {
  const action = parsed.subcommand;
  const jsonMode = Boolean(parsed.flags.json);
  const registryDir = resolveRegistryDir(parsed.flags.registry);
  const intake = new IntakeService({ baseDir: registryDir });

  switch (action) {
    case "add": {
      const rawUrls = parsed.positionals.slice(2);
      const urls = rawUrls
        .flatMap((arg) => arg.split(","))
        .map((u) => u.trim())
        .filter(Boolean);

      if (urls.length === 0) {
        console.error("오류: 추가할 URL이 필요합니다. (usage: sources add <url1,url2,...> [--kind <kind>] [--tags <tags>] [--note <note>])");
        return 2;
      }

      const rawKind = parsed.flags.kind as string | undefined;
      const validKind: SourceKind | undefined =
        rawKind === "github-repo" || rawKind === "github-stars" || rawKind === "web"
          ? (rawKind as SourceKind)
          : rawKind === "repo"
            ? "github-repo"
            : rawKind === "stars"
              ? "github-stars"
              : undefined;

      const rawTags = parsed.flags.tags as string | undefined;
      const tags = rawTags ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const note = parsed.flags.note as string | undefined;
      const title = parsed.flags.title as string | undefined;
      const refreshHours = parsed.flags["refresh-hours"] ? Number(parsed.flags["refresh-hours"]) : undefined;

      if (urls.length === 1) {
        const url = urls[0]!;
        const kind: SourceKind = validKind || inferSourceKind(url);

        try {
          const spec = await intake.addSource({
            url,
            kind,
            tags,
            note,
            title,
            refresh_hours: refreshHours,
            provenance: "manual" as SourceProvenance,
          });

          if (jsonMode) {
            console.log(JSON.stringify(spec, null, 2));
          } else {
            console.log(`지식 소스 등록 완료:`);
            console.log(`- ID: ${spec.source_id}`);
            console.log(`- URL: ${spec.url}`);
            console.log(`- 분류: ${spec.kind}`);
            if (spec.tags.length) console.log(`- 태그: ${spec.tags.join(", ")}`);
            if (spec.note) console.log(`- 메모: ${spec.note}`);
            console.log(`- 갱신주기: ${spec.refresh_hours}시간`);
            console.log(`(저장 위치: ${join(intake.sourcesDir, `${spec.source_id}.json`)})`);
          }
          return 0;
        } catch (err: any) {
          console.error(`소스 등록 실패: ${err.message}`);
          return 1;
        }
      }

      // Batch registration for multiple URLs
      const successes: SourceSpec[] = [];
      const failures: Array<{ url: string; error: string }> = [];

      for (const u of urls) {
        const kind: SourceKind = validKind || inferSourceKind(u);
        try {
          const spec = await intake.addSource({
            url: u,
            kind,
            tags,
            note,
            title,
            refresh_hours: refreshHours,
            provenance: "manual" as SourceProvenance,
          });
          successes.push(spec);
        } catch (err: any) {
          failures.push({ url: u, error: err.message });
        }
      }

      if (jsonMode) {
        console.log(JSON.stringify({
          total: urls.length,
          succeeded: successes.length,
          failed: failures.length,
          sources: successes,
          errors: failures,
        }, null, 2));
      } else {
        console.log(`\n총 ${urls.length}개 지식 소스 일괄 등록 (성공: ${successes.length}개, 실패: ${failures.length}개)`);
        for (const s of successes) {
          console.log(`✓ [${s.kind}] ${s.url} (ID: ${s.source_id.slice(0, 8)})`);
        }
        for (const f of failures) {
          console.error(`✗ [실패] ${f.url}: ${f.error}`);
        }
        if (successes.length > 0) {
          console.log(`(저장 위치: ${intake.sourcesDir})`);
        }
      }

      return failures.length === 0 ? 0 : 1;
    }

    case "update": {
      const sourceId = parsed.positionals[2];
      if (!sourceId) {
        console.error("오류: source_id가 필요합니다. (usage: sources update <source_id> [--title <title>] [--tags <tags>] [--note <note>] [--enabled <true|false>])");
        return 2;
      }

      const patch: any = {};
      if (parsed.flags.title !== undefined) patch.title = String(parsed.flags.title);
      if (parsed.flags.note !== undefined) patch.note = String(parsed.flags.note);
      if (parsed.flags.tags !== undefined) {
        patch.tags = String(parsed.flags.tags).split(",").map((t) => t.trim()).filter(Boolean);
      }
      if (parsed.flags.enabled !== undefined) {
        patch.enabled = parsed.flags.enabled === true || parsed.flags.enabled === "true";
      }
      if (parsed.flags["refresh-hours"] !== undefined) {
        patch.refresh_hours = Number(parsed.flags["refresh-hours"]);
      }

      try {
        const updated = await intake.updateSource(sourceId, patch);
        if (jsonMode) {
          console.log(JSON.stringify(updated, null, 2));
        } else {
          console.log(`소스 업데이트 완료 (${sourceId}): enabled=${updated.enabled}, tags=[${updated.tags.join(", ")}]`);
        }
        return 0;
      } catch (err: any) {
        console.error(`소스 업데이트 실패: ${err.message}`);
        return 1;
      }
    }

    case "disable": {
      const sourceId = parsed.positionals[2];
      if (!sourceId) {
        console.error("오류: source_id가 필요합니다. (usage: sources disable <source_id>)");
        return 2;
      }
      try {
        const disabled = await intake.disableSource(sourceId);
        if (jsonMode) {
          console.log(JSON.stringify(disabled, null, 2));
        } else {
          console.log(`소스 비활성화 완료 (${sourceId}): enabled=false`);
        }
        return 0;
      } catch (err: any) {
        console.error(`소스 비활성화 실패: ${err.message}`);
        return 1;
      }
    }

    case "list": {
      const filter: ListSourcesFilter = {};
      if (parsed.flags.kind) filter.kind = parsed.flags.kind as SourceKind;
      if (parsed.flags.enabled !== undefined) {
        filter.enabled = parsed.flags.enabled === true || parsed.flags.enabled === "true";
      }
      if (parsed.flags.tag) filter.tag = String(parsed.flags.tag);

      try {
        const sources = await intake.listSources(filter);
        if (jsonMode) {
          console.log(JSON.stringify(sources, null, 2));
        } else {
          console.log(`총 ${sources.length}개 소스 등록됨:`);
          for (const s of sources) {
            const statusMark = s.enabled ? "[ON]" : "[OFF]";
            console.log(`${statusMark} [${s.kind}] ${s.title || s.url} (${s.source_id.slice(0, 12)}...)`);
            if (s.tags.length) console.log(`      태그: ${s.tags.join(", ")}`);
          }
        }
        return 0;
      } catch (err: any) {
        console.error(`소스 목록 조회 실패: ${err.message}`);
        return 1;
      }
    }

    case "import-bookmarks": {
      const htmlFile = parsed.positionals[2];
      if (!htmlFile) {
        console.error("오류: 북마크 HTML 파일 경로가 필요합니다. (usage: sources import-bookmarks <htmlFile> [--folder <folder>])");
        return 2;
      }
      const folderName = parsed.flags.folder ? String(parsed.flags.folder) : undefined;
      try {
        const content = existsSync(htmlFile) ? readFileSync(htmlFile, "utf8") : htmlFile;
        const result = await intake.importBookmarks(content, { folderName });
        if (jsonMode) {
          console.log(JSON.stringify({
            imported: result.imported,
            skipped: result.skipped,
            total_imported: result.imported.length,
          }, null, 2));
        } else {
          console.log(`북마크 가져오기 완료:`);
          console.log(`- 가져온 소스: ${result.imported.length}개`);
          console.log(`- 건너뜀/실패: ${result.skipped}개`);
        }
        return 0;
      } catch (err: any) {
        console.error(`북마크 가져오기 실패: ${err.message}`);
        return 1;
      }
    }

    case "import-chrome": {
      const folderName = (parsed.flags.folder as string) || undefined;
      const days = parsed.flags.days ? Number(parsed.flags.days) : (parsed.flags.recent ? Number(parsed.flags.recent) : undefined);
      const customPath = (parsed.flags.bookmarks as string) || (parsed.flags.path as string) || undefined;
      const listOnly = Boolean(parsed.flags.list);
      const rawTags = parsed.flags.tags as string | undefined;
      const tags = rawTags ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : [];

      if (listOnly) {
        try {
          const folders = intake.getChromeFolders(customPath);
          if (jsonMode) {
            console.log(JSON.stringify(folders, null, 2));
          } else {
            console.log(`\nChrome 북마크 폴더 목록 (${folders.length}개 발견):`);
            for (const f of folders) {
              console.log(`- ${f.path} (${f.count}개 링크)`);
            }
            console.log(`\n가져오기 예시: ca import chrome --folder "${folders[0]?.name || "도구들"}"`);
          }
          return 0;
        } catch (err: any) {
          console.error(`Chrome 북마크 조회 실패: ${err.message}`);
          return 1;
        }
      }

      try {
        if (!jsonMode) {
          console.log(`Chrome 북마크를 검색하여 지식 라이브러리로 가져오는 중...`);
        }
        const res = await intake.importChromeBookmarks({
          bookmarksPath: customPath,
          folderName,
          days,
          tags,
        });

        if (jsonMode) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`\n✓ Chrome 북마크 가져오기 완료!`);
          console.log(`- 파일: ${res.bookmarksPath}`);
          if (folderName) console.log(`- 대상 폴더: "${folderName}"`);
          if (days) console.log(`- 기간: 최근 ${days}일 이내 추가된 항목`);
          console.log(`- 검색된 링크: ${res.totalFound}개`);
          console.log(`- 신규 등록/갱신: ${res.imported.length}개 (건너뜀/실패: ${res.skipped}개)`);
          if (res.imported.length > 0) {
            console.log(`\n등록된 소스 미리보기:`);
            for (const s of res.imported.slice(0, 5)) {
              console.log(`  ✓ [${s.kind}] ${s.title || s.url}`);
            }
            if (res.imported.length > 5) {
              console.log(`  ... 외 ${res.imported.length - 5}개`);
            }
          }
        }
        return 0;
      } catch (err: any) {
        console.error(`Chrome 북마크 가져오기 실패: ${err.message}`);
        return 1;
      }
    }

    case "import-github": {
      const username = parsed.positionals[2];
      const mode = parsed.flags.repos ? "repos" : "stars";
      const limit = parsed.flags.limit ? Number(parsed.flags.limit) : 50;
      const rawTags = parsed.flags.tags as string | undefined;
      const tags = rawTags ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : [];

      try {
        if (!jsonMode) {
          console.log(`GitHub에서 ${mode === "stars" ? "스타 찍은 저장소" : "공개 저장소"} 목록을 가져오는 중...`);
        }
        const res = await intake.importGitHubRepos({
          username,
          mode,
          limit,
          tags,
        });

        if (jsonMode) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`\n✓ GitHub ${mode === "stars" ? "스타 저장소" : "저장소"} 가져오기 완료!`);
          console.log(`- 계정: ${res.user}`);
          console.log(`- 검색된 저장소: ${res.totalFound}개`);
          console.log(`- 신규 등록/갱신: ${res.imported.length}개 (건너뜀/실패: ${res.skipped}개)`);
          if (res.imported.length > 0) {
            console.log(`\n등록된 저장소 미리보기:`);
            for (const s of res.imported.slice(0, 5)) {
              console.log(`  ✓ ${s.title || s.url}`);
            }
            if (res.imported.length > 5) {
              console.log(`  ... 외 ${res.imported.length - 5}개`);
            }
          }
        }
        return 0;
      } catch (err: any) {
        console.error(`GitHub 가져오기 실패: ${err.message}`);
        return 1;
      }
    }

    default:
      console.error(`알 수 없는 sources 하위 명령: '${action || ""}' (사용 가능: add, update, disable, list, import-bookmarks, import-chrome, import-github)`);
      return 2;
  }
}

async function handleSync(parsed: ParsedArgs): Promise<number> {
  const force = Boolean(parsed.flags.force);
  const jsonMode = Boolean(parsed.flags.json);
  const reader = createReader();

  try {
    const res = await reader.syncLatest({ force });
    if (jsonMode) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      if ("skipped" in res) {
        console.log(`동기화 건너뜀: ${res.reason}`);
      } else {
        console.log(`동기화 성공 (Generation: ${res.generation}):`);
        console.log(`- 문서: ${res.manifest.document_count}개 / 청크: ${res.manifest.chunk_count}개`);
        console.log(`- 생성 시각: ${res.manifest.created_at}`);
      }
    }
    return 0;
  } catch (err: any) {
    console.error(`지식 스냅샷 동기화 실패: ${err.message}`);
    return 1;
  }
}

async function handleSearch(parsed: ParsedArgs): Promise<number> {
  const query = parsed.positionals.slice(1).join(" ").trim();
  if (!query) {
    console.error("오류: 검색어가 필요합니다. (usage: search <query> [--json] [--limit <n>] [--mode <all|fts|vec|lexical>])");
    return 2;
  }

  const jsonMode = Boolean(parsed.flags.json);
  const limit = parsed.flags.limit ? Number(parsed.flags.limit) : 10;
  const mode = (parsed.flags.mode as any) || "all";

  const reader = createReader();
  const searchService = new SearchService({ reader, defaultLimit: limit });

  try {
    const result = await searchService.search(query, { limit, mode });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`검색 결과 (${result.hits.length}건, 모드: ${result.mode}):\n`);
      if (result.hits.length === 0) {
        console.log("일치하는 검색 결과가 없습니다.");
      } else {
        for (let i = 0; i < result.hits.length; i++) {
          const h = result.hits[i]!;
          const score = h.score ? `(score: ${h.score.toFixed(3)})` : "";
          console.log(`[${i + 1}] ${h.source_title || h.source_url} ${score}`);
          console.log(`    URL: ${h.source_url}`);
          if (h.heading) {
            console.log(`    항목: ${h.heading}`);
          }
          if (h.excerpt) {
            const snippet = h.excerpt.replace(/\r?\n/g, " ").slice(0, 160);
            console.log(`    발췌: ${snippet}...`);
          }
          console.log("");
        }
      }
    }
    return 0;
  } catch (err: any) {
    if (err.message?.includes("no database connection") || err.code === "CATALOG_UNAVAILABLE") {
      console.log(`ℹ️  로컬에 동기화된 지식 카탈로그 스냅샷이 없습니다.`);
      console.log(`   'ca sync'를 실행하여 최신 지식을 동기화한 후 다시 검색해 보세요.\n`);
      return 0;
    }
    console.error(`검색 실패: ${err.message}`);
    return 1;
  }
}

async function handleIdeas(parsed: ParsedArgs): Promise<number> {
  const isSync = Boolean(parsed.flags.sync) || parsed.subcommand === "sync" || parsed.positionals[1] === "sync";
  const isWatch = Boolean(parsed.flags.watch) || parsed.subcommand === "watch" || parsed.positionals[1] === "watch";

  const projectRoot = (process.env.HARNESS_PROJECT_ROOT || process.cwd());

  if (isSync) {
    const res = autoImportPendingPlans(projectRoot, {
      dbPath: parsed.flags.db as string | undefined,
      project: parsed.flags.project as string | undefined,
      quiet: false,
    });
    if (parsed.flags.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    if (res.count === 0) {
      console.log("\nℹ️  동기화할 대기 계획서가 없습니다. (이미 모든 계획서가 plans/ 폴더에 존재하거나 준비된 계획서가 없습니다)");
    } else {
      console.log(`\n🎉 총 ${res.count}건의 계획서가 plans/ 폴더에 성공적으로 생성되었습니다.`);
    }
    return 0;
  }

  if (isWatch) {
    await watchIdeaBank(projectRoot, {
      dbPath: parsed.flags.db as string | undefined,
      project: parsed.flags.project as string | undefined,
    });
    return 0;
  }

  const taskOrQuery = parsed.positionals.slice(1).join(" ").trim();
  if (!taskOrQuery) {
    const report = checkIncomingIdeas(projectRoot, {
      project: parsed.flags.project as string | undefined,
      dbPath: parsed.flags.db as string | undefined,
      allPlans: Boolean(parsed.flags["all-plans"]),
    });

    if (parsed.flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    console.log(formatIncomingIdeasReport(report));
    return 0;
  }

  const jsonMode = Boolean(parsed.flags.json);
  const planSlug = parsed.flags["plan-slug"] as string | undefined;
  const limit = parsed.flags.limit ? Number(parsed.flags.limit) : 5;

  try {
    const bundle = await generateIdeaBundle(taskOrQuery, {
      projectRoot: process.cwd(),
      limit,
    });

    if (jsonMode) {
      console.log(JSON.stringify(bundle, null, 2));
      return 0;
    }

    if (planSlug) {
      if (bundle.ideas.length === 0) {
        console.error("추천된 아이디어가 없어 계획서 초안을 작성할 수 없습니다.");
        return 1;
      }
      const topIdea = bundle.ideas[0]!;
      const projectContext: ProjectContext = {
        project_name: basename(process.cwd()),
        stack: [],
        goals: [],
        existing_deps: [],
        related_files: [],
      };
      const draft = formatIdeaAsPlanDraft(topIdea, projectContext);

      const planDir = resolve(process.cwd(), "plans");
      const planFile = join(planDir, `${planSlug}.plan.md`);
      if (parsed.flags.write) {
        if (!existsSync(planDir)) mkdirSync(planDir, { recursive: true });
        writeFileSync(planFile, draft, "utf8");
        console.log(`계획서 초안이 작성되었습니다: ${planFile}`);
      } else {
        console.log(draft);
      }
      return 0;
    }

    console.log(`=== 지식 기반 기능 제안 (${bundle.ideas.length}건) ===\n`);
    for (let i = 0; i < bundle.ideas.length; i++) {
      const idea = bundle.ideas[i]!;
      console.log(`[제안 ${i + 1}] ${idea.tool_anchor} (연결 유형: ${idea.integration_type})`);
      console.log(`- 해결 문제: ${idea.problem_to_solve}`);
      console.log(`- 프로젝트 근거: ${idea.project_anchor}`);
      console.log(`- 후보 파일: ${idea.candidate_files.join(", ") || "신규 모듈"}`);
      console.log(`- 최소 실험: ${idea.minimum_experiment}`);
      console.log(`- 비용/라이선스: ${idea.cost_license}`);
      console.log(`- 확신도: ${idea.confidence}`);
      console.log("");
    }
    return 0;
  } catch (err: any) {
    if (err.message?.includes("no database connection") || err.code === "CATALOG_UNAVAILABLE") {
      console.log(`ℹ️  로컬에 동기화된 지식 카탈로그 스냅샷이 없습니다.`);
      console.log(`   'ca sync'를 실행하여 최신 지식을 동기화한 후 다시 시도해 주세요.\n`);
      return 0;
    }
    console.error(`아이디어 제안 생성 실패: ${err.message}`);
    return 1;
  }
}

async function handleFeedback(parsed: ParsedArgs): Promise<number> {
  const sourceId = parsed.positionals[1];
  const status = parsed.positionals[2] as FeedbackStatus | undefined;
  const validStatuses: FeedbackStatus[] = ["accepted", "dismissed", "deferred", "excluded"];

  if (!sourceId || !status || !validStatuses.includes(status)) {
    console.error(`오류: 올바른 feedback 매개변수가 필요합니다. (usage: feedback <sourceId> <accepted|dismissed|deferred|excluded> [--reason <reason>])`);
    return 2;
  }

  const reason = parsed.flags.reason ? String(parsed.flags.reason) : undefined;
  const jsonMode = Boolean(parsed.flags.json);

  try {
    await recordFeedback(process.cwd(), sourceId, status, reason);
    if (jsonMode) {
      console.log(JSON.stringify({ source_id: sourceId, status, reason }, null, 2));
    } else {
      console.log(`피드백 기록 완료 (${sourceId}): 상태=${status}${reason ? `, 사유='${reason}'` : ""}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`피드백 기록 실패: ${err.message}`);
    return 1;
  }
}

async function handleStatus(parsed: ParsedArgs): Promise<number> {
  const jsonMode = Boolean(parsed.flags.json);
  try {
    const status = await getLibraryStatus({ projectRoot: process.cwd() });
    if (jsonMode) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(formatLibraryStatusText(status));
    }
    return 0;
  } catch (err: any) {
    console.error(`상태 조회 실패: ${err.message}`);
    return 1;
  }
}

async function handleDoctor(parsed: ParsedArgs): Promise<number> {
  const jsonMode = Boolean(parsed.flags.json);
  try {
    const report = await checkRuntimeDoctor();
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("=== 지식 라이브러리 런타임 진단 (Doctor) ===");
      console.log(`- 전체 상태: ${report.ok ? "정상 (OK)" : "주의/점검 필요"}`);
      console.log(`- 지식 홈: ${report.knowledge_home}`);
      console.log(`- 플랫폼: ${report.platform} (${report.arch})`);
      console.log(`- Node.js: ${report.node_version} (${report.node_version_ok ? "호환" : "호환되지 않음"})`);
      console.log(`- 가속 지원: ${report.acceleration.backend} (가속 사용 가능: ${report.acceleration.available ? "예" : "아니오"})`);
      console.log(`- 임베딩 모델: ${report.model.installed ? "설치됨" : "미설치 (FTS 키워드 모드로 동작)"}`);
      console.log(`- 여유 디스크: ${(report.disk_space.free_bytes / 1024 / 1024 / 1024).toFixed(1)} GiB (충족: ${report.disk_space.ok ? "예" : "아니오"})`);
      if (report.actionable_instructions.length) {
        console.log("\n권장 조치 사항:");
        for (const inst of report.actionable_instructions) {
          console.log(`  * ${inst}`);
        }
      }
    }
    return report.ok ? 0 : 1;
  } catch (err: any) {
    console.error(`Doctor 진단 실패: ${err.message}`);
    return 1;
  }
}

async function handleProducer(parsed: ParsedArgs): Promise<number> {
  const dryRun = Boolean(parsed.flags["dry-run"]);
  const jsonMode = Boolean(parsed.flags.json);
  const allowDirty = Boolean(parsed.flags["allow-dirty"] || parsed.flags.local);
  const local = Boolean(parsed.flags.local);
  const maxJobs = parsed.flags["max-jobs"] ? Number(parsed.flags["max-jobs"]) : undefined;
  const repoDir = process.cwd();

  if (dryRun) {
    const doctor = await checkRuntimeDoctor();
    const diskBytes = calculateRequiredDiskSpace();
    const result = {
      dry_run: true,
      repo_dir: repoDir,
      doctor_ok: doctor.ok,
      required_disk_bytes: diskBytes,
      message: "Dry run completed without executing git pull or database modifications.",
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("=== 생산자 작업 Dry-Run 검사 ===");
      console.log(`- 대상 저장소: ${repoDir}`);
      console.log(`- 런타임 진단 통과: ${doctor.ok ? "예" : "아니오"}`);
      console.log(`- 예상 요구 공간: ${(diskBytes / 1024 / 1024 / 1024).toFixed(1)} GiB`);
      console.log(`- 상태: 이상 없음 (작업 실행 대기)`);
    }
    return 0;
  }

  try {
    const result = await runProducerCycle({
      repoDir,
      allowDirty,
      local,
      maxJobsPerCycle: maxJobs,
    });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`생산자 사이클 완료:`);
      console.log(`- 성공 여부: ${result.success}`);
      console.log(`- 커밋 SHA: ${result.commitSha}`);
      console.log(`- 큐 작업 처리: ${result.jobsCompleted}/${result.jobsProcessed}`);
      console.log(`- 스냅샷 발행: ${result.published ? "성공" : (result.skippedReason || "건너뜀")}`);
    }
    return result.success ? 0 : 1;
  } catch (err: any) {
    console.error(`생산자 사이클 실행 실패: ${err.message}`);
    return 1;
  }
}

async function handleSchedule(parsed: ParsedArgs): Promise<number> {
  const action = parsed.subcommand || "plan";
  const jsonMode = Boolean(parsed.flags.json);
  const taskName = (parsed.flags["task-name"] as string) || "HarnessKnowledgeProducer";

  switch (action) {
    case "plan": {
      const plan = planTaskSchedule({ taskName });
      if (jsonMode) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log(`=== Windows 작업 스케줄러 계획 (${plan.taskName}) ===`);
        console.log(`등록 명령어:\n${plan.command}\n`);
        console.log(`생성될 Task XML:\n${plan.xml}`);
      }
      return 0;
    }

    case "install": {
      try {
        const res = await installTaskSchedule({ taskName });
        if (jsonMode) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`스케줄 작업 등록 완료: ${res.taskName}`);
          if (res.output) console.log(res.output);
        }
        return 0;
      } catch (err: any) {
        console.error(`스케줄 작업 등록 실패: ${err.message}`);
        return 1;
      }
    }

    case "remove": {
      try {
        const res = await removeTaskSchedule(taskName);
        if (jsonMode) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`스케줄 작업 삭제 완료: ${res.taskName}`);
          if (res.output) console.log(res.output);
        }
        return 0;
      } catch (err: any) {
        console.error(`스케줄 작업 삭제 실패: ${err.message}`);
        return 1;
      }
    }

    default:
      console.error(`알 수 없는 schedule 하위 명령: '${action}' (사용 가능: plan, install, remove)`);
      return 2;
  }
}

function printUsage(): void {
  console.log(`create-agent-harness 지식 라이브러리 CLI

사용법:
  node scripts/knowledge/cli.ts <command> [args] [options]

명령어:
  sources add <url1,url2,...> [--kind <kind>] [--tags <tags>] [--note <note>]  새 Git/웹 URL 등록 (콤마 구분 다중 등록 지원)
  sources update <source_id> [--title <title>] [--tags <tags>]        기존 소스 정보 갱신
  sources disable <source_id>                                         소스 비활성화 (enabled=false)
  sources list [--json] [--kind <kind>] [--enabled <true|false>]      등록된 소스 목록 조회
  sources import-bookmarks <htmlFile> [--folder <folder>]             크롬 북마크 HTML 가져오기
  sync [--force] [--json]                                             최신 스냅샷 동기화
  search <query> [--json] [--limit <n>] [--mode <all|fts|vec>]        도구/라이브러리 검색
  ideas [taskOrQuery] [--plan-slug <slug>] [--json]                   신규 아이디어/계획서 확인 또는 기능 제안
  feedback <sourceId> <status> [--reason <reason>]                    도구 평가 기록 (accepted|dismissed|deferred|excluded)
  status [--json]                                                     지식 라이브러리 종합 상태 점검
  doctor [--json]                                                     런타임 의존성 및 환경 진단
  producer [--dry-run]                                                Windows 생산자 파이프라인 실행
  schedule [plan|install|remove]                                      Windows 작업 스케줄러 등록/관리
`);
}

// ============================================================================
// Main CLI Runner
// ============================================================================

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);

  if (!parsed.command || parsed.flags.help || parsed.flags.h) {
    printUsage();
    return 0;
  }

  switch (parsed.command) {
    case "sources":
      return handleSources(parsed);
    case "sync":
      return handleSync(parsed);
    case "search":
      return handleSearch(parsed);
    case "ideas":
      return handleIdeas(parsed);
    case "feedback":
      return handleFeedback(parsed);
    case "status":
      return handleStatus(parsed);
    case "doctor":
      return handleDoctor(parsed);
    case "producer":
      return handleProducer(parsed);
    case "schedule":
      return handleSchedule(parsed);
    default:
      console.error(`알 수 없는 명령어: '${parsed.command}'. 'cli.ts --help'로 도움말을 확인하세요.`);
      return 2;
  }
}

// Self-execution guard
if (process.argv[1]) {
  try {
    const invoked = resolve(process.argv[1]);
    const current = fileURLToPath(import.meta.url);
    if (invoked === current) {
      runCli().then((code) => {
        if (code !== 0) process.exit(code);
      }).catch((err) => {
        console.error(`치명적 오류: ${err.message}`);
        process.exit(1);
      });
    }
  } catch {
    // Non-fatal
  }
}
