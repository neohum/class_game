---
name: ship
description: 작업 트리의 모든 변경을 커밋→푸시→PR→main 스쿼시 머지→브랜치 삭제까지 끝내고, 필요하면 배포까지 진행한다. "전부 반영", "머지하고 배포", "ship it", "끝까지 올려 줘" 요청에 사용.
---

# Ship — 커밋부터 머지·배포까지

> ⚡ **원클릭 자동 릴리즈 매크로**:
> 13단계를 수동으로 실행하는 대신, 사전 점검·비밀 검사·게이트·버전 확인을 단일 명령으로 실행할 수 있습니다:
> ```bash
> node scripts/loop/ship.ts --dry-run   # 사전 점검
> node scripts/loop/ship.ts             # 자동 릴리즈 실행
> ```

작업 결과를 main에 한 개의 스쿼시 커밋으로 반영하고 흔적을 정리한다. 앞 단계는 되돌릴 수 있지만
**머지와 배포는 되돌리기 어렵고 외부에 공개된다.** 그래서 이 절차는 속도보다 "멈춰야 할 때 멈추는 것"을
우선한다. PR까지만 필요하면 `github-pr-squash` 스킬로 충분하다.

## 멈춤 조건 — 하나라도 해당하면 그 자리에서 멈추고 보고한다

- 비밀로 보이는 파일이 스테이징 대상에 있다(`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, 토큰 문자열)
- 헬스 게이트나 테스트에 **이 변경이 만든** 실패가 있다
- 변경을 빌더와 **독립된 프로바이더**가 리뷰하지 않았다(Anti-False Consensus). 푸시와 PR까지만 하고 멈춘다
- 푸시 훅이나 브랜치 보호가 거부했다. `--no-verify`, `--force`, 보호 규칙 우회는 절대 쓰지 않는다
- 머지 충돌이 났다. 양쪽 의도를 읽고 해결한 뒤 게이트를 다시 통과해야 머지한다
- 프로덕션 배포나 패키지 게시를 앞두고 있는데, 이번 요청에서 사람이 배포를 명시하지 않았다. **사람 확인**을 받는다
- auth·시크릿·마이그레이션·결제가 포함된 변경이다(Tier 3). 머지 전에 사람 확인을 받는다

## 절차

### 1. 사전 점검 (읽기만)
```bash
git status --short --untracked-files=all
git branch --show-current
git remote -v
gh auth status
```
- 변경 목록을 전부 읽는다. 무엇이 커밋에 들어갈지 모르는 채로 `git add -A` 하지 않는다.
- 비밀·대용량 바이너리·생성물(빌드 결과, 로그)을 골라내고, `.gitignore`에 넣어야 할 것은 보고한다.
- `gh`가 없거나 인증이 안 돼 있으면 푸시까지만 하고 웹 PR 링크를 안내한다.

### 2. 작업 브랜치
- 현재 브랜치가 `main`(또는 기본 브랜치)이면 커밋 전에 `git switch -c feat/<slug>`로 옮긴다. main에 직접 커밋하지 않는다.
- 이미 작업 브랜치면 그대로 쓴다.

### 3. 버전 동기화 (하네스 패키지일 때만)
`package.json`의 `name`이 `@neohum77/create-agent-harness`인 저장소에서만 적용한다.
```bash
node scripts/loop/version-sync.ts bump    # HEAD 대비 작업 트리 변경으로 판단
```
- `bumped` / `already-bumped` → 게시 대상 버전이 생겼다. 커밋 제목 끝에 `(vX.Y.Z)`를 붙인다.
- `docs-only` / `not-applicable` → 버전을 올리지 않는다.
- bump는 HEAD만 기준으로 보므로, 변경이 **이미 커밋돼 있으면** 올려야 하는데도 `docs-only`가 나올 수 있다. 판단은 origin/main 기준으로 다시 한다:
  ```bash
  git fetch origin main
  node -p "require('./package.json').version"                           # 브랜치 버전
  git show origin/main:package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version"
  git diff --name-only origin/main...HEAD -- bin template scripts hooks  # 배포 경로 변경
  ```
  두 버전이 **같고** 배포 경로 변경이 있으면 아직 올리지 않은 것이다. 버전이 이미 다르면 앞선 커밋에서 올린 것이니 다시 올리지 않는다.
  - 브랜치가 **한 번도 푸시되지 않았을 때만**: `git reset --soft $(git merge-base origin/main HEAD)` 뒤 bump를 다시 실행하고 커밋을 다시 만든다. 이 브랜치에서 만든 로컬 커밋만 합쳐지고, 어차피 스쿼시된다.
  - 이미 푸시된 브랜치라면 히스토리를 바꾸지 말고 사람에게 알린다.

### 4. 게이트
```bash
bash scripts/loop/health.sh        # Windows: pwsh scripts/loop/health.ps1
```
- 헬스 스크립트가 없는 저장소는 그 저장소의 테스트·타입체크 명령을 쓴다.
- 실패가 있으면 main에서도 같은 실패가 나는지 비교한다(`git worktree add <tmp> origin/main` 후 같은 테스트 실행). **새로 생긴 실패가 있으면 멈춘다.** 원래 있던 실패는 PR 본문에 목록으로 적는다.
- 카드 작업이면 `node scripts/loop/evidence.ts verify <card>`도 통과해야 한다.

### 5. 커밋
- 파일을 골라 스테이징하고, `git diff --cached --check`와 스테이징된 파일 이름으로 비밀을 한 번 더 확인한다.
- 메시지는 저장소 관례(`git log --oneline -10`)를 따른다. 제목에는 무엇을, 본문에는 왜를 쓴다. 증거·계획서 경로가 있으면 본문에 적는다.
- 커밋 규칙 전반은 `git-hygiene` 스킬.

### 6. 독립 리뷰
- 이 변경이 빌더와 다른 프로바이더의 리뷰를 이미 받았으면(리뷰 기록 경로를 확인) 넘어간다.
- 아니면 독립 프로바이더에게 읽기 전용 리뷰를 맡긴다. 예: `node scripts/agent-session.ts --agent agy "<리뷰 요청>"`. 판정이 BLOCK이면 고치고 게이트부터 다시 한다.
- 독립 리뷰를 받을 수 없으면 **7~8단계(푸시·PR)까지만** 하고 멈춘다.

### 7. 푸시
```bash
git push -u origin <branch>
```
원격이 앞서 있으면 `git pull --rebase`가 아니라 `git merge origin/<branch>`로 합친 뒤 게이트를 다시 통과한다. 강제 푸시는 사람이 명령으로 지시했을 때만 `--force-with-lease`로 한다.

### 8. PR
```bash
gh pr list --head <branch> --json number,url     # 이미 있으면 재사용
gh pr create --base main --title "<type>: <요약>" --body-file <본문 파일>
```
본문: 변경 요약, 검증(실행한 명령과 결과), 원래 있던 실패 목록, 증거·계획서 경로, 리뷰 결과.

### 9. 체크 대기
```bash
gh pr checks <number> --watch
```
체크가 없으면 `gh`가 "no checks reported"를 출력하고 **0이 아닌 코드로 끝난다.** 실패가 아니라 이 저장소에 자동 체크가 없다는 뜻이므로 4단계의 로컬 게이트를 근거로 삼는다(`set -e` 스크립트라면 이 경우만 따로 처리). 실제 체크가 실패하면 멈춘다.

### 10. 스쿼시 머지
```bash
gh pr merge <number> --squash --subject "#<number> <PR 제목>"
```
- 제목 형식은 main의 기존 스쿼시 커밋(`git log --oneline -5 origin/main`)에 맞춘다.
- `--delete-branch`는 쓰지 않는다. 이 옵션은 머지 직후 로컬 브랜치까지 지우고 main으로 옮겨 버려서, 머지 확인보다 삭제가 먼저 일어난다. 삭제는 11단계에서 확인 뒤에 한다.

### 11. 브랜치 삭제와 로컬 정리
```bash
gh pr view <number> --json state -q .state          # MERGED가 아니면 여기서 멈춘다
git switch main
git pull --ff-only origin main
if git ls-remote --exit-code --heads origin <branch>; then git push origin --delete <branch>; fi   # GitHub 자동 삭제로 이미 없으면 건너뛴다(종료 코드 0)
git branch -D <branch>                               # 스쿼시 머지는 조상 관계가 없어 -d가 거부한다
git fetch --prune
git ls-remote --heads origin <branch>                # 비어 있어야 한다
```
- 사용자가 이 스킬을 요청한 것은 **이번 PR의 브랜치**를 지우라는 지시다. 다른 브랜치는 지우지 않는다.
- 삭제는 PR 상태가 `MERGED`임을 확인한 뒤에만 한다.

### 12. 배포 판단
| 저장소 | 배포가 필요한 경우 | 방법 |
|---|---|---|
| 하네스 패키지 | 이 PR의 머지 커밋이 버전을 바꿨다(아래 확인) | 아래 "패키지 게시" |
| Railway 프로젝트 (`RAILWAY_TOKEN` 등 설정 있음) | 런타임 코드·설정이 바뀌었다 | 아래 순서 |
| 둘 다 아님 | — | "배포 대상 없음"이라고 보고한다 |

버전 변경 확인. 다른 PR이 뒤따라 머지됐을 수 있으니 `HEAD~1`이 아니라 이 PR의 머지 커밋을 기준으로 본다:
```bash
gh pr view <number> --json mergeCommit -q .mergeCommit.oid
for rev in <oid>~1 <oid>; do git show "$rev:package.json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version"; done
```
두 줄의 버전이 다르면 게시 대상이다. `package.json`의 의존성만 바뀐 경우를 게시로 오인하지 않도록 파일 차이가 아니라 버전 값을 비교한다.

패키지 게시:
```bash
gh workflow run publish.yml --ref main
gh run list --workflow publish.yml --event workflow_dispatch --limit 1 --json databaseId,createdAt,status
gh run watch <databaseId> --exit-status             # run id 없이 쓰면 비대화형에서 실패하고, --exit-status가 없으면 실패도 0으로 끝난다
```
- 조회한 실행의 `createdAt`이 방금 실행한 시각 이후인지 확인한다. 아니면 이전 실행을 보고 있는 것이다. 잠시 뒤 다시 조회한다.
- 워크플로를 쓸 수 없으면 사람에게 로컬 `npm publish`를 요청한다.

Railway 순서:
- `RELEASE_PIPELINE=staging-canary-production`이면 staging → canary → production을 차례로 하고, 단계를 건너뛰지 않는다.
- 단계마다 `node scripts/loop/deploy-railway.ts <card> --stage <stage>`를 실행하고, 이어서 `node scripts/loop/verify-deployment.ts --stage <stage> --url <health url>`로 검증한다. 검증이 실패하면 다음 단계로 가지 않는다.
- 프로덕션은 Tier 3다. 이번 요청에서 사람이 배포를 명시하지 않았으면 확인을 받는다.
- 토큰은 프로젝트·환경 단위만 쓴다. 계정 전역 토큰은 쓰지 않는다.
- main 머지가 곧 배포(플랫폼의 GitHub 자동 배포)인 저장소라면, 그 사실을 **10단계 전에** 알리고 같은 기준으로 확인을 받는다.

### 13. 보고
PR 번호와 URL, main의 스쿼시 커밋 SHA, 지운 브랜치(원격·로컬), 게시·배포 결과와 검증 출력을 보고한다. 건너뛴 단계와 그 이유, 원래 있던 실패도 함께 적는다. 확인하지 않은 것을 완료라고 쓰지 않는다.
