---
name: Harness CI Doctor
on:
  workflow_dispatch:
    inputs:
      run_id:
        description: "선택 사항: 분석할 GitHub Actions run ID"
        required: false
        type: string
permissions:
  contents: read
  actions: read
  checks: read
  pull-requests: read
safe-outputs:
  noop:
timeout-minutes: 10
---

# Harness CI Doctor

최근 CI 실패 또는 입력된 `${{ github.event.inputs.run_id }}` 실행을 읽기 전용으로
진단한다.

1. 실패한 job과 step, 관련 로그의 최소 구간을 찾는다.
2. 실패 원인을 코드, 테스트, 환경, 일시적 인프라 문제로 분류한다.
3. 재현 명령, 가장 작은 수정 후보와 추가 검증을 실행 로그에 한국어로 보고한다.
4. 저장소, 이슈, PR, 브랜치, workflow를 수정하거나 실행하지 않는다.

This is a read-only diagnostic workflow. Do not modify repository state and do
not request any output other than `noop`. 배포와 재실행은 사람이 별도로 결정한다.
