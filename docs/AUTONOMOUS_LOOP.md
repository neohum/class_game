# AUTONOMOUS_LOOP.md — the always-on dev loop

This repo ships an **async, autonomous multi-agent dev loop**. It runs unattended on
an always-on Linux server while you (the human) are offline, and you supervise from
your phone over Telegram. You write intent in the morning; the agents turn it into
shipped, human-approved code through the day.

Design stance: **Linux-server-first, cross-platform-safe.** Scripts are plain Node
(`node:` builtins, no heavy deps) plus a `.sh`/`.ps1` pair for the health gate so the
same loop runs on the server and on your laptop.

## Lifecycle

```
   human writes spec.md (phone, morning)
              │
              ▼
   ┌──────────────────────┐
   │ lead: spec → cards    │   backlog.mjs add
   │ (SQLite backlog)      │
   └──────────┬───────────┘
              ▼
   ┌──────────────────────────────────────────────┐
   │ per card, 4 roles run:                       │
   │                                              │
   │  lead → explorer → builder → reviewer        │
   │  (plan)  (map)     (code)    (verify)        │
   │                                              │
   │  claim-task.mjs  (SQLite txn + git lock)     │
   │         │                                    │
   │         ▼                                    │
   │   iterate ──► health.sh + Playwright ──┐     │
   │     ▲         (gate, capped)           │     │
   │     └──── red: fix / escalate ─────────┘     │
   └──────────┬───────────────────────────────────┘
              │ green + reviewer sign-off
              ▼
        commit + push
              │
              ▼
   persona-approve.mjs  (LLM-as-judge, decides AS the owner per persona.md)
              │
      ┌───────┴────────────────────────────────┐
      │ approve                                 │ escalate / reject
      │ (confident, low/med blast, non-sensitive)│ (uncertain / high-blast / sensitive)
      ▼                                         ▼
 deploy-railway.mjs (auto)              deploy HELD (commit stays pushed)
      │                                         │
      ▼                                         ▼
 capture-screenshot ─► upload-wasabi ─► notify-telegram.mjs
      │ (informational)                         │ (approval request, ✅ button)
      ▼                                         ▼
 ┌──────────────┐                     ┌───────────────────────┐
 │ human (opt): │                     │ human on phone:       │
 │  ↩ 반려 롤백  │                     │  ✅ 승인 → deploy      │
 └──────┬───────┘                     │  ↩ 반려 → 재개발       │
        │                             └──────────┬────────────┘
        └──────────► telegram-listener.mjs ◄─────┘
                            │
              approve ──► deploy-railway.mjs
              reject  ──► git revert + deploy (rollback & re-queue)
```

### Self-Assessment Loop
When the backlog is empty, the loop autonomously spawns `assess-shortcomings.mjs` which reads `.claude/persona.md` and audits the codebase and test results to discover and queue new tasks. It runs as a **structured devil's advocate** — it argues against the current direction (security exposure, missing regression tests, scope creep already shipped, compounding debt) rather than only confirming health, and writes an acceptance criterion into every card it queues.

### Validate before building (keep sense-making ahead of building)
When AI makes building nearly free, the bottleneck moves from *can we build it* to *should we, and is it specified well enough to build once*. Two roles guard that, used by the **lead** before a card is queued:
- **validator** (`.claude/agents/validator.md`, `scripts/loop/validate-card.mjs`) — recalls prior cross-project knowledge from the hub (reuse instead of relearn), sharpens vague intent into a testable change, and fixes the **acceptance criterion before** the builder starts. Verdict: go / sharpen / drop.
- **adversary** (`.claude/agents/adversary.md`) — a structured devil's advocate for high-stakes, irreversible, or scope-creep-smelling work, and for any "we have traction" claim. It steelmans the opposite, hunts disconfirming evidence, and returns holds / revise / pivot-stop. A false "go" costs far more than a false "stop", so it weights toward stopping when uncertain.

These embody the playbook discipline: validate before building, structured devil's advocate at every stage, and a measurement framework chosen up front instead of metrics cherry-picked after.

### Cross-project recall — the central hub, read as well as written
Every project writes its lessons to the shared hub (`knowledge.mjs` → `hub.mjs` → `POST /api/knowledge/ingest`). The new half is **reading it back**: `node scripts/loop/knowledge.mjs recall "<topic>"` searches the hub across **all** projects (local fallback when the hub read endpoint isn't live yet). With `HUB_RECALL=1`, the loop auto-prepends recalled prior knowledge to each build so the builder reuses known solutions and sidesteps known traps. See [`KNOWLEDGE_HUB.md`](KNOWLEDGE_HUB.md) for the one read endpoint the hub app needs to expose to light this up across projects.

Tuning knobs for the above:

```
HUB_RECALL=1     prepend cross-project recall to each build (off by default)
VALIDATE_CARDS   reserved for an in-loop validation gate (the lead validates at queue time today)
HUB_URL / HUB_TOKEN / KB_PROJECT   hub connection (template defaults baked in; override in prod)
```

### Self-Learning Designer (opt-in: `DESIGN_EVOLVE=1`)
When the backlog is empty and `DESIGN_EVOLVE` is set, the loop also runs `assess-design.mjs`, which queues **one design-evolution round** (`design-evolve-round-N`). A builder then executes the `design-evolve` skill: it searches trends + your reference library, generates N deliberately diverse token variants, renders each to a preview and screenshots it, scores them with `design-critic` (contrast/math, an accessibility hard floor) + `taste-judge` (aesthetic, reading the growing `designer-persona.md`), runs a tournament, and **distills the win/loss into the LEARNED block of `designer-persona.md`** — so the taste grows one round per idle. This reuses the deploy-gate persona's textual-gradient-descent mechanism (`design-persona-synthesize.mjs` mirrors `persona-synthesize.mjs`) and the same Telegram tap path: a human is asked **only** when the top two variants are within 5 points (a maximally-informative active-learning sample). A design round is a **design artifact** (tokens + guide), not app code — its spec forbids touching application source, so the deploy gate has nothing to ship to production; a human adopts the tokens deliberately. The persona accumulates centrally in `PERSONA_HOME` (`~/.claude/persona/designer-persona.md`), so taste carries across projects. Knobs: `DESIGN_EVOLVE_VARIANTS` (default 4), `DESIGN_EVOLVE_MAX_PENDING` (default 1, prevents pile-up). See [`../.claude/skills/design-evolve/references/evolution-loop.md`](../.claude/skills/design-evolve/references/evolution-loop.md).

### Building the persona (the learning loop)
The persona that stands in for you is not just the static `persona.md` — it **learns from your decisions** so it needs your taps less and less. The mechanism is a closed feedback loop:

```
persona-approve  ─ predicts ─►  persona-feedback.jsonl  ◄─ labels ─  your ✅/❌ tap
        ▲                              │                              (telegram-listener)
        │                              ▼
   persona.md  ◄─ rewrites ─  persona-synthesize     persona-calibrate ─► calibrated p̂ + τ*
   (learned block)            (disagreements)        (Platt scaling)
```

- **The taps are the training signal.** Because the gate only escalates when it is *uncertain* (p≈0.5), every tap you make is a maximally-informative active-learning sample — `persona-feedback.mjs` pairs it with what the persona predicted.
- **Cold-start is solved by history.** On startup `persona-bootstrap.mjs` mines git (survived commits → approve, `git revert`-ed → reject) to seed the dataset with hundreds of free labels — no taps required.
- **Confidence is calibrated, the threshold is derived.** During idle, `persona-calibrate.mjs` refits Platt scaling so the model's confidence becomes a real P(you approve); set `PERSONA_COST_ASK`/`PERSONA_COST_BAD` and the auto-approve bar becomes `τ* = 1 − C_ask/C_bad` instead of a guessed `0.8`.
- **The persona rewrites itself.** Once enough disagreements accrue (`PERSONA_SYNTH_MIN`, default 3), `persona-synthesize.mjs` edits **only** the managed `LEARNED RULES` block in `persona.md` — your hand-written prose is never touched — prioritizing the costly false-approves.

Tuning knobs: `PERSONA_BOOTSTRAP=off`, `PERSONA_BOOTSTRAP_LIMIT`, `PERSONA_COST_ASK`, `PERSONA_COST_BAD`, `PERSONA_SYNTH_MIN`. The whole dataset lives in `.harness/persona-feedback.jsonl`; calibration params in `.harness/persona-calibration.json`.

## Scripts in `scripts/loop/`

| Script                  | Role in the loop                                                         |
| ----------------------- | ------------------------------------------------------------------------ |
| `ralph-loop.mjs`        | **main driver** — the always-on loop: pull → claim → run roles → gate → persona gate → deploy or hold |
| `persona-approve.mjs`   | **persona deploy gate** — decides *as the owner* (per `persona.md`) whether to auto-deploy or hold for a human tap; conservative floor escalates sensitive/uncertain changes |
| `persona-feedback.mjs`  | **labeled dataset** — pairs each persona verdict with your actual tap (`.harness/persona-feedback.jsonl`); the active-learning signal the persona learns from |
| `persona-bootstrap.mjs` | **behavioral cloning** — mines git history (survived=approve, reverted=reject) to seed the dataset with zero new taps |
| `persona-calibrate.mjs` | **calibration** — Platt-scales the model's confidence into a real P(approve) and derives the deploy threshold from cost (`tau*=1-C_ask/C_bad`) |
| `persona-synthesize.mjs`| **persona self-improvement** — rewrites the learned-rules block in `persona.md` from the cases where it disagreed with you |
| `assess-shortcomings.mjs`| **self-assessment** — audits codebase against `.claude/persona.md` and queues shortcomings |
| `assess-design.mjs`     | **self-learning designer** (opt-in `DESIGN_EVOLVE=1`) — queues one `design-evolve` round per idle; the round distills taste into `designer-persona.md` |
| `hub.mjs`               | **central hub client** — `pushToHub` (write) + `searchHub` (read, all projects); the bidirectional cross-project memory |
| `knowledge.mjs`         | local knowledge store + `record` (write-through to hub) + `recall` (hub-first, local fallback) |
| `validate-card.mjs`     | **validate-before-building** — recalls prior knowledge for a card and emits the acceptance-criteria contract the validator fills in |
| `backlog.mjs`           | SQLite (JSON fallback) task backlog; the **lead** adds cards here         |
| `claim-task.mjs`        | race-free two-phase claim: SQLite txn + `current_tasks/<card>.lock`       |
| `health.sh` / `health.ps1` | the health gate — typecheck/lint/test; run between every iteration     |
| `telemetry.mjs`         | append-only action trail (SQLite + `current.md` human-readable fallback)  |
| `cooldown.mjs`          | per-agent rate-limit tracking: records when each agent (claude/codex/antigravity/gemini) resets so the loop can route around limits and bring an agent back automatically |
| `data-contract.mjs`     | pre-write guard; blocks DB-row shapes / storage paths that violate `AGENTS.md` |
| `capture-screenshot.mjs`| Playwright screenshot of the running app for the mobile approval          |
| `upload-wasabi.mjs`     | uploads the screenshot to Wasabi (S3-compatible) and returns a URL        |
| `notify-telegram.mjs`   | sends the screenshot + summary to your phone with rollback/logs buttons  |
| `telegram-listener.mjs` | listens for your tap; reject triggers git revert + deploy rollback        |
| `deploy-railway.mjs`    | non-interactive production deploy via the Railway CLI (auto-triggered)    |
| `cross-build-wails.sh`  | cross-compiles the Wails desktop build (cross-platform output)            |

## Required environment

Set these on the server (and locally for testing). The loop reads them from the
environment — never commit them.

| Var                  | Used by                                  | What it is                                            |
| -------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | `notify-telegram.mjs`, `telegram-listener.mjs` | bot token for the approval channel              |
| `TELEGRAM_CHAT_ID`   | `notify-telegram.mjs`, `telegram-listener.mjs` | the chat to message (your DM with the bot)      |
| `WASABI_ACCESS_KEY`  | `upload-wasabi.mjs`                      | Wasabi access key                                     |
| `WASABI_SECRET_KEY`  | `upload-wasabi.mjs`                      | Wasabi secret key                                     |
| `WASABI_BUCKET`      | `upload-wasabi.mjs`                      | bucket for approval screenshots                       |
| `WASABI_REGION`      | `upload-wasabi.mjs`                      | Wasabi region / endpoint                              |
| `RAILWAY_TOKEN`      | `deploy-railway.mjs`                     | **project/environment-scoped** token — never an account key |

## Rate-limit handling (zero-touch agent rotation)

The loop never stops just because one provider hits a subscription/rate limit. When
an agent CLI returns a limit (`limit|quota|rate|subscription|429|too many requests`):

1. **Save first.** The working tree is committed as `wip:<card>` so no progress is
   lost — the limited iteration is never "burned."
2. **Record the reset time.** `cooldown.mjs` parses the reset time out of the CLI's
   own message, tuned to the **actual Claude Code limit strings**, most-precise first:
   - headless epoch — `Claude AI usage limit reached|1749924000` (exact, UTC seconds)
   - full sentence + IANA tz — `Claude usage limit reached. Your limit will reset at 3pm (America/New_York)` (resolved in that zone)
   - status line — `5-hour limit reached ∙ resets 5am` / `… - resets 3pm` (both `∙` and `-`)
   - weekly — `Opus weekly limit reached ∙ resets Oct 6, 1pm`
   - 429 wrapped — `rate_limit_error … retry-after: 3600` (seconds)
   - generic fallbacks — ISO timestamp, bare clock time, `try again in 2h 30m`

   If none is parseable it falls back to the documented window per provider
   (Claude/Codex ~5h, Gemini/Antigravity ~24h). State lives in `.harness/cooldown.json`.
3. **Route around it.** The next build iteration picks the first agent in the roster
   that is **not** in cooldown — Codex → Claude → Antigravity → Gemini by default
   (override with `LOOP_BUILDERS`). The reviewer does the same: if Claude is limited,
   review falls back to any available agent.
4. **Resume automatically.** If **every** agent is cooling down, the task is
   WIP-saved, requeued (`open`), and the loop sleeps until the **soonest** reset
   (capped at 1h so a bad parse can't wedge it for a day), then resumes — no human
   needed. Cooldowns are pruned the moment they expire, so each agent returns to its
   primary role on its own.

```
LOOP_BUILDERS   override the builder roster (comma-separated commands; default:
                codex, claude, antigravity, gemini in that order)
```

The reset times you asked to "기록" live in `.harness/cooldown.json`; the live trail
(`current.md`) logs every cooldown set and every "sleeping Ns" yield.

## Human interaction windows

The loop is async on purpose: it works while you can't, and asks for the minimum when
you can. Your **persona stands in for you at the deploy gate** (`persona-approve.mjs`),
so most decisions never reach your phone — only the ones the persona deliberately
escalates do. Energy is irregular, so the touch-points are small and time-boxed.

- **Weekday 07:00–08:00 — direction (phone).** Write/edit `spec.md` for the day. This
  is the only window where you set what gets built.
- **Weekday 08:00–16:30 — exceptions only (mobile).** During teaching hours the persona
  auto-ships routine changes for you. You tap ✅/❌ **only** on the cards the persona
  *held* (sensitive areas, high blast radius, low confidence). No typing, no review.
- **Weekend 07:00–11:00 — harness tuning.** Adjust the iteration cap, conventions in
  `CLAUDE.md`, the data contract in `AGENTS.md`, the escalation rules + threshold in
  `persona.md` (`PERSONA_APPROVE_THRESHOLD`), and review the `current.md` trail to audit
  what the persona approved on your behalf.

Outside these windows the loop keeps running; auto-approved changes ship, and anything
the persona held simply waits in the queue until you tap.

> **Tuning the gate.** `PERSONA_APPROVE_THRESHOLD` (default `0.8`) is the confidence bar
> for an autonomous deploy. Set `PERSONA_APPROVE=off` to disable the gate entirely and
> revert to legacy auto-deploy-on-sign-off. The persona's verdict for every card is
> recorded in the `current.md` trail (`actor: persona`).

## See also

- [`../AGENTS.md`](../AGENTS.md) — the master role contract and data contract
- [`../spec.md`](../spec.md) — your morning intent input
- [`../current.md`](../current.md) — the live action trail (telemetry fallback)
- [`./HARNESS.md`](./HARNESS.md) — the interactive (non-autonomous) 3-agent router
