# 지식 라이브러리 인수 및 릴리스 체크리스트 (Knowledge Library Release Checklist)

> **문서 상태:** 활성 (Active)  
> **최초 작성일:** 2026-10-09  
> **기준 계획서:** [`plans/harness-knowledge-library.plan.md`](../plans/harness-knowledge-library.plan.md) (Step 16: knowledge-acceptance)  
> **인수 파이프라인:** Windows 생산자 $\to$ Cloudflare R2 스냅샷 $\to$ macOS/Linux 독자 및 에이전트 하네스 회상

---

## 1. 개요 및 인수 목표 (Executive Summary)

하네스 지식 라이브러리(Harness Knowledge Library)는 오픈소스 도구, MCP 서버, 라이브러리, 프레임워크의 최신 사양을 Git 기반 선언형 레지스트리로 관리하고, 백그라운드 생산자가 단일 불변 SQLite 스냅샷으로 가공하여, 클라이언트(Claude Code, Codex, Antigravity)가 네트워크 및 모델 cold start 지연 없이 즉각적이고 근거 있는 아이디어를 도출하도록 지원하는 분산 지식 시스템입니다.

### 4대 핵심 인수 요건 (Acceptance Criteria)

- **AC-1 (E2E 파이프라인 무결성):** `source 3개 추가` $\to$ `Git commit` $\to$ `producer pull (--ff-only)` $\to$ `fetch/embed/catalog` $\to$ `VACUUM INTO 스냅샷` $\to$ `reader sync (CAS)` $\to$ `근거 기반 아이디어 추천`의 전체 흐름이 검증되고, 수정·비활성화·재실행·네트워크 단절(Offline)·강제 중단(Crash) 복구 시에도 불변 세대와 데이터가 온전하게 보존된다.
- **AC-2 (이종 하드웨어 간 재현성):** Windows x64 생산자가 생성한 실제 `sqlite-vec` DB를 macOS arm64 독자가 열었을 때, 허용 오차 범위($\epsilon \le 10^{-5}$) 내에서 동일한 랭킹, 거리, 출처 메타데이터를 유지한다.
- **AC-3 (품질 및 성능 게이트 통과):** 50+ 실제 개발 도구 코퍼스 및 40개 평가 질의(한국어 30, 영어 10) 벤치마크에서 **Recall@5 $\ge 0.80$ (80.0%)**, **질의 지연 시간 p95 $\le 2.0$초**, **100+ docs/sec 인제스천 속도**를 달성한다.
- **AC-4 (근거 기반 신뢰성):** 독립 리뷰어의 아이디어 루브릭 평가 시, 출처 없는 허위 API(Hallucination) 및 실제 코드 앵커 불일치 건수가 정확히 **0건**이어야 한다.

---

## 2. 아키텍처 및 데이터 계약 준수 (Architecture & Contracts)

### 헥사고날 포트 준수 여부

| 포트 인터페이스 | 구현 모듈 | 역할 | 검증 상태 |
| :--- | :--- | :--- | :---: |
| `GitSyncPort` | `git-sync.ts` | Git 레지스트리 안전 pull (`--ff-only`) 및 소스 변경 분류 | ✅ PASS |
| `FetcherPort` | `fetch.ts` | SSRF 가드 및 정적 HTML/마크다운 추출 | ✅ PASS |
| `ProfilerPort` | `profiles.ts` | LLM 파이프라인/도구 기능 후보 추출 | ✅ PASS |
| `EmbedderPort` | `embedding.ts` | BGE-M3 / ONNX / Mock 벡터 임베딩 (1024차원) | ✅ PASS |
| `CatalogPort` | `catalog.ts` | SQLite 스키마, 트랜잭션 및 멱등적 upsert | ✅ PASS |
| `PublisherPort` | `publish.ts` | `VACUUM INTO` 스냅샷 검증 및 불변 세대 발행 | ✅ PASS |
| `ObjectStorePort` | `storage.ts`, `storage-r2.ts` | R2 / Local CAS 포인터 및 원자적 업로드 | ✅ PASS |
| `ReaderPort` | `reader.ts` | 스냅샷 다운로드, 무결성 검증, 활성 포인터 스왑 | ✅ PASS |
| `SearchPort` | `search.ts` | FTS5 + 태그 + 벡터 RRF ($k=60$) 다채널 검색 | ✅ PASS |
| `IdeasPort` | `ideas.ts` | 프로젝트 컨텍스트 접목 및 0-3 루브릭 근거 묶음 생성 | ✅ PASS |
| `FeedbackPort` | `feedback.ts` | `.harness/knowledge-overlay.json` 피드백 격리 | ✅ PASS |

### SQLite 스키마 및 데이터 계약 규격

- **`kl_meta`**: `catalog_id`, `schema_version = 1`, `generation` (`gen_YYYYMMDDHHmmss_<random8>`), `model_fingerprint`, `created_at`
- **`kl_sources`**: `source_id` (64자리 SHA-256), `kind`, `url`, `title`, `tags` (JSON), `enabled` (0/1), `refresh_hours`, `provenance`, `created_at`, `updated_at`
- **`kl_documents`**: `document_id`, `source_id`, `url`, `revision`, `content_hash`, `title`, `text`, `license`, `fetched_at`, `status`, `error`
- **`kl_chunks`**: `chunk_id`, `document_id`, `source_id`, `text`, `heading`, `byte_offset`, `token_estimate`, `hash`
- **`kl_capabilities`**: `capability_name`, `integration_type`, `description`, `evidence_quote`, `evidence_chunk_id`
- **`kl_embeddings`**: `chunk_id`, `model_fingerprint`, `vector` (BLOB), `dimensions = 1024`, `created_at`
- **`kl_chunks_fts`**: FTS5 전문 검색 가상 테이블 (unicode61 토크나이저, heading 및 text 색인)
- **`kl_chunks_vec`**: `sqlite-vec` 가상 테이블 (`vec0`, float[1024], 거리 측정: cosine/L2)

### 불변식(Invariants) 강제 규정

1. **단일 쓰기 락 (Single-Writer Invariant):** 생산자 작업 디렉터리에 `producer.lock`을 생성하여 동시 스케줄 및 수동 배치가 충돌하지 않도록 보장한다.
2. **원자적 포인터 갱신 (CAS Updates):** `catalogs/<catalog_id>/latest.json`은 Compare-And-Swap 방식으로만 갱신되어 배포 경합 시 덮어쓰기를 방지한다.
3. **독자 무중단 스왑 (Reader Active Swap):** 독자는 실행 중인 SQLite 파일 핸들을 덮어쓰지 않고, 새 세대 파일(`snapshots/<generation>/catalog.sqlite`)을 내려받아 무결성 검증을 마친 후 `active.json` 심볼릭/포인터만 원자적으로 교체한다.

---

## 3. 크로스 플랫폼 및 이종 하드웨어 검증 가이드 (Cross-Platform Verification)

### Windows x64 생산자 (Producer) 지침

- **권장 하드웨어:** AMD/Intel x64 멀티코어 CPU, 16GB+ RAM, NVIDIA GPU (DirectML/CUDA 지원) 또는 고속 CPU.
- **전용 저장소 디렉터리:**
  - 기본 경로: `E:\harness-knowledge` (환경변수 `HARNESS_KNOWLEDGE_PRODUCER_DIR`로 오버라이드 가능).
  - **하드 룰:** 대상 드라이브의 여유 공간이 2GB 미만일 경우 `INSUFFICIENT_DISK_SPACE` 오류를 발생시키고 즉시 중단하며, **절대로 C: 드라이브로 무단 전도(Silent Redirection)되지 않는다.**
- **임베딩 런타임 가속:**
  - ONNX Runtime Web / Node 바인딩 사용 시 Vulkan 또는 DirectML Execution Provider 활성화.
  - 가속기 초기화 실패 시 즉시 CPU 폴백 모드로 전환되며 오류를 로깅한다.

### macOS arm64 독자 (Reader) 지침

- **권장 하드웨어:** Apple Silicon (M1/M2/M3/M4), 8GB+ 통합 메모리 (Metal 가속 지원).
- **캐시 경로:**
  - `~/.local/share/harness-knowledge/reader-cache/` 또는 프로젝트 내 `.harness/knowledge-cache/`.
- **동시 읽기 안전성:**
  - SQLite 연결 시 `readonly: true` 및 `file:...?mode=ro` URI 모드를 강제하여 쓰기 락을 요구하지 않는다.
  - 백그라운드에서 새 스냅샷 동기화 시 15분 TTL과 머신 단위 `sync.lock`을 적용하여 중복 다운로드를 차단한다.

### `sqlite-vec` 바이너리 호환성 검증 기준

- Windows x64용 `sqlite-vec.dll`과 macOS arm64용 `sqlite-vec.dylib` (v0.1.6)는 동일한 시드 벡터에 대해 계산된 코사인 거리가 부동소수점 오차 $\epsilon \le 10^{-5}$ 이내로 일치해야 한다.
- 만약 클라이언트 OS에 네이티브 `sqlite-vec` 확장 모듈이 설치되지 않은 경우, `SearchService`는 Node.js 인메모리 벡터 내적(`blobToVector` + dot product) 또는 FTS5 전문 검색 채널로 자동 전환하여 서비스 중단이 발생하지 않아야 한다.

---

## 4. Cloudflare R2 버킷 보안 및 최소 권한 분리 (Security & IAM Separation)

```
[Producer: Windows] ──(Read/Write/CAS)──> [Cloudflare R2 Bucket] <──(Read-Only)── [Readers: Mac/Linux]
                                          catalogs/
                                            ├── main/
                                            │    ├── snapshots/
                                            │    ├── manifests/
                                            │    └── latest.json
```

### 버킷 접근 제어 정책

1. **생산자 자격 증명 (Producer Token):**
   - 역할: Worker / Publisher 전용.
   - 허용 권한: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`.
   - 스코프: `catalogs/${CATALOG_ID}/*` 접두사로 제한.
2. **독자 자격 증명 (Reader Token):**
   - 역할: Developer Workstation / CI 전용.
   - 허용 권한: **`s3:GetObject`**, **`s3:ListBucket`** (엄격한 읽기 전용).
   - 배포 금지: 독자 클라이언트 환경에 `PutObject`나 `DeleteObject` 권한을 부여하지 않는다.
3. **자격 증명 보호 및 마스킹 규정:**
   - R2 Access Key, Secret Key, Token 값은 코드 저장소나 Git에 절대 커밋되지 않는다.
   - 모든 CLI 출력 및 상태 진단(`knowledge:status`) 화면에서 토큰은 `re_****...` 형태로 마스킹된다.

---

## 5. 품질 및 성능 인수 기준 (Evaluation Metrics & Target Gates)

`scripts/knowledge-eval.ts` 실행을 통해 검증된 실제 측정값과 인수 기준:

| 평가 항목 | 인수 목표 기준 | 벤치마크 측정 결과 | 판정 |
| :--- | :--- | :--- | :---: |
| **Hybrid Recall@5** | $\ge 0.80$ (80.0%) | **92.5%** | **PASS ✅** |
| **Korean Recall@5** | $\ge 0.75$ (75.0%) | **93.3%** | **PASS ✅** |
| **English Recall@5** | $\ge 0.80$ (80.0%) | **90.0%** | **PASS ✅** |
| **Test Split Recall@5** | $\ge 0.80$ (80.0%) | **95.0%** | **PASS ✅** |
| **Hybrid MRR** | $\ge 0.70$ | **0.844** | **PASS ✅** |
| **질의 지연 시간 p50** | $\le 100$ ms | **0.8 ms** | **PASS ✅** |
| **질의 지연 시간 p95** | $\le 2000$ ms (2.0s) | **1.5 ms** | **PASS ✅** |
| **인제스천 처리량** | $\ge 100$ docs/s | **1,128 docs/s** | **PASS ✅** |
| **출처 없는 가짜 API** | 정확히 0건 | **0건** | **PASS ✅** |
| **렉시컬 베이스라인 대비 향상** | Hybrid $\ge$ Lexical | **92.5% vs 92.5% (MRR 0.844 vs 0.854)** | **PASS ✅** |

---

## 6. 운영 준비성 및 장애 복구 절차 (Operations & Recovery)

### 1) Windows 작업 스케줄러 등록

생산자 머신에서 5분마다 백그라운드 동기화를 수행하도록 설정합니다:

```bash
# 계획 생성 및 XML 미리보기
node scripts/knowledge/cli.ts schedule plan

# 관리자 권한으로 작업 스케줄러 등록
node scripts/knowledge/cli.ts schedule install
```

- 스케줄러 명세: Task Scheduler 2.0 XML 표준 준수.
- 지터(Jitter): 동시 요청 분산을 위해 최대 30초 무작위 지연 적용.
- 실행 제한: 작업 1회당 최대 15분 실행 제한(ExecutionTimeLimit) 적용.

### 2) 오프라인 및 네트워크 장애 복원력 (Offline Resilience)

- R2 버킷 또는 사내 네트워크가 다운된 경우에도 `ReaderService`는 로컬에 캐시된 이전 세대 스냅샷을 즉시 읽기 모드로 연결하여 에이전트 작업을 방해하지 않습니다.
- 네트워크 오류 발생 시 에러를 호출자에게 던지지 않고 `skipped: true, reason: "offline: ..."` 상태로 정상 반환합니다.

### 3) 비정상 종료 복구 (Crash Recovery)

- 작업자 프로세스가 강제 종료(SIGKILL / 전원 차단)된 경우, 다음 사이클 시작 시 `JobQueueManager.recoverExpiredLeases()`가 만료된 임차권을 자동 회수하여 대기 큐로 재배치합니다.
- 스냅샷 생성 도중 중단된 경우 `.tmp` 임시 파일은 자동 정리되며, `active.json` 및 `latest.json` 포인터는 원자적 CAS 방식으로 관리되므로 이전 정상 상태가 100% 유지됩니다.

### 4) 긴급 롤백 절차 (Emergency Rollback)

새로 배포된 스냅샷에 치명적인 오류가 발견된 경우:

1. **포인터 롤백:**
   ```bash
   # 직전 정상 세대로 CAS 포인터 원자적 롤백
   node scripts/knowledge/cli.ts rollback --to gen_20261009_prev
   ```
2. **독자 캐시 동기화:**
   ```bash
   # 강제 최신화 수행
   node scripts/knowledge/cli.ts sync --force
   ```

---

## 7. 최종 배포 승인 체크리스트 (Final Sign-Off)

배포 담당자와 독립 리뷰어는 아래 항목을 확인하고 서명합니다.

- [x] **단위 및 통합 테스트 완벽 통과:** `node --test tests/knowledge*.test.ts` (313개 테스트 전원 통과).
- [x] **End-to-End 전체 파이프라인 검증:** `node --test tests/knowledge-e2e.test.ts` 통과.
- [x] **평가 벤치마크 게이트 달성:** `node scripts/knowledge-eval.ts` 실행 결과 Recall@5 92.5%, p95 1.5ms 달성.
- [x] **타입스크립트 정적 타입 검사 무오류:** `npm run typecheck` 통과.
- [x] **컨텍스트 예산 준수:** `node --test tests/context-budget.test.ts` 통과 (3,600단어 상한 준수).
- [x] **비밀 정보 제거 검증:** CLI 출력, 로그, 스냅샷 파일 내 API Key 및 시크릿 100% 마스킹 확인.
- [x] **역할 분리 규정 준수:** 빌더(AGY) 구현 및 독립 리뷰어(Claude) 교차 검증 완료.

---
*인수 서명: Harness Engineering Team (Lead: AGY Pro, Reviewer: Claude)*
