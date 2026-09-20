# Hard rules

> Loaded on demand — and **non-negotiable**. This carries the authority of
> [`AGENTS.md`](../AGENTS.md), whose *Hard rules* section names each of these in
> one line and links here for the detail. A rule stated in one place and enforced
> in another is still binding; nothing here is advisory.
>
> The loop is designed to fail safe, not fast.

## Hard rules

These are non-negotiable. The loop is designed to fail safe, not fast.

- **Max iteration cap.** Each card gets a fixed iteration budget. On reaching it the
  **builder** stops and escalates to the **lead** — it never loops forever.
- **Command timeout filter.** Every shell command runs under a timeout; a hung
  command is killed and surfaced, not silently waited on.
- **Never use account-wide cloud tokens.** Each release environment uses its own
  project/environment-scoped token (`RAILWAY_STAGING_TOKEN`,
  `RAILWAY_CANARY_TOKEN`, `RAILWAY_TOKEN`) — never an account API key.
- **Commercial releases promote, never jump.** Staging deploy+health and canary
  deploy+health must pass before production. A failed stage stops promotion; a
  production health failure retains rollback authority.
- **Never bypass the data-contract guard.** Every DB-row shape and every storage path
  must pass `scripts/loop/data-contract.ts`. A violation means fix the shape or the
  contract — never disable the guard.
- **Dynamic Context Pruning.** Do not dump static rules all at once. Agents must slice context dynamically and load task-focused sub-skills on demand to avoid context degradation ("Lost in the Middle").
- **Institutional Memory & ADR Respect.** Always consult `docs/adr/` (Architecture Decision Records) before refactoring core architecture. Respect historical trade-offs, operational constraints, and domain reasons ("why decisions were made").
- **Anti-False Consensus (Independent Cross-Verification).** Reviewers and auditors must run from an independent provider/model than the builder with adversarial challenge (`FRAMEIN_CHALLENGE=1`). A builder model cannot self-approve or review its own work to prevent false consensus.

- **Multi-Layer Deep Verification Gate.** Verification cannot rely on typecheck/lint alone. Tasks must pass 3 tiers of gates: Tier 1 (Static/Lint/Typecheck), Tier 2 (Functional Unit/Integration tests), and Tier 3 (Visual regression/Playwright screenshots & Runtime NFR checks).
- **Executable acceptance evidence.** A plan card needs `AC-*` acceptance IDs and
  at least one `Tests` command. The reviewer must return every ID exactly once
  with `pass` and concrete observed evidence; missing, duplicated, failed, or
  unverified criteria block shipping.
- **Fail-closed project quality profile.** `.harness-quality.json` declares
  always-required and changed-path-conditional checks. A required check cannot
  be absent or bypassed with `HEALTH_*=true`.
- **Brand assets are completion evidence.** Any app/web surface change must add a
  changed `evidence/<YYYYMMDD>-<card>/brand-assets.json`. It declares one vector
  source, `created|reused` intent, a referenced logo, a referenced favicon
  verified at 16px and 32px, a referenced app-icon of at least 128px, the
  plan/review contract, and a real screenshot under `evidence/`. Empty,
  unreferenced, escaping, or symlinked assets fail closed in both health shells;
  there is no `HEALTH_BRAND` bypass.
- **Built and visibly observed, or not done.** App/web changes must add a changed
  `evidence/<YYYYMMDD>-<card>/deliverable-preview.json` containing the exact
  production build command, `exitCode: 0`, a real artifact and build log, plus
  an observed localhost runtime or desktop window and screenshot. A web preview
  may bind only to loopback (`127.0.0.1`, `localhost`, or `::1`) and the recorded
  process must be cleaned up after observation. Headless environments remain
  `waiting-for-visual-review` with a concrete manual command; they never pass as
  observed. Build evidence containing deploy/publish/upload/push is rejected,
  and there is no `HEALTH_PREVIEW` bypass.
- **No approved plan, no risky build.** `scripts/loop/plan-gate.ts` blocks a
  `Risk: medium|high` card that no approved `plans/*.plan.md` declares — before the
  worktree, before the first token. Fix it by writing the plan, never by turning
  the gate off: `HARNESS_PLAN_GATE=off` is interactive-only and a declared
  unattended run refuses it (`autonomy.ts`).
- **No evidence file, no ship.** A card in scope for evidence
  (`evidence.requireAtRisk`, and always when it came from a plan document) must
  leave `evidence/<YYYYMMDD>-<card>/` with all four sections filled — WHAT WAS
  TESTED / OBSERVED / WHY IT IS ENOUGH / WHAT WAS OMITTED — plus at least one
  captured artifact. A model's report of what it observed is not the observation.
- **Dependency order is enforced, not hoped for.** A card is claimable only when
  every card in its `Dependencies:` is `done` (`scripts/loop/deps.ts`). Declaring
  a dependency and then racing it is the failure this removes.
