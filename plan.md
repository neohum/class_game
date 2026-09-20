# Execution plan

**설계가 필요한 일은 여기가 아니라 계획서에 쓴다.** 기능·마이그레이션·여러 파일에
걸친 리팩터링은 `plans/<slug>.plan.md` 한 장으로 쓰고
(`node scripts/loop/plan-doc.ts init <slug>`), 승인하면 그 문서가 순서를 갖춘 카드
전체로 컴파일된다 — [`docs/PLAN_DOCS.md`](docs/PLAN_DOCS.md). `Risk: medium` 이상을
이 파일에 적으면 plan gate가 빌드를 막는다.

이 파일은 설계가 필요 없는 한 줄짜리 잡무용으로 남는다.

Use one `## Card: <lowercase-slug>` section per committed work item. Only items
with `Status: ready`, a concrete `Goal`, at least one `Acceptance`, and at least
one `Tests` evidence command are compiled into the backlog. Draft, vague, or
unverifiable ideas remain visible here but are rejected by the compiler.

Every builder lane is a full cloud agent, so a card needs no capability contract
to be claimed. Risk and Complexity still steer review depth and the deploy gate.

Copy the shape below out of the comment and fill it in. It is kept commented so
this file's own instructions are never compiled into work.

<!--
## Card: example-card
- Status: ready
- Goal: Describe the observable outcome in one sentence.
- Acceptance: AC-1: A reviewer can verify the outcome from the repository or a test.
- Tests: Name the command or evidence that proves acceptance.
- Dependencies: another-card
- Priority: 1
- Risk: low
- Complexity: low
- Path allowlist: src/example/, tests/example.test.ts
-->
