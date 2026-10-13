# 하네스 지식 라이브러리(Knowledge Library) 데이터 및 모듈 계약 (v1)

> **문서 상태**: 계약 확정 (Step 1: knowledge-contracts)  
> **최초 작성일**: 2026-10-09 (Asia/Seoul)  
> **적용 대상**: `template/scripts/knowledge/` 및 이를 소비하는 전체 하네스 모듈  

---

## 1. 개요 및 설계 원칙

본 문서는 create-agent-harness의 **지식 라이브러리(Knowledge Library)** 모듈들이 공유하는 데이터 스키마, 12대 포트 인터페이스, 오류 계층 및 런타임 호환성 규약을 정의하는 단일 진실 공급원(SSOT)입니다.

### 1.1 핵심 운영 아키텍처

- **Git 기반 단일 레지스트리**: 사용자가 등록한 URL 명세는 `knowledge/sources/<source_id>.json` 파일로 Git 형상 관리를 받으며, GitHub `main` 브랜치가 유일한 수집 입력 원천입니다.
- **Windows 단일 생산자**: Windows 전용 환경(예: i5-12400F, RX 6700 XT, Vulkan/CPU)에서 clean clone을 유지하며, 5분 주기로 `git pull --ff-only`를 수행하여 변경 및 갱신 만료 소스를 수집·임베딩합니다.
- **불변 스냅샷(Immutable Snapshot) 배포**: 생성된 SQLite 카탈로그(`catalog.sqlite`)는 무결성 검증을 거친 후 Private Cloudflare R2 버킷에 세대(`generation`) 디렉터리 단위로 업로드되며, 최종적으로 `latest.json` 포인터를 원자적으로 갱신합니다.
- **다중 기기 비차단 읽기(Non-blocking Reader)**: Mac, Linux 등 하네스를 구동하는 모든 클라이언트는 중앙 검색 서버 없이 로컬 캐시에 다운로드된 읽기 전용 카탈로그 스냅샷을 쿼리하여 기능 아이디어와 구현 근거를 즉시 제공받습니다.
- **Zero Runtime Dependencies 원칙**: 하네스 기본 패키지는 외부 런타임 의존성 없이 순수 Node.js 내장 모듈(`node:crypto`, `node:sqlite`, `node:fs` 등)로 동작합니다. 벡터 검색을 위한 `sqlite-vec`, 본문 파싱을 위한 `@mozilla/readability` 및 `linkedom`, S3 연동을 위한 `@aws-sdk/client-s3` 등은 선택 설치 런타임에만 격리 설치되며 엄격한 동적 import(Guarded Dynamic Import) 경계로 보호됩니다.

---

## 2. 핵심 데이터 계약 (Data Contracts)

### 2.1 SourceSpec (소스 명세, schema_version = 1)

Git 저장소의 `knowledge/sources/<source_id>.json`에 저장되는 단일 레코드입니다.

```typescript
export type SourceKind = "github-repo" | "github-stars" | "web";
export type SourceProvenance = "manual" | "github-stars" | "bookmarks-import";

export interface SourceSpec {
  /** '{kind}:{canonicalUrl}'의 SHA-256 16진수 해시 (64자) */
  source_id: string;
  /** 소스 종류 */
  kind: SourceKind;
  /** 정규화된 URL (자격증명 및 추적 파라미터 제거) */
  url: string;
  /** 사람이 읽을 수 있는 제목 */
  title?: string;
  /** 분류 및 검색 필터 태그 */
  tags: string[];
  /** 등록 의도 및 비고 */
  note?: string;
  /** 활성화 여부 (false인 경우 새 스냅샷 검색에서 제외) */
  enabled: boolean;
  /** 원격 변경 재확인 주기 (시간 단위, 1 이상) */
  refresh_hours: number;
  /** 등록 출처 */
  provenance: SourceProvenance;
  /** 생성 시각 (ISO 8601 with timezone offset, 예: 2026-10-09T10:00:00+09:00) */
  created_at: string;
  /** 최종 수정 시각 (ISO 8601 with timezone offset) */
  updated_at: string;
}
```

- **불변식**:
  - `source_id`는 반드시 `canonicalizeUrl(url, kind).sourceId`와 100% 일치해야 합니다.
  - URL 내부의 사용자 자격증명(`https://user:pass@...`)은 엄격히 금지되며 유효성 검증 단계에서 즉시 거부됩니다.
  - `refresh_hours`의 기본값은 `github-repo` 및 `github-stars`는 24시간, 일반 `web` 문서는 168시간(7일)입니다.

### 2.2 DocumentRevision (문서 수집 리비전)

외부 원천에서 성공적 또는 점진적으로 가져온 정규화된 문서 상태입니다.

```typescript
export type DocumentStatus =
  | "success"      // 본문 수집 및 정규화 성공
  | "unchanged"    // ETag/Last-Modified/Hash 일치로 재수집 생략
  | "retry"        // 네트워크 일시 오류 또는 Rate Limit으로 재시도 대기
  | "failed"       // 파싱 불가 또는 영구적 수집 실패
  | "unsupported"  // JS 렌더링/로그인이 필요한 비지원 페이지
  | "tombstone";   // 원본 삭제 또는 비활성화로 인한 무효화 표시

export interface DocumentRevision {
  document_id: string;
  source_id: string;
  url: string;
  /** 원격 리비전 식별자 (Git 커밋 SHA, HTTP ETag, Last-Modified 등) */
  revision: string;
  /** 정규화된 본문 텍스트의 SHA-256 해시 */
  content_hash: string;
  title?: string;
  text: string;
  license?: string;
  fetched_at: string;
  status: DocumentStatus;
  error?: string;
}
```

- **Tombstone Semantics**:
  - 소스가 Git에서 비활성화되거나 영구 404가 확인된 경우 카탈로그에서 즉시 물리 삭제하지 않고 `status: 'tombstone'` 리비전을 기록하여 다운스트림 인덱스 및 검색에서 안전하게 제외합니다.

### 2.3 Chunk (인덱싱 및 임베딩 조각)

```typescript
export interface Chunk {
  chunk_id: string;
  document_id: string;
  source_id: string;
  text: string;
  heading?: string;
  byte_offset: number;
  token_estimate: number;
  hash: string;
}
```

- **청킹 표준**: 문단 및 Markdown 헤딩 경계를 기준으로 분할하며, 목표 토큰 크기는 512 토큰, 청크 간 오버랩은 64 토큰입니다.

### 2.4 EmbeddingProfile & Model Fingerprint (임베딩 프로필)

```typescript
export interface EmbeddingProfile {
  model_id: string;
  revision: string;
  sha256: string;
  dimensions: number;
  pooling: "mean" | "cls" | "last" | string;
  normalization: boolean;
  tokenizer: string;
  query_instruction: string;
  chunker_version: string;
  fingerprint: string;
}
```

- **Model Fingerprint 불변식**:
  - 임베딩 모델의 가중치 SHA-256, 차원수, 풀링 방식, 정규화 여부, 질의 인스트럭션, 청커 버전을 정규화된 JSON 문자열로 직렬화한 후 SHA-256 해시를 산출합니다.
  - 프로필의 어느 한 필드라도 변경되면 Fingerprint가 달라지며, 이전 세대의 벡터와 절대 혼합 저장되지 않고 반드시 새 세대(`generation`)가 생성됩니다.

### 2.5 SnapshotManifest (배포 매니페스트, schema_version = 1, format_version = 1)

```typescript
export interface SourceSummary {
  total: number;
  active: number;
  failed: number;
}

export interface SnapshotManifest {
  schema_version: number;     // 항상 1
  format_version: number;     // 항상 1
  catalog_id: string;
  generation: string;
  parent_generation?: string;
  input_commit: string;
  created_at: string;
  source_summary: SourceSummary;
  document_count: number;
  chunk_count: number;
  model_fingerprint: string;
  sqlite_vec_version?: string;
  file_size_bytes: number;
  file_sha256: string;
  min_reader_version: string;
}
```

- **배포 순서 규약**:
  1. `snapshots/<generation>/catalog.sqlite` 업로드
  2. `snapshots/<generation>/manifest.json` 업로드
  3. `latest.json` 포인터를 새 `<generation>`으로 조건부 갱신 (오래된 작업의 역순 덮어쓰기 방지)

### 2.6 SearchHit (통합 검색 결과)

```typescript
export type RankSource = "fts" | "vec" | "tag" | "rrf";

export interface SearchHit {
  chunk_id: string;
  document_id: string;
  source_id: string;
  source_url: string;
  source_title?: string;
  heading?: string;
  excerpt: string;
  score: number;
  rank_source: RankSource;
  fetched_at: string;
  stale: boolean;
  license: string | "unknown";
}
```

- **RRF (Reciprocal Rank Fusion)**:
  - FTS5 키워드 검색, 태그 일치 검색, 벡터 코사인 유사도 검색 상위 30건을 $k=60$ 상수 기반 RRF 점수로 합성합니다.
  - 원시 코사인 유사도 점수를 그대로 신뢰 점수로 노출하지 않으며, 단일 소스당 최대 2개 청크로 중복을 제한합니다.

### 2.7 ProjectContext (로컬 프로젝트 맥락)

```typescript
export interface ProjectContext {
  project_name: string;
  stack: string[];
  goals: string[];
  existing_deps: string[];
  related_files: string[];
}
```

- **경계 보호**:
  - `.env`, 비밀번호, 인증서, 시스템 전역 경로, 저장소 외부 심볼릭 링크는 맥락 추출 대상에서 절대 제외합니다.
  - 프로젝트 맥락 및 로컬 피드백은 Git 원본이나 R2 스냅샷으로 전송되지 않고 로컬 머신에만 유지됩니다.

### 2.8 IdeaEvidence & IdeaEvidenceBundle (근거 중심 아이디어)

```typescript
export type IntegrationType = "api" | "mcp" | "cli" | "sdk" | "library";
export type Confidence = "high" | "medium" | "low" | "unknown";

export interface IdeaEvidence {
  capability_name: string;
  problem_to_solve: string;
  project_anchor: string;
  tool_anchor: string;
  integration_type: IntegrationType;
  candidate_files: string[];
  minimum_experiment: string;
  acceptance_criteria: string[];
  cost_license: string;
  confidence: Confidence;
}

export interface IdeaEvidenceBundle {
  ideas: IdeaEvidence[];
  generated_at: string;
  context_summary?: string;
}
```

- **Unknown 원칙**:
  - 라이선스 제약이나 기술 호환성을 확실히 증명할 수 없는 경우 임의로 안전하다고 판단하지 않고 `confidence: 'unknown'`, `cost_license: 'unknown'`으로 표기하여 개발자가 검토할 수 있도록 합니다.

---

## 3. 12대 포트 인터페이스 (Port Interfaces)

모든 포트 메서드는 호출자가 비동기 취소와 타임아웃을 강제할 수 있도록 마지막 인자로 `options?: PortOptions` (`signal?: AbortSignal; timeoutMs?: number`)를 필수로 지원합니다.

```typescript
export interface PortOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
```

### 3.1 IntakePort
URL 추가, 수정, 비활성화, 북마크 가져오기 등 레지스트리 원본을 검증하고 갱신합니다.
- `addSource(input: SourceSpecInput, options?: PortOptions): Promise<SourceSpec>`
- `updateSource(sourceId: string, patch: Partial<SourceSpecInput>, options?: PortOptions): Promise<SourceSpec>`
- `disableSource(sourceId: string, options?: PortOptions): Promise<SourceSpec>`
- `listSources(options?: PortOptions): Promise<SourceSpec[]>`
- `getSource(sourceId: string, options?: PortOptions): Promise<SourceSpec | null>`
- `importBookmarks(htmlContent: string, folderName?: string, options?: PortOptions): Promise<SourceSpec[]>`
- `validateSource(spec: unknown, options?: PortOptions): Promise<SourceSpec>`

### 3.2 FetcherPort
외부 HTTP 엔드포인트 및 GitHub REST API를 조회하여 정규 문서를 생성합니다.
- `fetch(spec: SourceSpec, options?: PortOptions): Promise<DocumentRevision>`

### 3.3 ProfilerPort
수집된 문서에서 기능 후보와 기술 통합 표면(API/MCP/CLI/SDK)을 추출합니다.
- `profileDocument(doc: DocumentRevision, options?: PortOptions): Promise<CapabilityCandidate[]>`

### 3.4 EmbedderPort
텍스트를 고정 프로필에 따라 벡터로 변환합니다.
- `embedQuery(query: string, options?: PortOptions): Promise<Float32Array | number[]>`
- `embedBatch(texts: string[], options?: PortOptions): Promise<Array<Float32Array | number[]>>`
- `getProfile(options?: PortOptions): Promise<EmbeddingProfile>`

### 3.5 CatalogPort
단일 작성자 SQLite 인스턴스에 문서, 청크, 벡터를 일관되게 색인합니다.
- `upsertDocument(doc: DocumentRevision, chunks: Chunk[], vectors?: Array<Float32Array | number[]>, options?: PortOptions): Promise<{ documentId: string; chunksUpserted: number }>`
- `tombstoneDocument(documentId: string, options?: PortOptions): Promise<void>`
- `getGeneration(options?: PortOptions): Promise<string>`

### 3.6 ObjectStorePort
R2 또는 로컬 파일시스템 기반 객체 저장소 추상화입니다.
- `getObject(key: string, options?: PortOptions): Promise<Buffer | Uint8Array | null>`
- `headObject(key: string, options?: PortOptions): Promise<{ size: number; etag?: string } | null>`
- `putObject(key: string, data: Buffer | Uint8Array, options?: PortOptions): Promise<{ etag?: string }>`
- `deleteObject(key: string, options?: PortOptions): Promise<void>`

### 3.7 PublisherPort
검증된 카탈로그를 원자적 스냅샷 파일로 묶어 발행합니다.
- `exportSnapshot(options?: PortOptions): Promise<{ snapshotPath: string; manifest: SnapshotManifest }>`
- `publish(options?: PortOptions): Promise<SnapshotManifest>`

### 3.8 ReaderPort
공용 캐시 디렉터리에서 최신 스냅샷을 동기화하고 읽기 전용 연결을 제공합니다.
- `sync(options?: PortOptions): Promise<{ updated: boolean; generation: string; manifest: SnapshotManifest }>`
- `getStatus(options?: PortOptions): Promise<{ generation: string | null; stale: boolean; mode: "vector" | "lexical" }>`
- `close(options?: PortOptions): Promise<void>`

### 3.9 ContextPort
현재 프로젝트의 메타데이터와 작업 상태에서 컴팩트한 맥락을 추출합니다.
- `extractProjectContext(projectRoot: string, taskOrCardId?: string, options?: PortOptions): Promise<ProjectContext>`

### 3.10 SearchPort
하이브리드(FTS + 태그 + 벡터) 검색을 실행하고 결과를 병합합니다.
- `search(query: string, context?: ProjectContext, options?: PortOptions & { limit?: number; mode?: "all" | "fts" | "vec" }): Promise<SearchHit[]>`

### 3.11 IdeasPort
검색된 도구 후보와 프로젝트 맥락을 바탕으로 실체적 근거 묶음을 도출합니다.
- `generateIdeas(hits: SearchHit[], context: ProjectContext, options?: PortOptions): Promise<IdeaEvidenceBundle>`

### 3.12 FeedbackPort
개발자의 아이디어 채택, 보류, 제외 결정을 로컬 오버레이에 영속화합니다.
- `recordFeedback(feedback: IdeaFeedback, options?: PortOptions): Promise<void>`
- `getFeedback(options?: PortOptions): Promise<IdeaFeedback[]>`

---

## 4. 오류 계층 및 실패 처리 규약 (Error Hierarchy & Failure Semantics)

모든 지식 라이브러리 예외는 `KnowledgeError`를 상속하며, 기계 판독 가능한 `code`와 세부 정보 `details`를 포함합니다.

```
KnowledgeError (base)
 ├── IntakeError                 (URL 오류, 지원하지 않는 스킴, 자격증명 내장, 소스 스펙 결함)
 ├── FetchError                  (네트워크 타임아웃, 사설망 차단, 크기 초과, 파싱 오류)
 ├── StorageError                (키 누락, 무결성 검증 실패, 쓰기 충돌)
 ├── ModelCompatibilityError     (Fingerprint 불일치, 차원 불일치, 모델 미설치)
 ├── ManifestValidationError     (스키마/체크섬 불일치, 지원하지 않는 포맷)
 ├── TimeoutError                (포트 작업 제한시간 초과)
 └── CancellationError           (AbortSignal에 의한 작업 중단)
```

### 4.1 타임아웃 및 취소 보장 (`withPortTimeout`)

```typescript
export async function withPortTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  options?: PortOptions,
): Promise<T>
```
- 상위 호출자가 전달한 `signal`이 이미 중단된 경우 즉시 `CancellationError`를 발생시킵니다.
- 지정된 `timeoutMs`를 초과할 경우 내부 컨트롤러를 즉시 abort하고 `TimeoutError`를 발생시킵니다.
- 비정상 종료 시에도 등록된 타이머와 이벤트 리스너는 `finally` 블록에서 완벽히 정리됩니다.

---

## 5. URL 정규화 및 해시 알고리즘 (Canonicalization & Hashing)

### 5.1 URL 정규화 규칙

| 소스 종류 (`kind`) | 입력 예시 | 정규화 결과 (`canonicalUrl`) |
| :--- | :--- | :--- |
| `github-repo` | `https://github.com/astral-sh/uv.git?foo=bar#readme` | `https://github.com/astral-sh/uv` (소문자, `.git`/파라미터/해시 제거) |
| `github-stars` | `https://github.com/neohum?tab=stars` | `https://github.com/stars/neohum` (표준 stars URL 통일) |
| `web` | `https://nodejs.org/API/sqlite.html?utm_source=x&b=2&a=1#sec` | `https://nodejs.org/API/sqlite.html?a=1&b=2` (경로 대소문자 보존, 추적 제거, 파라미터 정렬) |

### 5.2 추적 파라미터 제거 목록
다음 파라미터는 `web` URL 정규화 시 무조건 제거됩니다:
`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `utm_source_platform`, `utm_creative_format`, `utm_marketing_tactic`, `fbclid`, `gclid`, `gclsrc`, `dclid`, `msclkid`, `mc_eid`, `_ga`, `_gl`, `ref`, `ref_src`, `ref_url`, `source`, `spm`, `igshid`.

### 5.3 소스 식별자 (`source_id`)
$$\text{source\_id} = \text{SHA-256}(\text{kind} + \text{":"} + \text{canonicalUrl})$$
- 64자 소문자 16진수 문자열로 표현됩니다.

---

## 6. 크로스 플랫폼 호환성 및 운영 불변식

1. **단일 생산자 격리**: Windows 생산자 머신만이 카탈로그 쓰기 및 스냅샷 배포 권한을 가지며, 소비 클라이언트(Mac/Linux)는 파일 잠금 없이 읽기 전용으로만 접근합니다.
2. **원자적 스냅샷 전환**: 다운로드 중에는 임시 `.partial` 파일에 저장하며, SHA-256 체크섬과 매니페스트 유효성이 모두 입증된 후에만 디렉터리를 확정하고 `latest` 포인터를 원자적으로 교체합니다.
3. **손상 내성 및 롤백**: 새 스냅샷 검증에 실패하거나 네트워크가 단절된 경우 직전 정상 세대로 안전하게 대체 동작하며 절대 손상된 DB를 열지 않습니다.
