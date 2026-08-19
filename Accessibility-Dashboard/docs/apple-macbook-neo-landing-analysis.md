# Apple UK MacBook Neo 랜딩 단일 페이지 분석

![검증된 Apple UK MacBook Neo 전체 페이지 캡처](../.firecrawl/apple-macbook-neo/full-page.png)

> 이 문서는 제3자 페이지를 분석 증거로만 사용한다. Apple의 상표, 제품 이미지, 문구, 그래픽과 고유 레이아웃을 UniAccess 제품 자산으로 복사하거나 재사용하지 않는다.

## Source와 증거

- Source URL: https://www.apple.com/uk/macbook-neo/
- Capture date: 2026-07-28
- 수집 범위: 위 URL 한 페이지의 Firecrawl `scrape`만 사용. 사이트 crawl 및 다른 URL 수집 없음.
- 실행 환경: 설치된 Firecrawl CLI 1.19.27, 기존 인증 안전 재사용, UK/영어 입력(`country=GB`, `languages=en`)

| 증거 | 검증 상태 |
|---|---|
| `.firecrawl/apple-macbook-neo/branding-images.json` | 69,945바이트, JSON parser 통과, 최상위 `branding`, `metadata`, `images`; 이미지 참조 487개 |
| `.firecrawl/apple-macbook-neo/full-page.png` | 3,858,195바이트, PNG signature 통과, 1920×28,034 |
| `.firecrawl/apple-macbook-neo/page.md` | 66,387바이트, 비어 있지 않음, 페이지 제목·섹션·CTA·내비게이션 포함 |
| `.firecrawl/apple-macbook-neo/command-summary.json` | 안전한 명령·exit code·소요시간·제약 기록, 비밀값 및 서명 URL 없음 |

표기 규칙:

- **Observed / 높음**: 로컬 screenshot, JSON 또는 Markdown에서 직접 확인.
- **Observed / 중간**: extractor가 구조화했으나 화면의 모든 상태를 대표하지 않을 수 있음.
- **Inferred / 중간·낮음**: 단일 desktop 정지 화면을 바탕으로 한 합리적 추정이며 구현 전 확인 필요.

## 한눈에 보는 디자인 언어

- **Observed / 높음:** 흰 바탕, 짙은 중성 텍스트, 대형 제품 렌더, 넓은 여백, 짧은 헤드라인을 중심으로 긴 페이지를 단계적으로 전개한다.
- **Observed / 높음:** 제품의 기능을 사양표보다 사용 장면·화면 예시·제품 클로즈업으로 설명한다.
- **Observed / 높음:** 대부분의 페이지는 절제된 무채색이지만 제품 색상, AI 그라디언트, macOS 전면 배경 같은 국소적 컬러 장면이 리듬을 만든다.
- **Inferred / 중간:** 핵심 감정은 “가볍고 친근한 입문 제품”이며, 화면 밀도보다 한 번에 하나의 메시지에 집중하도록 설계됐다.

## 전체 섹션 순서

1. **Observed / 높음:** Apple 글로벌 내비게이션
2. **Observed / 높음:** MacBook Neo 로컬 내비게이션 — Overview, Tech Specs, Compare, Switch from PC to Mac, Buy
3. **Observed / 높음:** 금융 안내 스트립
4. **Observed / 높음:** Hero — 제품명, “Hello, Neo.”, Buy, 가격, 손 위에 놓인 노트북 렌더
5. **Observed / 높음:** Get the highlights — 색상·성능·디스플레이·AI·Mac+iPhone·macOS·보안 하이라이트
6. **Observed / 높음:** Love at first Mac — 입문 제품 포지셔닝, 짧은 film CTA, 여러 색상의 제품 렌더
7. **Observed / 높음:** Take a closer look — 대형 제품 측면 뷰와 AR 성격의 CTA
8. **Observed / 높음:** Performance — 생산성, 학업, 업무, 엔터테인먼트, 칩, 휴대성 사례
9. **Observed / 높음:** Display, Camera and Audio — 디스플레이 수치, 영상·카메라·마이크/스피커 사례
10. **Observed / 높음:** AI — 앱 화면, Apple Intelligence, 개인정보 보호 설명
11. **Observed / 높음:** macOS — 보라·초록 계열 전면 그래픽과 운영체제 메시지
12. **Observed / 높음:** Mac + iPhone — 기기 연속성 기능과 제품 조합
13. **Observed / 중간:** New to Mac — 입문자를 위한 기능 카드/슬라이드
14. **Observed / 중간:** Privacy and Security — 보안 기능 카드
15. **Observed / 중간:** Why Apple is the best place to buy Mac — 금융·보상 판매·교육·설정·배송·스토어 앱
16. **Observed / 중간:** Keep exploring Mac — 제품 비교/탐색
17. **Observed / 높음:** 환경 지표 — 재활용 소재, 재생 전력, 섬유 기반 포장
18. **Observed / 높음:** Values — 환경, 개인정보, 접근성
19. **Observed / 높음:** 법적 고지와 다단 footer

## Hero 구성

- **Observed / 높음:** 상단 3단 구조는 글로벌 nav → 제품 local nav → 프로모션 스트립이다.
- **Observed / 높음:** Hero는 중앙 정렬된 제품명과 짧은 인사형 헤드라인, 검정 pill Buy 버튼, 가격, 대형 제품 렌더 순이다.
- **Observed / 높음:** 사람 손과 노트북을 결합해 얇고 가벼운 물성을 전달한다. 배경 장식은 최소화한다.
- **Inferred / 중간:** desktop hero 콘텐츠 폭은 약 980~1,200px, 제품 이미지는 viewport 너비의 약 45~60% 범위로 보인다.
- **Inferred / 중간:** 텍스트보다 제품 렌더가 가장 큰 시각 면적을 차지하며 첫 화면의 초점은 하나다.

## 내비게이션과 CTA

### 글로벌/로컬 내비게이션

- **Observed / 높음:** 글로벌 nav는 얇고 조밀한 단일 행이며 Apple 전체 제품군, 검색, 장바구니 진입을 제공한다.
- **Observed / 높음:** local nav는 왼쪽 제품명, 오른쪽 정보 링크와 Buy 버튼을 둔다.
- **Inferred / 중간:** local nav는 스크롤 시 sticky로 유지될 가능성이 높지만 정지 screenshot만으로 확정할 수 없다.

### CTA 계층

- **Observed / 높음:** 주요 CTA는 검정 배경/흰 글자의 pill형 `Buy`.
- **Observed / 높음:** 보조 행동은 파란 텍스트 링크 또는 밝은 배경 pill이며 `Shop`, `Watch the film`, `View in your space`, `Learn more`처럼 짧다.
- **Observed / 높음:** 링크는 설명 문장 뒤에 배치되고, 구매·탐색·영상·AR처럼 행동 목적이 분명하다.
- **Inferred / 중간:** hover는 색 변화 또는 약한 underline/opacity 전환일 가능성이 있으나 수집 증거로는 확인되지 않는다.

## 디자인 토큰

### 색상

Firecrawl branding extractor의 구조화 값:

| 역할 | 값 | 근거 |
|---|---|---|
| Primary action | `#0071E3` | **Observed / 중간**, branding JSON |
| Secondary blue | `#2997FF` | **Observed / 중간**, branding JSON |
| Link | `#0066CC` | **Observed / 중간**, branding JSON |
| Main text/accent | `#1D1D1F` | **Observed / 높음**, JSON과 screenshot 일치 |
| Background | `#FFFFFF` | **Observed / 높음** |
| Subtle surface | `#F5F5F7` | **Observed / 중간**, secondary component |
| Muted dark text | `#333336` | **Observed / 중간**, component extraction |

- **Observed / 높음:** 제품 색상과 기능별 강조 문구에 citrus/green, blush/pink, indigo/blue, purple이 제한적으로 사용된다.
- **Inferred / 낮음:** screenshot에서 보이는 chartreuse, magenta, violet의 정확한 hex는 이미지·영상 색보정의 영향을 받으므로 토큰으로 직접 채택하지 않는다.
- **Observed / 높음:** macOS 섹션은 보라·초록 그라디언트와 어두운 overlay 위 흰 텍스트로 앞뒤의 흰 섹션과 강한 대비를 만든다.

### Typography

- **Observed / 중간:** heading은 `SF Pro Display`, body는 `SF Pro Text`; fallback은 `Helvetica Neue`, Helvetica, Arial, sans-serif.
- **Observed / 중간:** extractor 표본은 h1 28px, h2 12px, body 14px를 보고했으나 이는 local nav/작은 표본의 영향이 커 전체 페이지 척도로 사용하기 어렵다.
- **Inferred / 중간:** 실제 desktop hero·대표 섹션 제목은 약 64~96px, 주요 섹션 제목은 48~72px, 카드 제목은 24~40px, 본문은 16~21px 범위로 보인다.
- **Observed / 높음:** 제목은 굵은 600~700 weight와 조밀한 line-height, 본문은 400~500 weight와 상대적으로 넉넉한 line-height를 사용한다.
- **Inferred / 중간:** 권장 근사 line-height는 display 0.95~1.05, heading 1.05~1.15, body 1.4~1.55다.

### Spacing, container, grid

- **Observed / 중간:** extractor base unit은 4px이다.
- **Observed / 높음:** section 사이에는 화면 높이에 가까운 큰 간격도 사용하며, 정보가 많아질 때도 한 구간의 메시지 수를 제한한다.
- **Inferred / 중간:** 기본 spacing scale은 4/8/12/16/24/32/48/64/96/128px로 모델링할 수 있다.
- **Inferred / 중간:** 핵심 container는 약 1,200px, 설명형 본문은 약 680~900px, full-bleed 미디어는 viewport 폭을 사용한다.
- **Observed / 높음:** 기능 사례는 2열 또는 엇갈린 제품 이미지+텍스트 구성이고, 구매 혜택은 반복 카드 grid다.

### Radius, border, shadow

- **Observed / 중간:** extractor 기본 radius는 6px, 버튼은 `980px`로 사실상 pill이다.
- **Inferred / 중간:** 대형 highlight/미디어 카드의 시각 radius는 약 18~28px로 보인다.
- **Observed / 높음:** 굵은 border나 강한 drop shadow는 거의 없고, surface 차이와 충분한 여백으로 층위를 만든다.
- **Inferred / 중간:** 카드 경계는 1px 중성선 또는 매우 약한 shadow 정도로 제한하는 것이 근접한 원칙이다.

## 이미지와 제품 렌더링

- **Observed / 높음:** `images` 형식은 487개 참조를 반환했으며 486개가 Apple 호스트다. 확장자는 JPG 437, PNG 48, 기타 2다.
- **Observed / 높음:** hero, 색상 fan, 손과 제품, 제품 측면, 노트북 화면 합성, 생활 사진, 기능 UI, 기기간 조합 이미지를 혼합한다.
- **Observed / 높음:** 제품 cutout은 대부분 흰 배경에서 그림자를 최소화하고, 생활 사진은 둥근 직사각형 frame 안에 배치한다.
- **Observed / 높음:** 디바이스 화면 콘텐츠는 기능 설명의 실제 증거처럼 사용되고, 수치·짧은 문장과 가까이 배치된다.
- **Inferred / 중간:** 여러 이미지가 스크롤 진행에 맞춰 교체·확대되는 장면일 수 있으나 정지 캡처는 그 시간축을 보존하지 않는다.

## 컴포넌트

- **Observed / 높음:** global nav, local nav, 프로모션 스트립, primary/secondary pill CTA
- **Observed / 높음:** clipped-next-card가 보이는 horizontal highlights carousel
- **Observed / 높음:** large media stage, feature vignette, product+copy split row
- **Observed / 높음:** 숫자 중심 metric block, 기능 UI card, 구매 혜택 card
- **Observed / 중간:** carousel pagination dots와 이전/다음 원형 control
- **Observed / 높음:** 제품 비교 영역과 다단 footer
- **Inferred / 중간:** mobile에서는 일부 grid가 horizontal snap carousel 또는 단일 열 stack으로 바뀔 가능성이 높다.

## Sticky, scroll, motion, interaction

- **Observed / 높음:** screenshot에 carousel control과 일부 다음 카드 노출이 있어 수평 탐색 affordance가 확인된다.
- **Observed / 중간:** 긴 screenshot의 일부 하단 섹션은 매우 흐리거나 비어 있다. scroll-triggered reveal 또는 lazy rendering이 full-page stitch 중 완전히 활성화되지 않은 정황이다.
- **Inferred / 중간:** 제품 이미지의 scale/translate, section 진입 fade, sticky media, carousel snap이 사용될 가능성이 높다.
- **Inferred / 낮음:** easing과 duration은 측정되지 않았다. 구현 시 200~400ms UI 전환과 더 느린 600~1,000ms editorial reveal을 출발점으로 삼되 `prefers-reduced-motion`을 우선한다.

## Desktop에서 mobile로의 반응형 추정

- **Inferred / 중간:** 글로벌 nav는 compact menu로, local nav 링크는 축약 또는 가로 스크롤로 전환된다.
- **Inferred / 중간:** hero 제품 이미지는 viewport에 맞춰 축소되고 텍스트·CTA는 중앙 정렬을 유지한다.
- **Inferred / 중간:** 2열 feature row와 구매 혜택 grid는 단일 열로 전환된다.
- **Inferred / 중간:** highlights는 한 장+다음 장 일부가 보이는 horizontal snap carousel이 된다.
- **Inferred / 중간:** display heading은 `clamp()`로 축소하고 48~96px desktop 범위를 약 36~56px mobile 범위로 낮추는 것이 안전하다.
- **Inferred / 중간:** full-bleed 이미지는 crop focal point를 보존하고, 기능 UI 이미지는 가로 overflow보다 container 내 scale을 우선한다.

## UniAccess에 복사 없이 적용 가능한 원칙

1. **Observed에서 일반화 / 높음:** 첫 화면은 하나의 가치 제안, 하나의 핵심 CTA, 하나의 대표 시각물에 집중한다.
2. **Observed에서 일반화 / 높음:** 기능 목록보다 실제 사용자 과업과 결과 장면을 먼저 보여준다.
3. **Observed에서 일반화 / 높음:** 긴 페이지를 “한 섹션 한 주장”으로 분리하고 넓은 여백으로 호흡을 만든다.
4. **Observed에서 일반화 / 높음:** 중립 surface를 기본으로 하고 의미 있는 상태·카테고리에만 색을 쓴다.
5. **Observed에서 일반화 / 중간:** 핵심 수치는 짧은 label과 큰 숫자로, 근거·조건은 가까운 작은 텍스트로 연결한다.
6. **Inferred / 중간:** UniAccess의 실제 분석 결과 화면, 접근성 개선 전후, 사용자 시나리오를 제품 렌더 대신 독자적인 증거 이미지로 사용한다.
7. **Inferred / 높음:** motion은 정보 이해를 보조해야 하며 reduced-motion과 키보드 탐색을 기본 요구사항으로 둔다.
8. **Inferred / 높음:** 구매 local nav 패턴을 그대로 복제하지 말고 UniAccess의 “서비스 개요/작동 방식/결과 예시/문의” 정보 구조로 재설계한다.

## 직접 복제하면 안 되는 것

- Apple, MacBook Neo, macOS, Apple Intelligence 등의 상표·명칭·로고
- 수집된 Apple 제품 렌더, 사진, UI 화면, 아이콘, 영상 frame
- “Hello, Neo.” 등 고유 카피와 문장 리듬의 직역·변형
- 손 위 제품 hero, 색상 fan, Apple 기기간 조합 등 식별력 높은 구성의 직접 재현
- Apple global/local nav, Buy pill, 긴 섹션 배열을 픽셀 단위로 복제한 레이아웃
- Apple 전용 SF Pro 배포를 전제로 한 구현. UniAccess가 사용할 수 있는 라이선스 적합 글꼴로 대체한다.

## 현 DESIGN.md와 나중에 비교할 토큰 초안

아래는 전환 검토용 초안이며 현재 `DESIGN.md`에 적용하지 않았다.

```css
--ua-space-1: 4px;
--ua-space-2: 8px;
--ua-space-3: 12px;
--ua-space-4: 16px;
--ua-space-6: 24px;
--ua-space-8: 32px;
--ua-space-12: 48px;
--ua-space-16: 64px;
--ua-space-24: 96px;

--ua-container-editorial: 1200px;
--ua-container-reading: 760px;
--ua-radius-control: 8px;
--ua-radius-card: 24px;
--ua-radius-pill: 999px;

--ua-font-display: clamp(3rem, 7vw, 5.5rem);
--ua-font-section: clamp(2.25rem, 5vw, 4rem);
--ua-font-card-title: clamp(1.5rem, 3vw, 2.5rem);
--ua-font-body: clamp(1rem, 1.5vw, 1.25rem);
--ua-leading-display: 1.02;
--ua-leading-body: 1.5;
```

- **Inferred / 높음:** 색상은 Apple hex를 그대로 채택하지 말고 현 UniAccess 브랜드 대비 기준과 WCAG를 기준으로 별도 매핑한다.
- **Inferred / 높음:** `surface/default`, `surface/subtle`, `text/strong`, `text/muted`, `action/primary`, `focus`, `success/warning/error`의 semantic role을 먼저 비교한다.

## 단계적 적용 우선순위

1. **P0:** 현 `DESIGN.md`와 위 semantic token/spacing/type scale의 차이만 비교한다. 아직 코드에 적용하지 않는다.
2. **P1:** UniAccess 고유 카피로 hero 정보 계층과 CTA 수를 정리한다.
3. **P2:** 분석 전후·실제 과업·신뢰 지표를 독자적인 feature vignette와 metric block으로 설계한다.
4. **P3:** 카드 grid, horizontal highlights, responsive container를 접근성 우선으로 검증한다.
5. **P4:** scroll motion은 별도 프로토타입에서 reduced-motion, 키보드, screen reader와 함께 검증한다.

## CLI·동적 렌더링 한계

- **Observed / 높음:** branding+images scrape와 JSON full-page screenshot scrape는 성공했다.
- **Observed / 높음:** CLI 1.19.27에서 `--full-page-screenshot --output ...png`는 PNG 대신 Markdown을 저장했다. 해당 결과는 `page.md`로 보존했다.
- **Observed / 높음:** `--format screenshot`과 `--full-page-screenshot` 동시 지정은 “screenshot 형식을 하나만 지정” 오류로 exit 1이었다.
- **Observed / 높음:** `--full-page-screenshot --json`은 `markdown`, `screenshot`, `metadata`를 반환했고 screenshot URL은 메모리에서만 사용해 로컬 PNG로 다운로드했다.
- **Observed / 중간:** 전체 screenshot의 흐린/빈 구간은 Apple의 lazy load, scroll reveal, stitch timing의 영향을 받았을 수 있다.
- **Inferred / 중간:** cookie 동의 상태, 캠페인, UK 가격, 지역화, viewport에 따라 다른 사용자가 보는 페이지와 일부 차이가 날 수 있다.
- **Observed / 높음:** 단일 1920px desktop 캡처이므로 mobile, hover, focus, sticky, 실제 animation timing은 검증되지 않았다.

## 범위 무결성

- **Observed / 높음:** 이 work item이 쓴 경로는 `.firecrawl/apple-macbook-neo/**`와 이 분석 문서뿐이다.
- **Observed / 높음:** Dashboard 외부는 실행 전후 5,603개/299,706,143바이트이며 메타데이터 지문 `901268b54eeac016d5c247f8b56aa50cbe6c7603d7e9bef57f7f8b46ba99be71`로 일치한다. 백엔드와 외부 디렉터리 변경은 없다.
- **Observed / 높음:** 작업 시간 동안 `DESIGN.md`, `package.json`, CSS 3개는 수정시각 변화가 없다.
- **Observed / 높음:** 동시 작업으로 `src/App.tsx`, `src/components/dashboard/shared/use-dashboard-controller.tsx`, `src/components/dashboard/sidebar-demo.tsx`, `scripts/verify-accessibility-p0.mjs`의 변경이 감지됐다. 이 work item은 해당 파일을 쓰거나 되돌리지 않았다. 따라서 “앱 코드 전체가 전역적으로 불변”이라고는 주장하지 않으며, 변경 주체는 확인되지 않았다.

## 비밀 제외 재현 입력

```text
workflow: firecrawl-website-design-clone
source_url: https://www.apple.com/uk/macbook-neo/
scope: one-page scrape only
primary_formats: branding,images
screenshot: full-page via JSON response, remote URL kept in memory only
supplement: page Markdown from the same URL
country: GB
languages: en
output_root: .firecrawl/apple-macbook-neo/
analysis_output: docs/apple-macbook-neo-landing-analysis.md
```

다음 허용 단계는 이 초안을 현재 `DESIGN.md`와 읽기 전용으로 비교해 충돌·재사용 가능 토큰을 표로 만드는 것까지다.
