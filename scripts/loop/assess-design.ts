// assess-design.ts — queues one autonomous design-evolution round when idle.
//
// Sibling of assess-shortcomings.ts, but for the self-learning designer. When the
// backlog is empty AND DESIGN_EVOLVE is enabled, this enqueues a single card that
// tells a builder to run one round of the `design-evolve` skill: search trends →
// generate N variants → render+screenshot → critic+taste-judge score → tournament →
// distill the win/loss into designer-persona.md. The taste grows one round per idle.
//
// Opt-in by design: with DESIGN_EVOLVE unset this is a no-op, so existing projects
// behave exactly as before. Unlike a code card, a design round is an ARTIFACT (tokens
// + guide), not app code — the spec tells the builder not to touch app code, so the
// persona deploy gate has nothing to ship to production.
//
//   DESIGN_EVOLVE=1            enable autonomous design rounds
//   DESIGN_EVOLVE_VARIANTS     variants per round (default 4)
//   DESIGN_EVOLVE_MAX_PENDING  don't pile up: skip if this many design cards already
//                              open/in-progress (default 1)

import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";
import { log } from "./telemetry.ts";
import { realpathSync } from "node:fs";

const CARD_PREFIX = "design-evolve-round-";

/**
 * Decide the next round number from how many design rounds already exist (any status).
 * @param {Array<{card:string}>} all
 */
export function nextRoundNumber(all: Array<{ card?: unknown }>): number {
  let max = 0;
  for (const t of all) {
    if (typeof t.card === "string" && t.card.startsWith(CARD_PREFIX)) {
      const n = parseInt(t.card.slice(CARD_PREFIX.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

function roundSpec(round: number, variants: number): string {
  return [
    `Run ONE round (#${round}) of the design-evolve skill (.claude/skills/design-evolve/skill.md).`,
    `Generate ${variants} deliberately diverse token variants (vary ratio, design language, palette;`,
    `include at least one "safe best" and one "risky experiment").`,
    "For each variant: write tokens.json/tokens.css under _workspace/variants/<id>/, render via",
    "scripts/design-render.ts, screenshot the preview, then score with design-critic (contrast/math)",
    "and taste-judge (aesthetic). Rank with scripts/design-score.ts. If the top two are within 5",
    "points, request a human tap via notify-telegram; otherwise take the autonomous winner.",
    "Record each variant with scripts/design-feedback.ts and distill the result into the LEARNED",
    "block of designer-persona.md with scripts/design-persona-synthesize.ts.",
    "IMPORTANT: this is a DESIGN ARTIFACT round — write only design-system/ and _workspace/ outputs.",
    "Do NOT modify application source code. The result is tokens + guide for a human to adopt, not a deploy.",
  ].join(" ");
}

/**
 * Queue a design-evolution round if enabled and not already pending.
 * @param {object} backlog backlog backend (from getBacklog)
 * @returns {Promise<{queued:boolean, card?:string, reason?:string}>}
 */
/** The slice of backlog.ts this needs, so a caller can inject a double. */
interface BacklogLike {
  list(): Array<{ card?: unknown; status?: string }>;
  add(card: string, spec: string, source: string): Promise<unknown> | unknown;
}

export async function runDesignAssessment(backlog: BacklogLike) {
  if (!process.env.DESIGN_EVOLVE) return { queued: false, reason: "DESIGN_EVOLVE not set" };

  const variants = Number(process.env.DESIGN_EVOLVE_VARIANTS) || 4;
  const maxPending = Number(process.env.DESIGN_EVOLVE_MAX_PENDING) || 1;

  const all = backlog.list();
  const pending = all.filter(
    (t) => typeof t.card === "string" && t.card.startsWith(CARD_PREFIX) &&
      (t.status === "open" || t.status === "in-progress" || t.status === "claimed"),
  );
  if (pending.length >= maxPending) {
    return { queued: false, reason: `${pending.length} design round(s) already pending` };
  }

  const round = nextRoundNumber(all);
  const card = `${CARD_PREFIX}${round}`;
  await backlog.add(card, roundSpec(round, variants), "design");
  try {
    await log("iterate", { card, actor: "ralph", detail: `queued autonomous design-evolution round #${round}` });
  } catch {}
  console.log(`[DesignEvolve] queued ${card} (${variants} variants).`);
  return { queued: true, card };
}

// CLI entry point
// `import.meta.url` is realpath-resolved by the loader, while `process.argv[1]` is
// the raw path the caller typed. On a symlinked path (macOS /tmp -> /private/tmp,
// /var -> /private/var, linked checkouts) the two differ and a naive comparison
// makes this CLI silently no-op with exit 0. Compare both through realpath.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const b = await getBacklog();
  runDesignAssessment(b).then((r) => console.log(JSON.stringify(r))).catch(console.error);
}
