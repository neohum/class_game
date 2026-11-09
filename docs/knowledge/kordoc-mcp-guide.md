# Kordoc 및 Korean Law MCP 연동 가이드

> **벤치마크 대상 레포지토리:**
> - [`chrisryugj/kordoc`](https://github.com/chrisryugj/kordoc): HWP·HWPX·PDF·Office 문서 파싱, Markdown 변환, 누름틀 양식 채우기, 신구대조표(Diff) 생성
> - [`Canine89/suneung-math-hwpx`](https://github.com/canine89/suneung-math-hwpx): 수능형 수학 문제지(HWPX) 제작, OWPML 수식(`<hp:equation>`) 조판 및 2단 레이아웃
> - [`chrisryugj/korean-law-mcp`](https://github.com/chrisryugj/korean-law-mcp): 법제처 국가법령정보센터(law.go.kr) 법령·판례·조례·학칙 검색 및 인용 조항 검증

---

## 1. 개요 및 설계 철학

에듀테크 서비스, 학교 행정 솔루션, 공공기관 AI 에이전트 시스템에서 한국어 공문서(HWP/HWPX)와 법령/학칙 데이터는 필수불가결한 핵심 자산입니다. 기존 LLM 파이프라인은 복잡한 바이너리/XML OWPML 구조와 한글 수식 스크립트를 제대로 처리하지 못해 표 깨짐, 수식 왜곡, 법령 인용 오류(환각)를 빈번하게 겪었습니다.

`create-agent-harness`는 외부 런타임 의존성 없이 순수 Node.js 내장 모듈(`node:zlib`, `node:fs`, `node:buffer`)을 기반으로 동작하는 경량 무손실 어댑터인 **`scripts/loop/kordoc-bridge.ts`**와 1급 MCP 레지스트리(`scripts/loop/mcp-registry.ts`)를 구축하여 다음을 보장합니다:

1. **무손실 양방향 변환 (Bidirectional Lossless Conversion)**:
   - HWPX 표, 글자 서식(굵게/기울임/밑줄), 제목 계층, 누름틀(Form fields)을 표준 마크다운 및 JSON AST로 상호 변환.
2. **수능형 수식 표준 호환 (OWPML Equation Bridge)**:
   - 한컴 수식 스크립트(`{a} over {b}`, `sqrt {x}`, `int _{0}^{1}`, `lim _{x -> 0}`)와 LaTeX 수식(`\frac{a}{b}`, `\sqrt{x}`, `\int_0^1`, `\lim_{x \to 0}`) 간의 양방향 자동 번역.
3. **신구대조표 및 서식 diff (Form Diff Engine)**:
   - 원안 문서와 개정안 문서 간의 조항별 변경점(신설/삭제/수정) 및 누름틀 필드 값 변경을 감지하여 법령·학칙 개정용 표준 신구대조표 마크다운 표 생성.
4. **교육법령·학칙 인용 실시간 검증 (Korean Law Citation Verification)**:
   - 초·중등교육법, 고등교육법, 유아교육법, 교육기본법, 학교폭력예방법(학폭법), 교원지위법, 학교안전법 등 핵심 교육법령 및 각급 학교 교칙·조례 인용의 구조적 유효성과 약칭(Alias)을 실시간 검증.

---

## 2. 1급 MCP 레지스트리 등록

`scripts/loop/mcp-registry.ts`에 `kordoc`과 `korean-law-mcp`가 1급 사전 정의 서버로 등록되어 있습니다.

### 레지스트리 사양

| 서버 식별자 | 실행 커맨드 | 주요 기능 및 도구 |
| :--- | :--- | :--- |
| **`kordoc`** | `npx -y @chrisryugj/kordoc-mcp` | HWP·HWPX·PDF 양방향 변환, 누름틀 채우기, 신구대조표 diff, 수식 변환 |
| **`korean-law-mcp`** | `npx -y @chrisryugj/korean-law-mcp` | 법제처 법령·판례·조례·학칙 검색, 인용 조항 유효성 검증 |

### 클라이언트 설정 파일 반영 (`.mcp.json` / `.agents/mcp_config.json`)

Claude Code (`.mcp.json`) 및 AGY (`.agents/mcp_config.json`) 양측에 기본 등록되어 모든 에이전트가 별도의 수동 설정 없이 해당 도구를 호출할 수 있습니다.

```json
{
  "mcpServers": {
    "harness": {
      "command": "node",
      "args": ["scripts/loop/mcp-harness.ts"],
      "env": {}
    },
    "kordoc": {
      "command": "npx",
      "args": ["-y", "@chrisryugj/kordoc-mcp"],
      "env": {}
    },
    "korean-law-mcp": {
      "command": "npx",
      "args": ["-y", "@chrisryugj/korean-law-mcp"],
      "env": {
        "LAW_OPEN_API_KEY": ""
      }
    }
  }
}
```

---

## 3. `kordoc-bridge.ts` 구조 및 API 규격

### 3.1 어댑터 인터페이스 (`KordocAdapter`)

```typescript
export interface KordocAdapter {
  // HWPX 파일 파싱 (ZIP 버퍼 또는 XML 문자열 지원)
  parseHWPX(buffer: Buffer | Uint8Array | string): ParsedHWPXResult;

  // HWPX 파일 생성 (마크다운/AST + 누름틀 템플릿 주입)
  buildHWPX(markdownOrAst: string | KordocDocumentAST, options?: BuildHWPXOptions): Buffer;

  // AST <-> Markdown 상호 변환
  astToMarkdown(ast: KordocDocumentAST): string;
  markdownToAST(markdown: string): KordocDocumentAST;

  // OWPML 한컴 수식 <-> LaTeX 수식 변환
  equationToLatex(hancomScript: string): string;
  latexToHancom(latex: string): string;

  // 신구대조표 생성
  diffHWPX(original: ParsedHWPXResult | string, modified: ParsedHWPXResult | string): FormDiffResult;

  // 법령 및 학칙 인용 유효성 검증
  verifyKoreanLawCitation(citationText: string): LawCitationResult;
}
```

### 3.2 JSON AST 규격 (`KordocDocumentAST`)

```typescript
export interface KordocDocumentAST {
  type: "root";
  metadata?: {
    title?: string;
    author?: string;
    parsedAt?: string;
    generator?: string;
  };
  children: KordocNode[];
}

export interface KordocNode {
  type: "root" | "heading" | "paragraph" | "text" | "bold" | "italic" | "equation" | "table" | "tableRow" | "tableCell" | "field" | "lawCitation";
  text?: string;
  level?: number;                    // 제목 헤딩 레벨 (1..6)
  children?: KordocNode[];
  hancomScript?: string;             // 한컴 수식 (예: {a} over {b})
  latex?: string;                    // LaTeX 수식 (예: \frac{a}{b})
  rows?: number;                     // 표 행 수
  cols?: number;                     // 표 열 수
  fieldName?: string;                // 누름틀 이름
  citation?: LawCitationResult;      // 법령 인용 정보
}
```

---

## 4. 핵심 기능 상세 및 활용 예제

### 4.1 HWPX 파싱 및 누름틀 추출

```typescript
import { readFileSync } from "node:fs";
import { kordocBridge } from "./scripts/loop/kordoc-bridge.ts";

const hwpxBuffer = readFileSync("documents/school-rules.hwpx");
const result = kordocBridge.parseHWPX(hwpxBuffer);

console.log("마크다운 내용:\n", result.markdown);
console.log("누름틀 서식 필드:", result.fields); // { 학교명: "서울고등학교", 작성일: "2026-10-21" }
console.log("발견된 수식:", result.equations);
console.log("인용된 법령 조항:", result.citations);
```

### 4.2 수능 수학 문제지 수식 변환 (LaTeX <-> 한컴 수식)

`Canine89/suneung-math-hwpx`와 완벽히 호환되는 수식 번역:

| 형태 | 한컴 수식 스크립트 | LaTeX 수식 표현 |
| :--- | :--- | :--- |
| **분수** | `{x^2 + 1} over {2x}` | `\frac{x^2 + 1}{2x}` |
| **근호** | `sqrt {x + 3}`, `root {3} {x}` | `\sqrt{x + 3}`, `\sqrt[3]{x}` |
| **적분** | `int _{0}^{1} (3x^2 + 2x) dx` | `\int_{0}^{1} (3x^2 + 2x) dx` |
| **극한** | `lim _{x -> 0} {sin x over x}` | `\lim_{x \to 0} \frac{sin x}{x}` |
| **수열의 합**| `sum _{k=1}^{n} k^2` | `\sum_{k=1}^{n} k^2` |
| **괄호 조판**| `LEFT ( {a over b} RIGHT )` | `\left( \frac{a}{b} \right)` |

```typescript
// LaTeX -> 한컴 수식
const hancom = kordocBridge.latexToHancom("\\int_{0}^{1} \\frac{x^2+1}{2} dx");
// 결과: "int _{0}^{1} {x^2+1} over {2} dx"

// 한컴 수식 -> LaTeX
const latex = kordocBridge.equationToLatex("sqrt {x^2 + y^2} leq r");
// 결과: "\\sqrt{x^2 + y^2} \\le r"
```

### 4.3 교육 법령 및 학칙 인용 검증 (`verifyKoreanLawCitation`)

```typescript
// 1. 표준 법령명 질의
const c1 = kordocBridge.verifyKoreanLawCitation("초·중등교육법 제32조제1항");
console.log(c1.isValid);        // true
console.log(c1.canonicalName);  // "초·중등교육법"
console.log(c1.article);        // "제32조"
console.log(c1.clause);         // "제1항"
console.log(c1.statuteInfo?.summary);
// "초등교육 및 중등교육에 관한 기본적 사항을 정하는 법률 [제32조: 학교운영위원회의 기능 및 심의사항]"

// 2. 약칭(Alias) 자동 정규화
const c2 = kordocBridge.verifyKoreanLawCitation("학폭법 제17조");
console.log(c2.canonicalName);  // "학교폭력예방 및 대책에 관한 법률"
console.log(c2.statuteInfo?.summary);
// "... 피해학생 보호와 가해학생 선도 [제17조: 가해학생에 대한 조치]"

// 3. 학교 자치규범(교칙/학칙) 및 학생인권조례 질의
const c3 = kordocBridge.verifyKoreanLawCitation("○○중학교 학교생활인권규정 제14조");
console.log(c3.lawType);        // "school_rule"
console.log(c3.isValid);        // true
```

### 4.4 신구대조표 생성 (`diffHWPX`)

기존 규정과 개정안 문서를 비교하여 대한민국 법령·학칙 정기 개정 양식에 맞는 신구대조표 마크다운을 도출합니다:

```typescript
const original = "제10조 (교과수업) 교과수업은 주 5일제를 원칙으로 한다.";
const modified = "제10조 (교과수업) 교과수업은 온·오프라인 블렌디드 수업을 포함하여 주 5일제로 운영한다.";

const diff = kordocBridge.diffHWPX(original, modified);
console.log(diff.diffTableMarkdown);
```

출력 결과:
```markdown
| 번호 | 현행 (원안) | 개정안 (변경) | 개정 사유 및 비고 |
|:---:|:---|:---|:---|
| 1 | 제10조 (교과수업) 교과수업은 주 5일제를 원칙으로 한다. | 제10조 (교과수업) 교과수업은 온·오프라인 블렌디드 수업을 포함하여 주 5일제로 운영한다. | 일부 개정 |
```

---

## 5. CLI 명령어 일람

```bash
# 1. HWPX 문서 파싱 (마크다운 출력)
npx tsx scripts/loop/kordoc-bridge.ts parse sample.hwpx

# 2. HWPX 문서 파싱 (구조화된 JSON AST 출력)
npx tsx scripts/loop/kordoc-bridge.ts parse sample.hwpx --json

# 3. 마크다운 문서를 HWPX로 빌드 (수식 및 표 자동 조판)
npx tsx scripts/loop/kordoc-bridge.ts build input.md -o output.hwpx

# 4. 템플릿 HWPX 양식에 누름틀 데이터 채우기
npx tsx scripts/loop/kordoc-bridge.ts build input.md -o filled.hwpx --template form-template.hwpx

# 5. 두 문서 간의 신구대조표 생성
npx tsx scripts/loop/kordoc-bridge.ts diff before.hwpx after.hwpx

# 6. 한국 법령 및 학교 규칙 인용 유효성 검증
npx tsx scripts/loop/kordoc-bridge.ts verify-law "초·중등교육법 제32조제1항"
```

---

## 6. 테스트 및 검증 지침

단위 테스트를 실행하여 어댑터 인터페이스, 무손실 변환, 수식 변환, 법령 인용 검증이 모두 정상 동작함을 확인합니다:

```bash
npx tsx --test tests/kordoc-bridge.test.ts
```
