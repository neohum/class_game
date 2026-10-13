# ADR 0030: Railway 배포 시 루트 Dockerfile 하이재킹 방지를 위한 샌드박스 Dockerfile 격리 (Dockerfile.sandbox)

- **상태:** 채택 (Accepted)
- **날짜:** 2026-10-13
- **결정자:** 저장소 소유자(승인), lead(Claude), explorer/control(AGY)
- **관련:** `template/Dockerfile.sandbox`, `bin/create.ts`, `scripts/loop/harness-sync.ts`, `docs/harness-gates.md`, Incident-018, ADR-0027

---

## 배경

`create-agent-harness`는 무인 자율 루프에서 빌더 및 모델 제어 명령을 격리 실행하기 위해 로컬 도커 샌드박스 이미지(`agent-harness:local`)를 생성하는 `Dockerfile`을 `template/`에 포함하여 배포해왔다.

그러나 여러 프로젝트를 Railway PaaS에 배포할 때 심각한 가동 중단(502 Bad Gateway / Request Timeout) 장애가 연쇄적으로 발생했다:
1. **Railway 빌더 자동 감지 우선순위의 맹점:**
   Railway 배포 파이프라인은 리포지토리 루트에 `Dockerfile`이 존재할 경우, 웹 대시보드나 `railway.json`에서 Nixpacks 또는 Railpack을 명시하더라도 **무조건 Dockerfile 빌더를 최우선으로 강제 적용**한다.
2. **좀비 컨테이너 (Zombie Container) 발생:**
   하네스 샌드박스용 `Dockerfile`의 기본 명령어는 `CMD ["node", "--version"]`으로, 빌더 테스트용으로만 설계되었다. 이로 인해 Next.js/Vite 웹 서버가 시작되는 대신 Node 버전 한 줄만 출력하고 컨테이너가 1초 만에 정상 종료(Exit 0)되어, 유입되는 HTTP 요청을 처리할 웹 프로세스가 부재한 상태가 되었다.
3. **사용자 자체 Dockerfile과의 혼선:**
   일부 백엔드/인프라 프로젝트(예: Golang, Python 서비스)는 프로덕션용 실제 `Dockerfile`을 필요로 하므로, 무차별적인 Dockerfile 삭제나 이름 변경은 사용자 고유의 프로덕션 빌드를 파괴할 위험이 있었다.

---

## 결정

하네스가 배포된 모든 프로젝트에서 클라우드 PaaS(Railway 등)의 빌더 가로채기를 원천 차단하고, 사용자 자체 Dockerfile은 100% 안전하게 보존하기 위해 다음 4대 원칙을 아키텍처 표준으로 채택한다.

### 1. 템플릿 파일명 영구 격리 (`Dockerfile.sandbox`)
- `create-agent-harness` 코어의 `template/Dockerfile`을 `template/Dockerfile.sandbox`로 변경한다.
- 샌드박스 빌드 명령어 주석을 `docker build -t agent-harness:local -f Dockerfile.sandbox .`로 표준화한다.
- 이로써 신규 스캐폴딩 및 업데이트 시 프로젝트 루트에 빌더를 가로채는 `Dockerfile`이 생성되지 않는다.

### 2. 서명 기반 안전 마이그레이션 (`isolateHarnessSandboxDockerfile`)
- `bin/create.ts` 스캐폴더 및 업데이트(`--update`) 파이프라인에 서명 검사 로직을 탑재한다:
  - 루트 `Dockerfile`이 존재하고, 해당 파일의 첫 줄에 하네스 고유 서명(`# agent-harness:local`)이 포함된 경우에만:
    - `Dockerfile.sandbox`가 없으면 `Dockerfile.sandbox`로 안전 이동(Rename).
    - 이미 `Dockerfile.sandbox`가 존재하면 `Dockerfile.harness-retired`로 퇴역 보존.
  - `# agent-harness:local` 서명이 없는 파일(사용자가 자체 정의한 Go, Python, Node용 Dockerfile)은 **절대 수정하거나 이동하지 않고 100% 보존**한다.

### 3. 동기화 및 헬스 게이트 스테이징 표준화
- `scripts/loop/harness-sync.ts` 및 `template/scripts/loop/harness-sync.ts`의 추적 패턴을 `"Dockerfile"`에서 `"Dockerfile.sandbox"`로 변경한다.
- 다운스트림 프로젝트 업데이트 시 `Dockerfile`의 삭제/이동 이력을 Git 인덱스에 안전하게 반영(`git add -u Dockerfile`)한다.

### 4. Railway 및 Next.js 16 빌드 호환성 표준화
- Next.js 웹 프로젝트의 `tsconfig.json`에서 하네스 내부 스크립트(`scripts/`)를 `exclude` 처리하여 타입 검사 충돌을 방지한다.
- React 19 JSX 반환 타입과 하네스 `BentoCard` 인터페이스 간의 충돌을 방지하도록 타입을 정규화한다.
- Nixpacks 배포 시 `package.json`의 `engines.node`(`>=20.9.0`) 설정을 준수하여 Node 18 구버전 폴백 에러를 방지한다.

---

## 결과

- **장점:**
  - Railway 등 PaaS에 배포 시 루트 `Dockerfile` 부재로 인해 Nixpacks/Railpack이 정상 작동하여 Next.js/Vite 웹 서버가 정상 실행된다.
  - 기존 하네스 버전에서 배포된 수십 개 프로젝트의 좀비 컨테이너 버그가 `--update` 1회 실행으로 무손실 완전 자동 해결된다.
  - 사용자가 의도적으로 만든 커스텀 Dockerfile은 안전하게 보존된다.
- **안전 불변식 보존:**
  - 비파괴 업데이트 원칙(`--update` never overwrites)과 퇴역 보존 원칙(`<path>.harness-retired`)을 온전히 준수한다.
