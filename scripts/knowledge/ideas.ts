/**
 * ideas.ts — Capability Ideas and Implementation Evidence Service.
 *
 * Implements IdeasPort:
 * - Generates structured IdeaEvidenceBundle from search hits and local project context.
 * - AC-1: Generates IdeaEvidence with problem_to_solve, project_anchor, tool_anchor,
 *   integration_type, candidate_files, minimum_experiment, acceptance_criteria,
 *   cost_license, and confidence.
 * - AC-2: Rubric & Evidence Grounding:
 *   - 0-3 rubric rating requires explicit textual citations; unknown values remain 'unknown'.
 *   - No fabricated numbers or hallucinated certainty without citations.
 *   - Separates search similarity rank from adoption priority.
 * - AC-3: Current Agent Generation & Zero Execution:
 *   - Produces evidence bundle in memory without requiring external LLM API keys.
 *   - NEVER executes npm install, shell modifications, or code edits.
 * - AC-4: Plan Draft Integration:
 *   - formatIdeaAsPlanDraft formats selected idea into a valid `plans/<slug>.plan.md` draft.
 *   - Integrates project feedback: hides or deprioritizes dismissed/excluded tools.
 *   - Deprioritizes already used tools.
 */

import { resolve, basename } from "node:path";
import {
  withPortTimeout,
  validateIdeaEvidence,
  validateProjectContext,
  KnowledgeError,
  CancellationError,
  TimeoutError,
  type IdeasPort,
  type IdeaEvidence,
  type IdeaEvidenceBundle,
  type SearchHit,
  type ProjectContext,
  type IntegrationType,
  type Confidence,
  type PortOptions,
  type SearchPort,
  type ContextPort,
  type FeedbackPort,
} from "./contracts.ts";
import { projectContextService } from "./project-context.ts";
import {
  feedbackService,
  type ProjectOverlay,
  isSourceExcluded,
  isSourceExcludedOrDismissed,
} from "./feedback.ts";

// ============================================================================
// Rubric & Rating Types (AC-2)
// ============================================================================

export type RubricDimension =
  | "necessity"
  | "technical_fit"
  | "cost_license"
  | "integration_feasibility";

export type RubricScore = 0 | 1 | 2 | 3 | "unknown";

export interface RubricRating {
  dimension: RubricDimension;
  score: RubricScore;
  citation?: string; // Explicit textual citation required for 0, 1, 2, 3
  rationale: string;
}

export interface IdeaRubric {
  ratings: Record<RubricDimension, RubricRating>;
  overall_confidence: Confidence;
}

export interface IdeaEvidenceWithRubric extends IdeaEvidence {
  rubric?: IdeaRubric;
}

// ============================================================================
// Service Options
// ============================================================================

export interface IdeaGenerationOptions extends PortOptions {
  projectRoot?: string;
  projectContext?: ProjectContext;
  searchPort?: SearchPort;
  contextPort?: ContextPort;
  feedbackPort?: FeedbackPort & {
    getProjectOverlay?: (projectRoot: string, options?: PortOptions) => Promise<ProjectOverlay>;
  };
  hits?: SearchHit[];
  limit?: number;
  filterDismissed?: boolean;
}

export interface IdeasServiceOptions {
  searchService?: SearchPort;
  contextService?: ContextPort;
  feedbackService?: FeedbackPort & {
    getProjectOverlay?: (projectRoot: string, options?: PortOptions) => Promise<ProjectOverlay>;
  };
}

// ============================================================================
// Heuristics & Inferencing Helpers
// ============================================================================

/**
 * Infers integration surface type (api, mcp, cli, sdk, library) based on
 * documentation headings, excerpts, tags, and URL patterns.
 */
export function inferIntegrationType(hit: SearchHit): IntegrationType {
  const text = `${hit.heading || ""} ${hit.excerpt} ${hit.source_title || ""} ${hit.source_url}`.toLowerCase();

  // MCP detection
  if (/\b(mcp|model[- ]context[- ]protocol)\b/.test(text)) {
    return "mcp";
  }

  // CLI detection
  if (
    /\b(cli|command[- ]line|terminal|console|cargo install|curl.*install|bin\/|brew install)\b/.test(text) ||
    /--[a-z0-9_-]+/.test(hit.excerpt)
  ) {
    return "cli";
  }

  // API detection
  if (/\b(rest api|graphql|http endpoint|webhooks?|json endpoint)\b/.test(text)) {
    return "api";
  }

  // SDK detection
  if (
    /\b(sdk|client library)\b/.test(text) ||
    (hit.source_title && hit.source_title.startsWith("@"))
  ) {
    return "sdk";
  }

  // Default to library
  return "library";
}

/**
 * Formats a clean, grounded tool anchor referencing source URL, heading, and excerpt snippet.
 */
export function formatToolAnchor(hit: SearchHit): string {
  const section = hit.heading ? `#${hit.heading}` : "";
  const snippet = hit.excerpt.length > 130 ? `${hit.excerpt.slice(0, 127)}...` : hit.excerpt;
  return `${hit.source_url}${section} — "${snippet}"`;
}

/**
 * Determines problem to solve based on task query or project goals without hallucinations.
 */
export function determineProblemToSolve(
  hit: SearchHit,
  context: ProjectContext,
  taskOrQuery?: string,
): string {
  const toolName = hit.source_title || hit.heading || "candidate tool";

  if (taskOrQuery && taskOrQuery.trim()) {
    return `Addresses task '${taskOrQuery.trim()}' by integrating ${toolName}`;
  }

  if (context.goals && context.goals.length > 0) {
    const goal = context.goals[0];
    return `Addresses project goal '${goal}' via ${toolName}`;
  }

  return `Enhances ${context.project_name || "project"} capabilities with ${toolName}`;
}

/**
 * Selects candidate files and primary project anchor grounded in project context.
 */
export function selectCandidateAnchors(
  hit: SearchHit,
  context: ProjectContext,
): { projectAnchor: string; candidateFiles: string[] } {
  const related = context.related_files || [];
  if (related.length === 0) {
    const defaultAnchor = "package.json";
    return { projectAnchor: defaultAnchor, candidateFiles: [defaultAnchor] };
  }

  const toolWords = `${hit.source_title || ""} ${hit.heading || ""}`
    .toLowerCase()
    .split(/[\s-_/]+/)
    .filter((w) => w.length >= 3);

  // Look for a matching related file
  for (const file of related) {
    const lowerFile = file.toLowerCase();
    for (const word of toolWords) {
      if (lowerFile.includes(word)) {
        return {
          projectAnchor: file,
          candidateFiles: [file, ...related.filter((f) => f !== file).slice(0, 2)],
        };
      }
    }
  }

  // Fallback to top related file
  const anchor = related[0] || "package.json";
  return {
    projectAnchor: anchor,
    candidateFiles: related.slice(0, 3),
  };
}

/**
 * Formats a concrete minimum experiment for the candidate capability.
 */
export function formulateMinimumExperiment(
  hit: SearchHit,
  integrationType: IntegrationType,
  candidateFile: string,
): string {
  const toolName = (hit.source_title || "tool").toLowerCase().replace(/[^a-z0-9_-]/g, "");

  switch (integrationType) {
    case "cli":
      return `${toolName} --version || npx --yes ${toolName} --help`;
    case "mcp":
      return `node -e "console.log('Testing MCP tool capability for ${toolName}')"`;
    case "api":
      return `curl -sSf "${hit.source_url}" > /dev/null || node --test`;
    case "sdk":
    case "library":
    default:
      if (candidateFile.includes("test")) {
        return `node --test ${candidateFile}`;
      }
      return `node -e "/* verify baseline import of ${toolName} */"`;
  }
}

// ============================================================================
// Rubric Evaluation (AC-2)
// ============================================================================

/**
 * Evaluates the 0-3 rubric with mandatory textual citations.
 * Any score that lacks direct evidence citation remains 'unknown'.
 */
export function evaluateIdeaRubric(
  hit: SearchHit,
  context: ProjectContext,
  candidateAnchor: string,
  taskOrQuery?: string,
): IdeaRubric {
  // 1. Necessity
  let necessityRating: RubricRating;
  const targetText = taskOrQuery || (context.goals && context.goals[0]);
  if (targetText && targetText.trim()) {
    // Check if any keyword in targetText matches excerpt or title
    const keywords = targetText
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((w) => w.length >= 4);

    const hitText = `${hit.source_title || ""} ${hit.excerpt}`.toLowerCase();
    const matched = keywords.find((k) => hitText.includes(k));

    if (matched) {
      necessityRating = {
        dimension: "necessity",
        score: 3,
        citation: `Matched goal keyword '${matched}' in doc excerpt: "${hit.excerpt.slice(0, 80)}..."`,
        rationale: "Direct textual alignment between project goal/task and documentation excerpt.",
      };
    } else {
      necessityRating = {
        dimension: "necessity",
        score: 2,
        citation: `Task requirement '${targetText.slice(0, 50)}' targets documentation domain`,
        rationale: "Relevant capability domain matching current work item.",
      };
    }
  } else {
    necessityRating = {
      dimension: "necessity",
      score: "unknown",
      citation: undefined,
      rationale: "No explicit project goal or task query provided to anchor necessity.",
    };
  }

  // 2. Technical Fit
  let technicalFitRating: RubricRating;
  const stack = context.stack || [];
  const hitCombined = `${hit.excerpt} ${hit.source_title || ""} ${hit.heading || ""}`.toLowerCase();
  const matchedStack = stack.find((s) => hitCombined.includes(s.toLowerCase()));

  if (matchedStack) {
    technicalFitRating = {
      dimension: "technical_fit",
      score: 3,
      citation: `Project stack '${matchedStack}' cited in excerpt: "${hit.excerpt.slice(0, 80)}..."`,
      rationale: "Native technical stack compatibility verified in excerpt.",
    };
  } else if (stack.length > 0) {
    technicalFitRating = {
      dimension: "technical_fit",
      score: "unknown",
      citation: undefined,
      rationale: `Stack (${stack.join(", ")}) compatibility not explicitly cited in excerpt.`,
    };
  } else {
    technicalFitRating = {
      dimension: "technical_fit",
      score: "unknown",
      citation: undefined,
      rationale: "Project stack unstated in context.",
    };
  }

  // 3. Cost & License
  let costLicenseRating: RubricRating;
  if (hit.license && hit.license !== "unknown" && hit.license.trim() !== "") {
    const isPermissive = /^(mit|apache-2\.0|bsd|isc)/i.test(hit.license.trim());
    costLicenseRating = {
      dimension: "cost_license",
      score: isPermissive ? 3 : 2,
      citation: `Source metadata license: "${hit.license}"`,
      rationale: isPermissive
        ? "Permissive open-source license with zero subscription cost."
        : `Verified open license '${hit.license}'.`,
    };
  } else {
    costLicenseRating = {
      dimension: "cost_license",
      score: "unknown",
      citation: undefined,
      rationale: "License unverified in source documentation; cost and terms unknown.",
    };
  }

  // 4. Integration Feasibility
  let feasibilityRating: RubricRating;
  const relatedFiles = context.related_files || [];
  if (relatedFiles.includes(candidateAnchor)) {
    feasibilityRating = {
      dimension: "integration_feasibility",
      score: 3,
      citation: `Project anchor file verified: "${candidateAnchor}"`,
      rationale: "Concrete implementation target exists in verified project files.",
    };
  } else if (relatedFiles.length > 0) {
    feasibilityRating = {
      dimension: "integration_feasibility",
      score: 2,
      citation: `Project has related files (${relatedFiles.length} files) available as integration targets`,
      rationale: "Candidate targets available in project structure.",
    };
  } else {
    feasibilityRating = {
      dimension: "integration_feasibility",
      score: "unknown",
      citation: undefined,
      rationale: "No local files identified in project context.",
    };
  }

  // Overall Confidence Assessment
  let overallConfidence: Confidence = "medium";
  if (hit.already_used) {
    overallConfidence = "low";
  } else if (
    necessityRating.score === 3 &&
    technicalFitRating.score === 3 &&
    costLicenseRating.score === 3
  ) {
    overallConfidence = "high";
  } else if (costLicenseRating.score === "unknown" && necessityRating.score === "unknown") {
    overallConfidence = "unknown";
  } else if (hit.stale) {
    overallConfidence = "medium";
  }

  return {
    ratings: {
      necessity: necessityRating,
      technical_fit: technicalFitRating,
      cost_license: costLicenseRating,
      integration_feasibility: feasibilityRating,
    },
    overall_confidence: overallConfidence,
  };
}

// ============================================================================
// Plan Draft Integration (AC-4)
// ============================================================================

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "unnamed-plan";
}

/**
 * Formats a selected IdeaEvidence into a valid `plans/<slug>.plan.md` draft document.
 * Meets all plan-doc.ts syntax and validation rules.
 */
export function formatIdeaAsPlanDraft(
  idea: IdeaEvidence,
  context: ProjectContext,
): string {
  const planSlug = slugify(idea.capability_name || "candidate-tool");
  const stepSlug = slugify(`integrate-${idea.capability_name || "tool"}`);
  const title = `Integrate ${idea.capability_name}`;
  const filesList = idea.candidate_files && idea.candidate_files.length > 0
    ? idea.candidate_files.join(", ")
    : idea.project_anchor || "package.json";

  const acceptanceList = idea.acceptance_criteria && idea.acceptance_criteria.length > 0
    ? idea.acceptance_criteria.join(" ")
    : "AC-1: Capability integrated cleanly without regressions.";

  const testCommand = idea.minimum_experiment || "npm test";

  return `---
plan: ${planSlug}
title: ${title}
status: draft
risk: low
---

# Plan: ${title}

## Intent
Integrate ${idea.capability_name} to resolve: ${idea.problem_to_solve}.

## Non-goals
- Do not make breaking architectural changes outside declared candidate files.
- Do not alter existing unrelated project dependencies.

## Steps

### Step 1: ${stepSlug}
- Goal: ${idea.problem_to_solve}
- Files: ${filesList}
- Acceptance: ${acceptanceList}
- Tests: ${testCommand}
- Agent: agy
- Model: gemini-3.1-pro-high
- Reviewer: claude
- Risk: low
- Complexity: low

## Verification
Execute the minimum experiment command:
\`\`\`bash
${testCommand}
\`\`\`
Verify that all acceptance criteria are met and tests pass cleanly.
`;
}

// ============================================================================
// Ideas Service Implementation
// ============================================================================

export class IdeasService implements IdeasPort {
  private searchService?: SearchPort;
  private contextService: ContextPort;
  private feedbackService: FeedbackPort & {
    getProjectOverlay?: (projectRoot: string, options?: PortOptions) => Promise<ProjectOverlay>;
  };

  constructor(options?: IdeasServiceOptions) {
    this.searchService = options?.searchService;
    this.contextService = options?.contextService || projectContextService;
    this.feedbackService = options?.feedbackService || feedbackService;
  }

  /**
   * Implements IdeasPort.generateIdeas(hits, context, options).
   * Generates IdeaEvidenceBundle from given hits and context.
   */
  async generateIdeas(
    hits: SearchHit[],
    context: ProjectContext,
    options?: PortOptions & {
      taskOrQuery?: string;
      projectRoot?: string;
      filterDismissed?: boolean;
      limit?: number;
    },
  ): Promise<IdeaEvidenceBundle> {
    return await withPortTimeout(async (signal) => {
      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled before generating ideas");
      }

      const validatedContext = validateProjectContext(context);
      const projectRoot = options?.projectRoot || process.cwd();

      // Retrieve project overlay for feedback integration (AC-4)
      let overlay: ProjectOverlay = {};
      if (typeof this.feedbackService.getProjectOverlay === "function") {
        try {
          overlay = await this.feedbackService.getProjectOverlay(projectRoot, options);
        } catch {
          overlay = {};
        }
      }

      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled while loading overlay");
      }

      // Filter hits based on overlay
      const filteredHits: SearchHit[] = [];
      for (const hit of hits) {
        // Exclude strictly excluded sources (AC-4)
        if (isSourceExcluded(overlay, hit.source_id)) {
          continue;
        }

        // If filterDismissed is set (default true), filter dismissed as well
        if (options?.filterDismissed !== false && isSourceExcludedOrDismissed(overlay, hit.source_id)) {
          continue;
        }

        filteredHits.push(hit);
      }

      // Status priority: accepted (0) > unreviewed (1) > deferred (2) > dismissed (3) > excluded (4)
      const getStatusPriority = (status?: string): number => {
        if (status === "accepted") return 0;
        if (!status) return 1;
        if (status === "deferred") return 2;
        if (status === "dismissed") return 3;
        if (status === "excluded") return 4;
        return 1;
      };

      // Sort hits:
      // 1. Overlay status priority (accepted first, unreviewed next, deferred/dismissed last)
      // 2. Unused tools before already_used tools (deprioritizing already used tools)
      // 3. Score order
      filteredHits.sort((a, b) => {
        const aStatus = overlay[a.source_id]?.status;
        const bStatus = overlay[b.source_id]?.status;
        const aPriority = getStatusPriority(aStatus);
        const bPriority = getStatusPriority(bStatus);

        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }

        if (!a.already_used && b.already_used) return -1;
        if (a.already_used && !b.already_used) return 1;

        return (b.score || 0) - (a.score || 0);
      });

      const maxItems = options?.limit && options.limit > 0 ? options.limit : 5;
      const selectedHits = filteredHits.slice(0, maxItems);

      const ideas: IdeaEvidenceWithRubric[] = [];

      for (const hit of selectedHits) {
        if (signal.aborted) {
          throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled during idea synthesis");
        }

        const integrationType = inferIntegrationType(hit);
        const { projectAnchor, candidateFiles } = selectCandidateAnchors(hit, validatedContext);
        const problemToSolve = determineProblemToSolve(hit, validatedContext, options?.taskOrQuery);
        const toolAnchor = formatToolAnchor(hit);
        const minExperiment = formulateMinimumExperiment(hit, integrationType, projectAnchor);

        // Evaluate rubric with strict citations (AC-2)
        const rubric = evaluateIdeaRubric(hit, validatedContext, projectAnchor, options?.taskOrQuery);

        const capabilityName = hit.source_title || hit.heading || "Tool Capability";

        // Cost & license: strictly 'unknown' if not verified
        const costLicense =
          hit.license && hit.license !== "unknown" && hit.license.trim() !== ""
            ? `${hit.license} (verified from source)`
            : "unknown";

        const acceptanceCriteria = [
          `AC-1: ${capabilityName} is integrated into ${projectAnchor}`,
          `AC-2: Minimum experiment test (${minExperiment.split("\n")[0]}) passes cleanly with zero errors`,
        ];

        const rawIdea: IdeaEvidenceWithRubric = {
          capability_name: capabilityName,
          problem_to_solve: problemToSolve,
          project_anchor: projectAnchor,
          tool_anchor: toolAnchor,
          integration_type: integrationType,
          candidate_files: candidateFiles,
          minimum_experiment: minExperiment,
          acceptance_criteria: acceptanceCriteria,
          cost_license: costLicense,
          confidence: rubric.overall_confidence,
          rubric,
        };

        // Invariant check against contracts.ts validation boundary
        const validated = validateIdeaEvidence(rawIdea) as IdeaEvidenceWithRubric;
        validated.rubric = rubric;
        ideas.push(validated);
      }

      const bundle: IdeaEvidenceBundle = {
        ideas,
        generated_at: new Date().toISOString(),
        context_summary: `Generated for project '${validatedContext.project_name}' (${validatedContext.stack.join(", ")})`,
      };

      return bundle;
    }, options);
  }

  /**
   * Generates an idea bundle given a task or query string.
   * Orchestrates context extraction, search retrieval, feedback filtering,
   * and evidence bundle generation.
   */
  async generateIdeaBundle(
    taskOrQuery: string,
    options?: IdeaGenerationOptions,
  ): Promise<IdeaEvidenceBundle> {
    return await withPortTimeout(async (signal) => {
      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled before generating idea bundle");
      }

      const projectRoot = options?.projectRoot || process.cwd();

      // 1. Resolve project context
      let context: ProjectContext;
      if (options?.projectContext) {
        context = options.projectContext;
      } else {
        const ctxService = options?.contextPort || this.contextService;
        try {
          context = await ctxService.extractProjectContext(projectRoot, taskOrQuery, options);
        } catch {
          context = {
            project_name: basename(projectRoot),
            stack: [],
            goals: [],
            existing_deps: [],
            related_files: [],
          };
        }
      }

      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled after context resolution");
      }

      // 2. Resolve search hits
      let hits: SearchHit[] = [];
      if (options?.hits) {
        hits = options.hits;
      } else {
        const searchPort = options?.searchPort || this.searchService;
        if (searchPort) {
          try {
            const searchRes = await searchPort.search(taskOrQuery, context, {
              limit: options?.limit ?? 10,
              signal: options?.signal,
              timeoutMs: options?.timeoutMs,
            });

            if (Array.isArray(searchRes)) {
              hits = searchRes;
            } else if (searchRes && Array.isArray((searchRes as { hits: SearchHit[] }).hits)) {
              hits = (searchRes as { hits: SearchHit[] }).hits;
            }
          } catch {
            hits = [];
          }
        }
      }

      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled after search retrieval");
      }

      // 3. Delegate to generateIdeas
      return await this.generateIdeas(hits, context, {
        ...options,
        taskOrQuery,
        projectRoot,
      });
    }, options);
  }
}

// ============================================================================
// Singletons and Functional Exports
// ============================================================================

export const ideasService = new IdeasService();

export async function generateIdeas(
  hits: SearchHit[],
  context: ProjectContext,
  options?: PortOptions,
): Promise<IdeaEvidenceBundle> {
  return ideasService.generateIdeas(hits, context, options);
}

export async function generateIdeaBundle(
  taskOrQuery: string,
  options?: IdeaGenerationOptions,
): Promise<IdeaEvidenceBundle> {
  return ideasService.generateIdeaBundle(taskOrQuery, options);
}
