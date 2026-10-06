# Image Generation Prompt Recipes (이미지 생성 프롬프트 레시피 카탈로그)

> 하네스 기반 프로젝트에서 UI/UX 애셋, 히어로 일러스트레이션, 브랜드 그래픽을 생성할 때
> 일관된 고품격 시각 언어(High-Taste Aesthetics)를 유지하기 위한 프롬프트 레시피 카탈로그입니다.

`docs/image-prompts.json`에 큐레이션된 프롬프트 템플릿을 저장하고, `scripts/loop/image-prompts.ts` CLI를 통해
원하는 주제(`[subject]`)만 교체하여 즉시 `generate_image` 또는 외부 생성 AI 도구에 전달할 수 있습니다.

---

## 🎨 주요 프롬프트 스타일 레시피

### 1. Layered Paper-Cut (`layered-paper-cut`)
- **특징**: 부드러운 파스텔 톤, 겹겹이 쌓인 페이퍼컷 레이어와 은은한 그림자 효과, 깨끗한 벡터 외곽선과 수공예적 질감.
- **템플릿**:
  ```text
  Layered paper-cut illustration of [subject], with overlapping shapes in soft pastel colors, handcrafted textures, subtle shadows between layers, clean vector edges, centered on a matte cream background, whimsical and modern visual storytelling.
  ```
- **네거티브 프롬프트**: `photorealistic face, messy, blurry, high contrast neon, harsh shadows, distorted geometry, ugly artifacts`

### 2. Modern Isometric Tech Vector (`isometric-clean-vector`)
- **특징**: Stripe/Vercel 풍의 정교한 아이소메트릭 벡터, 개발자 도구 및 마이크로서비스 아키텍처 다이어그램에 최적.
- **템플릿**:
  ```text
  Precision isometric vector illustration of [subject], crisp vector lines, minimal grid alignment, soft ambient occlusion, elegant muted color palette with a vibrant accent color, isolated on a neutral off-white background, Stripe-inspired modern developer aesthetic.
  ```

### 3. Soft Matte Claymorphism 3D (`claymorphism-3d-soft`)
- **특징**: 둥글고 친근한 3D 클레이 질감, 스튜디오 디퓨즈 조명과 부드러운 그림자.
- **템플릿**:
  ```text
  Cute tactile 3D claymorphic model of [subject], smooth matte finish, rounded organic forms, pastel clay textures, soft studio rim lighting, gentle ambient shadows, clean minimalist composition, high-end 3D product render.
  ```

### 4. Editorial Linocut & Woodblock Print (`editorial-linocut-woodblock`)
- **특징**: 목판화/리놀륨 판화 특유의 파인 칼선, 먹물 번짐과 거친 종이 질감, 문학 잡지 삽화 느낌.
- **템플릿**:
  ```text
  Artisanal hand-carved linocut print of [subject], expressive gouged lines, organic ink bleed textures, two-tone spot color on heavyweight warm fibrous paper, bold silhouette, literary magazine editorial illustration style.
  ```

### 5. Tactile Risograph Duotone (`risograph-duotone-retro`)
- **특징**: 레트로 2도 망점(Halftone) 인쇄, 미세한 인쇄 오차와 빈티지 질감.
- **템플릿**:
  ```text
  Authentic risograph print illustration of [subject], limited 2-color ink overlay (teal and warm coral), visible halftone dot patterns, subtle print misalignment, grainy riso paper texture, retro-modern graphic poster style.
  ```

### 6. Frosted Glassmorphism Abstract (`glassmorphism-frosted-tech`)
- **특징**: 반투명 아크릴/유리 패널의 미세한 굴절과 프리즘 색수차, 애플 키노트 풍 테크 애셋.
- **템플릿**:
  ```text
  Premium frosted glassmorphic 3D rendering of [subject], translucent acrylic glass panels with subtle chromatic aberration at the edges, soft inner refractions, floating geometric layers, gentle diffused backlight, clean dark titanium backdrop, Apple keynote aesthetics.
  ```

### 7. Minimalist Swiss Flat Geometric (`minimalist-flat-geometric`)
- **특징**: 바우하우스/스위스 국제 타이포그래피 스타일의 절제된 기하학적 면 분할과 볼드한 컬러 블록.
- **템플릿**:
  ```text
  Minimalist flat geometric vector artwork of [subject], disciplined grid structure, pure geometric primitives (circles, arcs, rectilinear blocks), high-contrast bold color blocking, generous negative space, International Typographic Style, iconic poster design.
  ```

### 8. Modern Watercolor & Fine Line (`watercolor-botanical-modern`)
- **특징**: 부드러운 수채화 번짐과 섬세한 펜 라인 콘투어, 코튼지 위의 유기적 감성.
- **템플릿**:
  ```text
  Modern botanical watercolor illustration of [subject], soft organic watercolor washes with natural pigment granulation, delicate thin ink line contouring, earthy muted tones with gentle sage and ochre accents, generous breathing room on white cold-press cotton paper.
  ```

---

## 🛠️ CLI 사용법

### 1. 전체 레시피 목록 확인
```bash
node scripts/loop/image-prompts.ts list
node scripts/loop/image-prompts.ts list --category illustration
node scripts/loop/image-prompts.ts list --tag paper-cut
node scripts/loop/image-prompts.ts list --json
```

### 2. 특정 레시피 상세 조회
```bash
node scripts/loop/image-prompts.ts get layered-paper-cut
```

### 3. 주제 치환 및 프롬프트 렌더링
`--subject`에 원하는 내용을 넣으면 템플릿의 `[subject]` 또는 `[원하는 사항 적기]`가 즉시 치환됩니다:
```bash
# 기본 렌더링
node scripts/loop/image-prompts.ts render layered-paper-cut --subject "a cozy digital reading room with floating books and a sleeping cat"

# JSON 출력 (스크립트 및 에이전트 도구 연동용)
node scripts/loop/image-prompts.ts render layered-paper-cut --subject "AI agent workflow engine" --json
```

### 4. 키워드 검색
```bash
node scripts/loop/image-prompts.ts search "pastel"
node scripts/loop/image-prompts.ts search "3d"
```

### 5. 신규 프롬프트 레시피 추가/등록
```bash
node scripts/loop/image-prompts.ts add \
  --id "cyberpunk-blueprint" \
  --name "Cyberpunk Technical Blueprint" \
  --category "vector" \
  --template "High-tech blueprint vector schematic of [subject], cyan and electric blue lines on dark grid canvas..." \
  --tags "blueprint,schematic,cyberpunk"
```

---

## 🤖 에이전트 워크플로우 연동

에이전트가 서비스 개발, 브랜딩, 또는 UI 화면 구현 중 이미지가 필요할 때:
1. `node scripts/loop/image-prompts.ts render layered-paper-cut --subject "<화면 주제>"` 명령을 통해 정밀 튜닝된 프롬프트를 획득합니다.
2. 획득한 프롬프트를 바탕으로 `generate_image` 도구를 호출하거나 `brand-assets`에 등록합니다.
3. 생성된 에셋은 `public/assets/` 등에 배치되어 서비스의 심미성을 일관되게 극대화합니다.
