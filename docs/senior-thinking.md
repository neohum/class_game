# Senior-thinking 규율 — 하네스 배치 안내

이 하네스의 일부 스킬과 에이전트 프롬프트는
[songjiun10-collab/Senior-thinking-skills](https://github.com/songjiun10-collab/Senior-thinking-skills)
커밋 `be98e588`(MIT)을 **고쳐 옮긴 것**이다. 원본 24개를 그대로 복사하지 않았다. 스킬 설명은 매 세션
시스템 프롬프트에 올라가므로, 하네스에 이미 있는 규율과 겹치는 것은 흡수하고 없는 규율만 새 스킬로
추가했다. 결정 근거는 [`docs/adr/0026-senior-thinking-skills-placement.md`](adr/0026-senior-thinking-skills-placement.md)에 있다.

## 어디에 무엇이 있나

| 원본 스킬 | 이 하네스에서 | 쓰는 역할 |
|---|---|---|
| verify-before-claiming | `.claude/skills/verify-done`에 흡수 | reviewer |
| fresh-context-review, surgical-change | `.claude/skills/self-review`에 흡수 | reviewer |
| bite-sized-plan | `plan-doc` 스킬(`.claude`·`.agents` 양쪽)에 흡수 | lead |
| root-cause-discipline | `.agents/skills/debug-protocol`에 흡수 | builder |
| chestertons-fence | `.agents/skills/safe-refactor`에 흡수 | builder |
| verifiability-first | `.agents/skills/tdd-loop`, `validator` 에이전트에 흡수 | builder·validator |
| clarify-the-real-problem | `validator` 에이전트에 흡수 | validator |
| adversarial-review | `adversary` 에이전트에 흡수 | adversary |
| widen-the-solution-space, weigh-tradeoffs, premortem, interface-contracts | `.claude/skills/<이름>` | architect (weigh·premortem은 lead도) |
| threat-and-scale-check, honest-artifacts | `.claude/skills/<이름>` | reviewer |
| search-first | `.claude/skills/search-first`, `.agents/skills/search-first` (같은 파일) | architect·builder |
| measure-before-optimizing | `.agents/skills/measure-before-optimizing` | builder |
| senior-engineer-mindset, design-for-the-next-reader, simplicity-budget, record-the-why, context-economy, delegate-to-subagents | 들여오지 않음 — 수요가 확인되면 별도 옵트인으로 검토 | — |
| persistent-memory, 번들 Python 훅·CLI | 들여오지 않음 — knowledge hub·plan-gate·telemetry와 중복, Node 전용 스택 | — |

고칠 때 적용한 규칙: description은 발동 조건만 50단어 이하, 원본의 Distinguished·Executive 관점 문단은
빼고 Principal 관점은 한 줄만 남김, 결과를 하네스 산출물(plan `Risk:`, `evidence/`, `docs/adr/`,
`knowledge.ts`)로 넘기는 "In this harness" 절 추가.

## 프롬프트를 입력하면 스킬이 쓰이는가

프롬프트를 스킬에 연결하는 라우터는 없다. 스킬이 쓰이는 경로는 셋이다.

| 경로 | 언제 | 확실성 |
|---|---|---|
| 모델이 description을 보고 직접 호출 | 모든 Claude 세션 | 측정값 있음(아래) |
| 역할 프롬프트의 명시 | architect·lead·reviewer·builder가 서브에이전트나 루프로 실행될 때 | 작업 지시로 적혀 있어 확실한 편 |
| 이름으로 직접 호출 (`/weigh-tradeoffs`) | 사용자가 원할 때 | 확실 |

**측정 (2026-09-17, 하네스 소스의 `scripts/skill-trigger-eval.ts`, 케이스 20건, 케이스당 1회):**
- 훅 없이도 양성 적중이 12/14였다(dev 6/7, holdout 6/7). 음성 오탐은 0/6이었다.
- 놓친 것은 `search-first`뿐이었다. 모델은 문서를 찾아보지 않고 기억으로 답했다. description을 "답변으로만 보여 주는 코드 예시와 런타임 내장 모듈도 포함"하도록 고친 뒤 다시 재자 14/14, 오탐 0/6이 됐다(search 케이스는 2건뿐이라 근거는 약하다).
- 케이스 문구가 설계·검토 요청임을 분명히 드러내는 편이라, 작업 맥락이 섞인 실제 요청에서는 발동률이 더 낮을 수 있다.

**키워드 힌트 훅은 배포하지 않는다.** 같은 20건을 훅을 켜고 다시 측정했지만 결과가 한 건도 바뀌지 않았다. 원인은 두 가지다.
- 키워드 규칙이 설계에 쓴 dev 케이스에서는 7/7을 맞혔지만, 새 holdout 케이스에서는 2/7만 맞혔고 음성 1건에 잘못 반응했다.
- 힌트가 맞았던 `search-first`도 모델이 따르지 않았다.

측정 전에 정한 기준(holdout 적중률이 30%p 이상 오름)에 못 미쳐 템플릿에서 뺐다. 측정에 쓴 스크립트와 증거는 하네스 소스의 `evidence/20260917-skill-trigger-*`에 있다.

스킬을 확실히 쓰게 하려면 이름으로 부르거나(`/weigh-tradeoffs`), 그 스킬을 명시한 역할 에이전트에게 일을 맡긴다.

## 이미 설치된 프로젝트에서 받는 법

`bin/create.ts --update`는 **이미 있는 non-JSON 파일을 덮지 않는다.** 그래서 업데이트하면 새 스킬
디렉터리(아래 "새 파일")만 들어오고, 기존 파일에 흡수한 내용은 들어오지 않는다. 기존 파일을 직접
고친 적이 없다면 그 파일을 지우고 `--update`를 다시 실행하면 된다. 고친 적이 있다면 하네스 소스의 같은
경로와 비교해 손으로 합친다.

새 파일 (`--update`가 자동으로 추가):

- `.claude/skills/{widen-the-solution-space,weigh-tradeoffs,premortem,interface-contracts,threat-and-scale-check,honest-artifacts,search-first}/SKILL.md`
- `.agents/skills/{search-first,measure-before-optimizing}/SKILL.md`
- `.claude/skills/ship/SKILL.md` (커밋→푸시→스쿼시 머지→브랜치 삭제→필요 시 배포)
- `docs/senior-thinking.md`, `docs/adr/0026-senior-thinking-skills-placement.md`

직접 반영해야 하는 기존 파일:

- `.claude/skills/verify-done/SKILL.md`, `.claude/skills/self-review/SKILL.md`
- `.claude/skills/plan-doc/SKILL.md`, `.agents/skills/plan-doc/SKILL.md`
- `.agents/skills/debug-protocol/SKILL.md`, `.agents/skills/safe-refactor/SKILL.md`, `.agents/skills/tdd-loop/SKILL.md`
- `.claude/agents/{architect,reviewer,builder,lead,validator,adversary}.md`
- `.codex/agents/builder.toml` (Codex architect는 `.claude/skills`를 읽지 않으므로 연결하지 않는다)

역할 프롬프트를 반영하지 않으면 Codex·AGY 쪽 새 스킬은 가리키는 곳이 없어 거의 쓰이지 않는다.
Claude 쪽 스킬은 description만으로도 발동할 수 있다.

## 원본 라이선스

```
MIT License

Copyright (c) 2026 songjiun10-collab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
