---
name: design-tokens
description: "기하 골격과 미적 표면을 프레임워크 비의존 디자인 토큰으로 종합·패키징하는 스킬. W3C Design Tokens(tokens.json) + CSS 커스텀 프로퍼티(tokens.css, 라이트/다크) + 사람이 읽는 DESIGN_GUIDE.md를 산출. 디자인 토큰 생성, 디자인 시스템 패키징, 색·타이포·간격을 코드로 내보내기, 프레임워크 독립적 토큰 출력이 필요할 때 반드시 사용. 원시→의미→컴포넌트 3계층과 별칭 참조 구조를 표준으로 강제."
---

# Design Tokens — 이식 가능한 단일 진실 원천

geometry의 수치와 aesthetic의 색을, **어떤 프레임워크에도 옮길 수 있는** 단일 토큰 세트로 종합한다. 모든 출력(JSON·CSS·가이드)은 하나의 토큰 트리에서 파생하므로 서로 어긋날 수 없다.

## 3계층 원칙 (핵심)

```
원시(primitive)  →  의미(semantic)  →  컴포넌트(component)
neutral.900         text.primary       button.bg
brand.500           accent.default     button.fg
space.4             space.inline.md    button.padding-x
```

- **원시**: 순수한 값 팔레트(색 계단, 스케일 단계). 의미 없음.
- **의미**: 역할 토큰. 원시를 **별칭 참조**(`{neutral.900}`)한다. 다크모드는 여기서 재매핑.
- **컴포넌트**: 의미를 참조하는 컴포넌트별 토큰(선택).

이 분리 덕에 브랜드 색 하나를 바꾸면 원시 한 곳만 고치면 되고, 다크모드는 의미 계층만 갈아끼우면 된다.

## 산출물 3종

`design-system/` 디렉토리에 세 파일을 만든다. 모두 같은 토큰 트리에서 생성한다.

### 1. tokens.json — W3C Design Tokens 포맷
- `$value`, `$type`, `$description` 키 사용. 별칭은 `"{path.to.token}"` 문자열.
- 도구 생태계(Style Dictionary 등)가 읽을 수 있는 표준.

### 2. tokens.css — CSS 커스텀 프로퍼티
- `:root`에 라이트, `:root[data-theme="dark"]`(또는 `@media (prefers-color-scheme: dark)`)에 다크 의미 토큰.
- 변수명은 토큰 경로를 `--`로: `--color-text-primary`, `--space-4`, `--font-size-lg`.
- 원시는 변수로, 의미는 원시 변수를 참조(`var(--neutral-900)`).

### 3. DESIGN_GUIDE.md — 사람용 사용 규칙
- 토큰 **나열이 아니라 사용 규칙**. "언제 무엇을 쓰는가" + do/don't.
- 색 팔레트 표(스와치 hex + 용도), 타이포 스케일 표, 간격 용법, 컴포넌트 예시.

> 정확한 파일 구조·키·예시는 `references/token-schema.md`를 반드시 따른다.

## 명명 규칙

`category.concept.variant.state` 점 표기:
- `color.surface.raised`, `color.text.muted`, `color.accent.default.hover`
- `space.4`, `font.size.lg`, `font.weight.bold`, `radius.md`, `shadow.raised`, `duration.fast`

JSON은 점→중첩 객체, CSS는 점→하이픈(`--color-surface-raised`).

## 참조 무결성 (critic이 검증)

- 모든 별칭 참조(`{...}`)가 실재하는 토큰을 가리켜야 한다 (끊긴 참조 금지).
- tokens.json과 tokens.css의 값이 일치해야 한다.
- 다크모드 의미 토큰이 라이트와 **같은 집합**을 커버해야 한다(누락 금지).

## 출력 절차

1. `_workspace/`의 brief·geometry·aesthetics를 읽는다.
2. 원시 토큰부터 채운다(색 계단, 스케일, 간격).
3. 의미 토큰을 별칭으로 매핑한다(라이트 + 다크).
4. 세 파일을 생성한다.
5. critic에 검증 요청 → 결함만 수정해 재출력(최대 1회 재시도) → director 승인.
