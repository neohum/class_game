# 하네스 속도 최적화 가이드 (Harness Speed Guide)

> 하네스의 엄격한 안전 게이트(Plan Gate, Evidence Gate, Health Gate, Anti-False Consensus)를 100% 보존하면서,
> 일상 개발 및 루프 실행의 지연 시간을 3배~10배 단축하는 표준 고속 개발 지침입니다.

---

## ⚡ 5대 고속 파이프라인 요약

### 1. 초고속 증거 수집 (`quick-evidence`)
수동으로 `evidence open`, 산출물 복사, `README.md` 4대 섹션을 작성하지 않고 단일 명령으로 증거를 완결합니다.
```bash
node scripts/loop/evidence.ts capture <card> --cmd "<test-command>" \
  --tested "<테스트한 명령 및 대상>" \
  --observed "<관찰된 동작 결과>" \
  --why "<충분한 이유 및 AC 충족>" \
  --omitted "<생략된 사항>"
```
- 테스트를 자동 실행하여 stdout을 artifact로 캡처합니다.
- 규격(각 섹션 20자 이상, placeholder 없음)에 맞는 `README.md`를 자동 생성합니다.
- 즉시 `verify`를 수행하여 exit 0 통과를 확인합니다.

### 2. TDD 초고속 게이트 (`fast-gate`)
단일 파일 수정 후 40초가 걸리는 전체 `npm test`를 돌리지 않습니다.
```bash
npm run test:quick
# 또는 특정 파일 지정
node scripts/loop/test-fast.ts path/to/file.test.ts
```
- `git status`로 변경된 파일에 매핑되는 테스트만 <1.5초 내로 실행합니다.
- 전체 테스트(`npm test` / `health.ps1`)는 리뷰 요청 직전 최종 단계에서만 1회 실행합니다.

### 3. 계획서 즉시 승인 및 컴파일 (`plan-fast`)
계획서 검증(`check`), 승인(`approved`), 백로그 컴파일(`compile`), Wave 조회를 한 번에 끝냅니다.
```bash
node scripts/loop/plan-doc.ts ready <slug>
```
- 유효성 검사 실패 시 fail-closed로 중단하고 오류를 알려줍니다.
- 통과 시 바로 착수할 Wave 1 단계와 copy-paste 가능한 명령을 안내합니다.

### 4. 선제적 지식 회상 디버깅 (`knowledge-recall`)
에러가 발생했을 때 맨땅에서 탐색하지 않고, 이미 해결된 지식을 0단계에서 조회합니다.
```bash
node scripts/loop/knowledge.ts recall "<에러 메시지나 키워드>"
```
- 검증된 해결책이 있으면 0턴으로 즉시 해결합니다.
- 새로운 문제 해결 시 `node scripts/loop/knowledge.ts remember`로 지식 허브에 등록합니다.

### 5. 원클릭 안전 릴리즈 (`ship.ts`)
13단계의 수동 CLI 대화형 실행 대신, 단일 스크립트로 안전하게 릴리즈합니다.
```bash
node scripts/loop/ship.ts --dry-run   # 사전 점검
node scripts/loop/ship.ts             # 검증, 커밋, PR, 스쿼시 머지, 브랜치 정리
```
- 비밀 파일 스테이징 방지, 헬스 게이트 통과, 독립 리뷰 확인이 충족되지 않으면 즉시 중단됩니다.
