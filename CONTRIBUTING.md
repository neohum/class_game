# 기여 가이드 (Contributing Guidelines)

본 프로젝트는 **사람 개발자와 자율 AI 에이전트(Multi-Agent Harness)**가 함께 협업하는 저장소입니다.
모든 기여자는 아래의 하네스 표준 절차와 규칙을 준수해야 합니다.

---

## 🔀 1. 브랜치 전략 및 GitHub PR 규칙

1. **`main` 브랜치 직접 푸시 금지**:
   - `main`으로의 직접 커밋 및 직접 푸시는 엄격히 차단됩니다.
   - 모든 작업은 작업 브랜치(`feat/<기능명>`, `fix/<수정명>`, `lane/<에이전트명>`)에서 진행합니다.
2. **GitHub Pull Request (PR) 필수**:
   - 작업 완료 후 GitHub origin에 브랜치를 푸시하고 PR을 생성합니다.
3. **Squash and Merge 강제 (`gh pr merge --squash`)**:
   - `main` 병합 시에는 반드시 **Squash Merge**를 수행하여 단일 원자적 커밋으로 압축합니다.
   - 커밋 메시지 타이틀에는 PR 번호 태그(`(#PR_NUMBER)`)가 포함되어야 합니다.
   - 헬퍼 스크립트: `./scripts/dev/pr-squash-merge.sh "feat: 작업 내용"`

---

## 🧪 2. 헬스 게이트 및 품질 검증

PR 생성 및 머지 전, 프로젝트의 모든 헬스 게이트를 로컬에서 통과해야 합니다:

```bash
# 1. 단위 및 통합 테스트
pnpm test

# 2. 타입 검사 및 린트
pnpm typecheck
pnpm lint
```

---

## 🎨 3. UI 및 디자인 표준

- **아이콘 단일 표준**: 모든 UI 아이콘은 **Flaticon UIcons Regular Rounded (`fi fi-rr-*`)**만을 단일 표준으로 사용합니다. 임의의 인라인 SVG, Lucide, Heroicons, 이모지 혼용을 금지합니다.
- **다크/라이트 테마 토큰**: 하드코딩된 색상값 대신 디자인 시스템 토큰을 사용합니다.

---

## 📜 4. 커밋 메시지 규칙 (Conventional Commits)

- `feat(<scope>): <설명>` : 신규 기능
- `fix(<scope>): <설명>` : 버그 수정
- `refactor(<scope>): <설명>` : 리팩터링
- `docs(<scope>): <설명>` : 문서 변경
- `chore(<scope>): <설명>` : 설정, 빌드, 하네스 유지보수
