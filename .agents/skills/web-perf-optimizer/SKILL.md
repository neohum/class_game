---
name: web-perf-optimizer
description: "웹 서비스, 대시보드, 프론트엔드 UI의 로딩 및 렌더링 성능을 극대화하는 표준 지침입니다. HTTP 압축(Zstd/Gzip), 정적 자산 캐싱 정책, 렌더 차단 자원 및 핵심 SVG 아이콘 프리로드(Preload)를 필수로 적용합니다. '웹 성능 최적화', '로딩 속도 개선', '반응 속도 최적화', 'web perf', 'caching', 'compression', 'preload' 요청 시 사용."
---

# web-perf-optimizer — 웹 성능 및 렌더링 극대화 스킬

이 스킬은 웹 서비스, 대시보드, 사용자 인터페이스를 구축하거나 배포할 때 **네트워크 전송 지연을 최소화하고 브라우저 체감 렌더링 속도를 3~5배 향상시키는 표준 프로토콜**입니다.

---

## 🎯 4대 핵심 성능 최적화 원칙 (Web Performance Pillars)

### 1. HTTP 전송 압축 의무화 (Zstandard & Gzip)
- **대상**: HTML, CSS, JavaScript, SVG, JSON 등 모든 텍스트 기반 응답.
- **설정 표준 (Caddy)**:
  ```caddyfile
  @@DOMAIN@@ {
      encode zstd gzip
      reverse_proxy 127.0.0.1:@@BACKEND_PORT@@
  }
  ```
- **효과**: 전송 파일 크기 70~85% 절감. (예: 60KB CSS ➔ 10KB 내외로 축소되어 TTFB 및 다운로드 지연 대폭 단축).

### 2. 강력한 브라우저 캐싱 (Long-Lived Caching & Revalidation)
- **원칙**: 버전 쿼리(`?v=...`) 또는 파일 해시가 붙은 정적 자산은 최소 1일~1년의 브라우저 캐시를 부여합니다.
- **헤더 표준**:
  ```http
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
  X-Content-Type-Options: nosniff
  ```
- **효과**: 재방문 시 네트워크 왕복 비용 0ms (디스크/메모리 캐시에서 즉시 렌더링).

### 3. 핵심 렌더 차단 CSS 및 주요 아이콘 사전 로드 (Preload)
- **원칙**: `<head>` 상단에 화면 초기 렌더링에 필수적인 스타일시트와 첫 화면(네비게이션/사이드바) 아이콘(SVG)을 `rel="preload"`로 명시합니다.
- **마크업 표준**:
  ```html
  <!-- 렌더링 필수 스타일 및 주요 UI 아이콘 프리로드 -->
  <link rel="preload" href="/static/styles.css?v=..." as="style">
  <link rel="preload" href="/static/uicons.css?v=..." as="style">
  <link rel="preload" href="/static/icons/bulb.svg" as="image" type="image/svg+xml">
  <link rel="preload" href="/static/icons/terminal.svg" as="image" type="image/svg+xml">
  <link rel="preload" href="/static/icons/user.svg" as="image" type="image/svg+xml">
  ```
- **효과**: 브라우저 파서가 HTML을 읽는 즉시 백그라운드 병렬 다운로드를 개시하여 스타일 적용 시점의 레이아웃 깜빡임(FOIC) 및 지연 제거.

### 4. 누락 리소스(404) 및 폭포수(Waterfall) 방지
- 배포 전 모든 `<script>`, `<link>`, `<img>` 경로의 실제 파일 존재 여부를 검증합니다.
- 404 에러로 인해 브라우저 커넥션이 블로킹되거나 타임아웃을 대기하는 낭비를 원천 차단합니다.
