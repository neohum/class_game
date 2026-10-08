---
name: workspace-sync-all
description: "전체 에코시스템(edulinker_v2 및 5대 서브모듈, all_market, cloud-school, edulinker-vec, co-working, auto-school-work, paper-cutting-ui 등)의 Git 및 GitHub 상태를 일괄 점검하고, 안전한 깃 풀, 작업 브랜치 커밋·푸시, GitHub PR 생성, Squash & Merge, 브랜치 삭제, main 동기화를 안전하게 오케스트레이션하는 2-Tier 마스터 깃 동기화 스킬입니다. '깃 동기화', '전체 깃풀', '모든 저장소 머지', 'workspace sync', 'git sync all' 요청 시 사용."
---

# workspace-sync-all — 2계층(2-Tier) 에코시스템 깃 동기화 및 메인 머지 스킬

이 스킬은 `edulinker-project` 생태계 내 모든 저장소의 Git 및 GitHub 상태를 안전하게 점검하고,
**안전한 Fast-Forward 깃 풀** 및 **검증 기반 PR 생성 ➔ Squash & Merge ➔ 브랜치 삭제 ➔ main 동기화**를 체계적으로 수행하는 표준 운영 스킬입니다.

---

## 🛡️ 4대 안전 불변 원칙 (Safety Invariants)

1. **Fail-Closed 원칙 (임의 강제 머지 금지)**:
   - 작업 트리에 변경사항(`DIRTY`)이 남아 있거나 충돌 가능성이 있는 저장소는 절대 강제로 `reset --hard`나 `stash` 후 임의 머지하지 않습니다.
   - 반드시 **작업 의도 파악 ➔ 테스트 검증 ➔ 전용 브랜치 분기 ➔ PR 생성** 절차를 거칩니다.
2. **테스트 게이트(Health Gate) 통과 필수**:
   - 커밋 및 PR 생성 전 각 프로젝트의 단위 테스트(`go test ./...`, `pnpm test` 등)가 통과함을 확인합니다.
3. **단일 원자적 스쿼시 머지 (Squash & Merge)**:
   - 모든 기능 브랜치는 `gh pr merge --squash --delete-branch`로 메인 브랜치에 단일 커밋으로 병합하고 원격/로컬 브랜치를 정리합니다.
4. **환경변수 가드 (`ALLOW_PUSH=1`)**:
   - `main` 직접 푸시 방지 가드가 있는 저장소에서는 작업 브랜치를 통해 PR을 생성하거나, 승인된 경우에만 임시로 `$env:ALLOW_PUSH="1"`을 설정 후 즉시 해제합니다.

---

## 📋 2계층(2-Tier) 실행 워크플로우

### [Tier 1] 사전 진단 및 안전 깃 풀 (Pre-flight Inspection)

먼저 생태계 12개 저장소의 전체 상태를 일괄 스캔합니다:

```powershell
node scripts/ops/workspace-git-sync.mjs --check
```

- **Clean 상태인 main 저장소들**:
  아래 명령으로 충돌 없이 원격 최신 커밋을 안전하게 Fast-Forward 가져옵니다:
  ```powershell
  node scripts/ops/workspace-git-sync.mjs --pull
  ```

---

### [Tier 2] 미정리 브랜치 및 변경사항 완결 파이프라인 (Interactive Sync)

`--check` 결과에서 `DIRTY` 또는 `Feature Branch`가 발견된 저장소에 대해 아래 5단계 표준 절차를 적용합니다.

#### 1단계: 저장소 이동 및 상태 확인
```powershell
cd D:\works\<target-repo>
git status -s
```

#### 2단계: 사전 테스트 검증 (Health Gate)
* **Go 프로젝트 (`sync-server`, `auto-school-work`, `cloud-school` 등)**:
  ```powershell
  go test ./...
  ```
* **Node/Next.js 프로젝트 (`web_service`, `all_market`, `co-working` 등)**:
  ```powershell
  pnpm test
  # 또는 pnpm --filter <pkg> typecheck
  ```

#### 3단계: 전용 브랜치 생성 및 커밋
현재 브랜치가 `main`인 경우 안전하게 작업 브랜치를 분기합니다:
```powershell
git checkout -b <feat|fix>/<작업-슬러그>
git add -A
git commit -m "<type>(<scope>): <명확한 작업 요약>`n`nAd-hoc: <상세 작업 이유 (8자 이상)>"
```

#### 4단계: 원격 푸시 및 GitHub PR 생성
```powershell
$env:ALLOW_PUSH="1"
git push -u origin <feat|fix>/<작업-슬러그>
Remove-Item Env:\ALLOW_PUSH

gh pr create --title "<type>(<scope>): <PR 제목>" --body "## 변경 요약`n- <작업 내용>`n`n## 검증`n- 테스트 통과 완료"
```

#### 5단계: Squash & Merge 및 브랜치 자동 삭제
```powershell
gh pr merge --squash --delete-branch
git checkout main
git pull origin main
git fetch --prune origin
```

---

## 🎯 세션 시작 훅 (Orca / Agent Session 연동 팁)

Orca 또는 에이전트 세션을 시작할 때마다 자동으로 가벼운 진단을 수행하려면,
세션 시작 스크립트나 터미널 프로필에 아래 한 줄을 등록하여 활용합니다:

```powershell
node scripts/ops/workspace-git-sync.mjs --pull
```

- 깨끗한 저장소는 **1~2초 내에 자동으로 최신 커밋이 땡겨집니다**.
- 미완성 작업이나 브랜치가 있는 저장소는 **작업 유실을 막기 위해 건너뛰고 안내 배너를 띄웁니다**.
- 사용자는 안내를 보고 `/workspace-sync-all`을 호출하여 원하는 시점에 안전하게 머지를 진행할 수 있습니다.
