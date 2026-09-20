---
name: harness-update
description: "이 프로젝트에 적용된 create-agent-harness를 최신으로 갱신한다. '하네스 업데이트', '하네스 최신화', '하네스 갱신', 'update the harness', 하네스가 뒤처졌다는 세션 시작 알림(⚠️ Harness Update Available)을 봤을 때, 새 스킬/루프 스크립트/권한을 받아오고 싶을 때 이 스킬을 사용. 비파괴(--update) 원칙으로 사용자가 수정한 파일은 절대 덮지 않는다."
---

# Harness Update — 이 프로젝트를 하네스 최신본으로

이 프로젝트는 스캐폴딩 시점의 하네스 커밋이 `.harness-version.json`(커밋됨)에,
하네스 소스 위치가 `.harness/source.json`(gitignore, 머신 로컬)에 기록되어 있다.
세션 시작 시 `scripts/check-updates.ts`가 이 스탬프를 하네스 소스의 HEAD와
비교해 뒤처짐을 알린다.

## 워크플로우

1. **감지.** `node scripts/check-updates.ts` 실행 — 하네스 섹션 출력을 읽는다.
   - `✓ Harness is up-to-date` → 할 일 없음.
   - `⚠️  Harness Update Available: <old> -> <new>` → 2단계로.
   - `Harness check skipped (<reason>)` → 스탬프/소스 문제. 스탬프가 없으면
     아래 3단계의 명령을 직접 실행하면 스탬프가 새로 생긴다.
2. **하네스 소스 최신화 (필요 시).** `.harness/source.json`의 `sourcePath`가
   유효하고 origin보다 뒤처졌다면:
   ```bash
   git -C <sourcePath> pull --ff-only
   ```
   워킹 트리가 더럽거나 ff 불가면 멈추고 사용자에게 알린다 — 강제 pull 금지.
3. **적용.** 프로젝트 루트에서:
   ```bash
   node <sourcePath>/bin/create.ts . --update --no-install
   ```
   `--update`는 비파괴: 없는 파일만 쓰고, JSON은 딥머지하며, 기존 텍스트 파일은
   절대 덮지 않는다. 성공 시 두 스탬프 파일이 자동 갱신된다.
4. **결과 보고.** wrote/merged/skipped 카운트와 새로 들어온 파일(스킬, 루프
   스크립트, 권한)을 요약한다. settings.json 딥머지로 `defaultMode` 등이
   바뀌었으면 사용자 의도와 맞는지 확인한다.
5. **치워진 경로 전달 (있을 때).** 출력에 `retired=N` 과
   `<옛 경로> -> <옛 경로>.harness-retired` 줄이 있으면 그 목록을 **빠짐없이**
   사용자에게 알린다. 하네스가 이름을 바꾼(예: `.mjs` → `.ts`) 경로라 새 파일이
   따로 들어왔고, 옛 파일은 삭제된 게 아니라 옆으로 치워져 있다. 그 파일을
   프로젝트가 직접 고쳐 썼다면 새 이름 쪽으로 옮겨 붙일지 사람이 판단해야 하고,
   확인이 끝나면 `.harness-retired` 파일은 지워도 된다.

## 자동화 (opt-in)

세션 시작 검사에서 자동으로 처리하고 싶으면 환경변수로 켠다:

| env | 효과 |
| --- | --- |
| `HARNESS_AUTO_UPDATE=1` | 뒤처짐 감지 시 비파괴 `--update` 자동 적용 |
| `HARNESS_UPDATE_PULL=1` | 하네스 소스가 clean일 때만 `pull --ff-only` 자동 실행 |
| `HARNESS_UPDATE_TIMEOUT_MS` | 자동 `--update`의 제한 시간(ms, 기본 60000). 느린 디스크에서 "skipped"가 뜨면 올린다 |

기본값(알림만)에서는 어떤 파일도 변경되지 않는다.

## 알아둘 것

- **개선된 기존 스킬은 자동으로 덮이지 않는다.** `--update`는 이미 존재하는
  파일을 보존하므로, 특정 SKILL.md를 최신본으로 받으려면 그 파일을 지우고
  3단계를 다시 실행한다 (지우기 전에 사용자 수정 여부 확인).
  Senior-thinking 규율을 흡수한 기존 스킬·에이전트 목록은 `docs/senior-thinking.md`에 있다.
- **하네스가 이름을 바꾼 파일은 삭제되지 않는다 (v0.3.2).** `--update`의 "덮지
  않는다" 판정은 *목적지가 이미 있는가*로 이뤄지는데, 이름이 바뀌면 새 이름은
  없고(그래서 새로 쓰이고) 옛 이름은 더 이상 하네스 목록에 없다. v0.3.1까지는
  그 옛 파일을 조용히 지웠고, 프로젝트가 몇 년간 발전시킨 모듈이 그대로
  사라졌다. 지금은 `<path>.harness-retired`로 옮기고 요약에 경로를 출력한다.
- 스탬프가 손상되면 3단계 실행이 깨끗한 스탬프를 다시 쓴다.
- 이 스킬은 프로젝트를 갱신할 뿐, 하네스 저장소 자체를 수정하지 않는다.
