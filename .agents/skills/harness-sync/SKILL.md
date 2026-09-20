---
name: harness-sync
description: "create-agent-harness 코어 템플릿과 하위 프로젝트 간의 하네스 설정, 공통 스킬, 헬스 게이트, 버전 동기화 및 자동 PR Squash Merge를 일괄 수행하는 자동화 스킬입니다. '하네스 업데이트', '하네스 최신화', '하네스 동기화', 'harness sync', 'harness propagate' 요청 시 사용."
---

# harness-sync — Multi-Agent Harness 자동 동기화 및 전파 스킬

이 스킬은 `create-agent-harness` 코어 레포지토리와 모든 하위 서비스/프로젝트 간의
하네스 계약(`AGENTS.md`, `CLAUDE.md`), 공통 스킬(`.agents/skills/`, `.claude/skills/`),
헬스 게이트, 린트/검증 스크립트의 변경 사항을 비파괴(`--update`) 방식으로 자동 동기화하고,
테스트 검증 후 **GitHub PR 생성 및 Squash Merge**까지 완전 자동으로 완수하는 표준 프로토콜입니다.

---

## 🎯 주요 동작 모드

1. **하위 프로젝트 갱신 (`update` / `sync`)**:
   - 현재 작업 중인 프로젝트에서 상위 `create-agent-harness`의 최신 변경점을 가져옵니다.
   - 명령: `node scripts/loop/harness-sync.ts sync --pr`
2. **코어에서 전체 프로젝트 일괄 전파 (`propagate`)**:
   - `create-agent-harness`에서 변경된 하네스 코어를 등록된 모든 다운스트림 프로젝트(`all_market` 등)로 일괄 배포하고 테스트 및 PR 병합을 완료합니다.
   - 명령: `node scripts/harness-sync.ts propagate --pr`
3. **상태 및 버전 점검 (`status` / `check`)**:
   - 현재 하네스 소스 경로와 등록된 프로젝트 목록, 버전 드리프트를 확인합니다.
   - 명령: `node scripts/harness-sync.ts check`

---

## 🛠️ 단계별 실행 절차

### 1단계: 코어 템플릿 버전 확인 및 Bump (코어 수정 시)
`create-agent-harness` 코어에 새 스킬이나 규칙이 추가된 경우 버전을 동기화합니다:
```bash
node scripts/version-sync.ts bump
pnpm test
git add -A && git commit -m "feat: update harness templates and skills"
git push origin main
```

### 2단계: 다운스트림 프로젝트 자동 동기화 및 PR 병합
```bash
# create-agent-harness에서 실행 시:
node scripts/harness-sync.ts propagate --pr

# 또는 개별 프로젝트(all_market 등)에서 실행 시:
node scripts/loop/harness-sync.ts sync --pr
```

### 3단계: 헬스 게이트 자동 검증
- 각 프로젝트별 `pnpm test` (vitest 및 단위 테스트) 100% 통과 확인.
- 미완료/실패 프로젝트 발견 시 로그 출력 및 자동 에스컬레이션.

---

## 🔒 안전 불변식 (Hard Rules)

1. **비파괴 업데이트 (`--update`)**:
   - 기존 프로젝트에서 자체 수정한 파일과 JSON 설정은 보존하고, 신규 파일 및 공통 스킬만 병합합니다.
2. **Main 직접 푸시 금지**:
   - 모든 프로젝트 업데이트는 전용 브랜치(`chore/harness-sync-...`) ➔ GitHub PR ➔ Squash Merge 절차를 거칩니다.
3. **Fail-Closed Verification**:
   - 테스트 스위트가 통과하지 않으면 PR이 병합되지 않고 롤백됩니다.
