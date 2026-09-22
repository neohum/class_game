# Harness Plan Console (로컬 웹 계획서 콘솔)

> 프로젝트 코드베이스의 문맥을 정찰(Recon)하고, 하네스 표준 계획서(`plans/<slug>.plan.md`)를 웹에서 직접 작성·수정·검증하고 백로그로 승인 컴파일할 수 있도록 지원하는 zero-dependency 로컬 웹 콘솔입니다.

---

## 1. 개요 및 배경

하네스 시스템의 모든 작업은 **승인된 계획서(`plans/<slug>.plan.md`)**를 단일 진실 공급원(SSOT)으로 삼아 실행됩니다.
비공식적이거나 규격화되지 않은 메모 대신:
- 프로젝트의 파일 구조, 소스 코드, 테스트, Git 상태를 한눈에 정찰(Recon)하고
- 하네스 표준 규격(YAML frontmatter, Intent, Non-goals, Steps [Goal, Files, Acceptance, Tests, Risk], Verification, Reviewer topology)을 갖춘 계획서를 시각적으로 작성·편집하며
- `scripts/loop/plan-doc.ts` 검증 엔진과 직결되어 실시간으로 유효성을 확인하고
- 클릭 한 번으로 `status: approved` 승인 및 백로그 카드로 일괄 컴파일

`Harness Plan Console`은 외부 무거운 npm 라이브러리 없이(zero-dependency, Node.js 내장 `node:http`) 동작하는 경량 로컬 웹 콘솔로 이 흐름을 지원합니다.

---

## 2. 핵심 기능

### ① 프로젝트 탐색 & 문맥 정찰 (Project Reconnaissance)
- 현재 작업 중인 프로젝트뿐만 아니라 동일 작업공간 내의 형제 프로젝트(예: `D:\works\*`)를 자동 스캔하여 웹 UI에서 원클릭으로 전환할 수 있습니다.
- 프로젝트의 `package.json`, Git 브랜치 및 변경 파일 수, 주요 소스 및 테스트 디렉터리 구조를 정찰하여 계획서 작성 시 필요한 대상 파일 경로와 검증 테스트 명령을 쉽게 확인할 수 있습니다.

### ② 내장 계획서 에디터 & 실시간 유효성 검사 (Fail-Closed)
- 웹 UI에서 `plans/*.plan.md` 계획서 문서를 실시간으로 편집하고 저장할 수 있습니다.
- **[🔍 유효성 검사]**: `scripts/loop/plan-doc.ts` 엔진을 호출하여 누락된 필수 필드, 플레이스홀더 잔존 여부, 규격 위반을 실시간으로 확인합니다.
- `[+ 새 계획서 작성]` 모달을 통해 표준 규격의 계획서 템플릿을 즉시 생성할 수 있습니다.

### ③ 원클릭 승인 & 백로그 컴파일 (Approve & Compile)
- **[🚀 승인 & 백로그 컴파일]**: 작성 완료된 계획서를 승인하면 `status: approved`로 전환되고, `compilePlanDocs()`를 통해 하네스 SQLite 백로그 카드 사슬로 자동 컴파일되어 자율 루프에서 즉시 실행 큐에 진입합니다.

---

## 3. 실행 방법

```bash
# 기본 실행 (기본 포트: 4790, 브라우저 자동 실행)
npm run planner

# 또는 직접 스크립트 실행
node scripts/planner.ts

# 옵션 플래그
node scripts/planner.ts --port=4795 --no-open --project=D:/works/other-project
```

- **URL**: `http://127.0.0.1:4790`
- **Studio 연동**: Harness Studio(`http://127.0.0.1:4780`) 상단 헤더의 `[📝 계획서 플래너]` 링크를 통해 언제든 진입할 수 있습니다.
