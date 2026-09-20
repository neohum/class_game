---
name: quick-evidence
description: 테스트를 직접 실행해 산출물을 캡처하고 4대 필수 섹션 README와 증거 검증을 1회 실행으로 완결합니다. "증거 작성", "evidence capture", "검증 증거" 요청 시 사용.
---

# Quick Evidence — 초고속 증거 수집 및 검증 자동화

이 스킬은 하네스의 Evidence Gate를 단일 명령으로 통과시키는 고속 증거 수집 표준 프로토콜입니다.
수동으로 폴더를 만들거나 README를 작성하지 않고, 테스트 실행부터 산출물 저장, 규격 문서화, `verify`까지 원스톱으로 처리합니다.

---

## ⚡ 실행 명령

```bash
node scripts/loop/evidence.ts capture <card> --cmd "<test-command>" \
  [--name "<artifact-filename>"] \
  [--tested "<테스트 실행 명령 및 대상>"] \
  [--observed "<실제 관찰된 동작 및 출력 요약>"] \
  [--why "<인수 조건 AC 충족 및 충분성>"] \
  [--omitted "<가린 시크릿 및 미실행 범위>"]
```

### 간단 실행 예시:
```bash
node scripts/loop/evidence.ts capture my-feature --cmd "npm run test:quick"
```

---

## 🔒 보장되는 불변식

1. **원스톱 검증 (Fail-Closed)**:
   - 지정된 `--cmd` 명령을 실제로 실행하고, 종료 코드(exit code)가 0이 아니면 오류 산출물을 저장하고 즉시 실패(exit 1)합니다.
2. **규격 자동 충족 (No Placeholders)**:
   - `README.md`의 4대 섹션(`WHAT WAS TESTED`, `WHAT WAS OBSERVED`, `WHY IT IS ENOUGH`, `WHAT WAS OMITTED`)을 모두 20자 이상으로 자동 구성하여 placeholder 잔존으로 인한 검증 실패를 원천 방지합니다.
3. **증거 무결성**:
   - 실행 즉시 `verifyEvidence(card)`를 내부 호출하여 정상 통과(ok) 여부를 확인합니다.
