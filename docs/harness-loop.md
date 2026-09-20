# Coordination protocol and continuity

> Loaded on demand. This carries the authority of [`AGENTS.md`](../AGENTS.md),
> which names these stages in one line each and links here instead of restating
> them.
>
> Read this when you are working **inside the loop**: changing a stage, debugging a
> card that stalled, or handing a card from one model to another. The same loop
> script by script is in [`AUTONOMOUS_LOOP.md`](AUTONOMOUS_LOOP.md).

## Coordination protocol

The loop runs unattended on an always-on Linux server. Coordination is a bare git
repo + per-card lock files + a SQLite backlog (the "Ralph-Loop"). One task moves
through these stages:

0. **plan** — `plans/*.plan.md` 중 `status: approved`인 문서가
   `scripts/loop/plan-doc.ts`로 카드 사슬이 된다. 잘못된 문서는 **아무것도**
   컴파일하지 않는다 (반쪽짜리 기능이 큐에 들어가는 것이 더 나쁘다).
1. **pull** — fetch the latest from the bare repo so every machine agrees on state.
2. **claim** — `node scripts/loop/claim-task.ts <card>`: a SQLite transaction flips
   the row `open → claimed` (single-writer guarantee) **and** an `O_EXCL` lock file
   `current_tasks/<card>.lock` is created. Both must succeed. The lock excludes any
   contender sharing that lock dir's filesystem (all swarm workers on a host, or
   several hosts only when `HARNESS_LOCK_DIR` is a shared/network mount); across
   hosts that share only the bare repo, the SQLite claim is the serializer.
   A card whose `Dependencies:` are not all `done` is **not claimable** —
   `scripts/loop/deps.ts` computes the ready set, so the order a plan declares is
   the order that runs, and the ready set doubles as the wave several workers may
   take one card each from.
3. **iterate** — the **builder** edits in a worktree and runs `scripts/loop/health.sh`
   (`health.ps1` on Windows) between iterations, under the iteration cap. Before
   the first token is spent, `scripts/loop/plan-gate.ts` refuses a `Risk: medium|high`
   card that no approved plan document declares.
4. **reviewer sign-off** — the **reviewer** re-runs the health gate, checks the diff
   against the card intent, conventions, `.claude/persona.md` preferences, and the data contract below. The reviewer returns both acceptance evidence and a persona recommendation in one structured response; the deterministic persona floor still applies afterward.
5. **commit, push & promote** — only on a passing review and the persona-or-human
   gate; the loop promotes Railway staging → canary → production. Every stage
   must pass its health check before the next deploy starts. Old checkpoints and
   direct callers without an embedded persona verdict retain the separate
   fail-safe judge fallback.
6. **mobile notification & safety valve** — a Playwright screenshot is uploaded to Wasabi and sent via Telegram as a "deploy completed" alert. The developer can tap "반려 (롤백/재개발)" (Reject) to automatically revert the commit, redeploy (rolling back production), and set the card back to `open`.
7. **shortcomings self-assessment** — when the backlog is empty and the shared cadence is due (24 hours by default), one swarm worker runs `scripts/loop/assess-shortcomings.ts`. The Gemini-first explorer lane audits the workspace, tests, and logs against `.claude/persona.md`, generating new tasks directly into the backlog. An `O_EXCL` owner lease prevents duplicate audits; failures retry after one hour by default.

Every stage emits a telemetry event (`scripts/loop/telemetry.ts`) to the SQLite
trail and the human-readable `current.md` fallback.

## Continuity layer (Framein verbs)

The loop swaps agent CLIs mid-task (the cooldown roster). To stop a model swap from
losing context, `scripts/loop/framein.ts` adds four model-agnostic verbs on top of
the existing git+SQLite state. All state is git-friendly JSON under
`.harness/framein/<card>.*.json`; every helper is best-effort and never blocks the loop.

| Verb       | CLI                                   | What it guarantees                                                        |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------ |
| **start**  | `framein.ts start <card> "<spec>"`   | freezes a **work contract** (intent + baseline sha) at claim time; every model measures its diff from the same point and can't silently renegotiate the task |
| **risk**   | `framein.ts risk <card>`             | scores the working diff by the paths it touches → `low\|medium\|high`; "high" (auth/, secrets, migrations, billing, the data contract) forces the deploy gate to hold for a human tap |
| **capsule**| `framein.ts capsule <card> [to]`     | packages {contract, baseline→head diff, last health, risk, ledger} so the next lead model resumes mid-task with full context, not a bare spec |
| **show**   | `framein.ts show <card>`             | prints the contract + latest capsule + ledger                            |

How the loop uses them (all automatic):

- **On claim** — `start` freezes the contract (idempotent; a requeued card keeps its baseline).
- **On model swap or cooldown yield** — a `capsule` is written and prepended to the next agent's prompt, so a handoff inherits the contract + diff surface + ledger.
- **Before reviewer** — a **different** provider than the builder adversarially challenges the diff against the contract and emits a PASS/CONCERN/BLOCK decision brief. On a normal card this runs only with `FRAMEIN_CHALLENGE=1` and is **advisory** (the brief feeds the reviewer prompt). On a **high-risk** diff (auth/secrets/migrations/billing/the data contract) it runs **always** and a **BLOCK verdict stops the card before it is committed or pushed** — a fail-safe that sits *before* the persona deploy gate, not instead of it.
- **At the deploy gate** — the `risk` score feeds `persona-approve.ts`; a high-risk diff is held for the owner regardless of model confidence. Opt out with `FRAMEIN_RISK=off`.
