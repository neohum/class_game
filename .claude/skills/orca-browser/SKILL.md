---
name: orca-browser
description: >-
  Control and automate the embedded web browser inside Orca app via `orca browser ...`
  (navigate, screenshot, evaluate JS, click, type, wait). Use when inspecting web deliverables,
  testing UI workflows, taking visual proof, or scraping pages within Orca environment.
---

# Orca Browser Automation

Orca 앱 내부에 내장된 브라우저를 제어하여 웹 UI 검증, 스크린샷 캡처, DOM 요소 인터랙션 및 자바스크립트 실행을 자동화합니다.

## 🛠️ 주요 CLI 명령어

```bash
# 1. 브라우저 상태 확인
node scripts/orca.ts browser status

# 2. 특정 URL로 이동
node scripts/orca.ts browser navigate http://localhost:3000

# 3. 화면 스크린샷 캡처
node scripts/orca.ts browser screenshot .harness/shots/preview.png

# 4. 자바스크립트 코드 평가
node scripts/orca.ts browser eval "document.title"
```
