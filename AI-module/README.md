# 공공 디지털 서비스 접근성 자동 평가 플랫폼

URL을 입력하면 웹페이지의 접근성을 자동으로 평가하고, 총점과 수정 가이드를 제공하는 플랫폼.

## 실행 방법

```bash
# 예시
cd graduation_project
python run_all.py https://www.gov.kr
```

이 한 줄이면 3개 모듈이 순서대로 실행되고, `output/result_final.json`에 최종 결과가 생성된다.

---

## 프로젝트 구조

```
graduation_project/
├── rule-based-analyzer/     # 모듈 1: 규칙 기반 코드 분석
├── text-level-analyzer/     # 모듈 2: 문장 난이도 + 수정 제안
├── cv-analyzer/             # 모듈 3: 시각 명암비 분석
├── output/                  # 결과 파일 (실행 시 자동 생성)
├── run_all.py               # 통합 실행기
├── .gitignore
└── README.md
```

---

## 모듈별 설명

### 모듈 1: rule-based-analyzer (규칙 기반 평가)

**언어:** Node.js  
**역할:** axe-core로 HTML DOM을 검사하고, WCAG 결과를 KWCAG 2.2 기준으로 매핑한 뒤 100점 감점 방식으로 점수를 산출한다.

| 파일 | 역할 |
|------|------|
| run.js | Playwright로 페이지를 열어 axe-core 검사 + DOM replay 저장. 통합 실행 시에만 CV 전용 임시 PNG 생성 |
| carousel-audit.js | Swiper/Slick/Splide/generic 캐러셀의 숨은 논리 슬라이드를 제한적으로 검사하고 결과 중복 제거 |
| artifact.js | typed locator를 만들고 annotation을 포함한 정적 DOM replay 직렬화 |
| adapter.js | axe-core 결과를 KWCAG 항목으로 매핑하는 어댑터 |
| mapping.js | KWCAG 33개 항목의 매핑 데이터 (axe 규칙 ID, 심각도, 가중치) |
| scorer.js | 100점 감점 방식 점수 계산 (심각도 × 가중치) |

**검사 예시:** 대체 텍스트 누락, heading 구조, 색 대비, 버튼 레이블 등 KWCAG 33개 항목

기준 상태의 axe 검사에 더해 캐러셀의 비기준 논리 슬라이드를 하나씩 임시로
활성화해 검사한다. clone은 제외하고 캐러셀 12개, 캐러셀당 20개 슬라이드,
추가 상태 60개를 기본 상한으로 둔다. 원 페이지의 style/ARIA/scroll/focus는
복원하며 클릭과 사용자 네트워크 동작은 수행하지 않는다. 저장된 `result.html`의
각 논리 슬라이드에는 `data-ua-audit-carousel-id`,
`data-ua-audit-slide-index`, `data-ua-audit-slide-count`가 남아 대시보드가
숨은 이슈의 `pathSteps`를 찾은 뒤 올바른 슬라이드로 전환할 수 있다.

---

### 모듈 2: text-level-analyzer (문장 난이도 분석)

**언어:** Python  
**역할:** 웹페이지 문장의 인지 난이도를 측정하고, 어려운 문장에 대한 수정 제안을 생성한다.

| 파일 | 역할 |
|------|------|
| text_extractor.py | HTML에서 분석 대상 텍스트를 추출하고 10개 카테고리로 분류 |
| difficulty_engine.py | MeCab 형태소 분석 기반 난이도 점수 산출 (평균 문장 길이, 평균 어절 길이, 고난이도 단어 비율, 위치 의존 표현) |
| suggestion_generator.py | 난이도 높은 문장에 대해 규칙 기반 + GPT-4o-mini 수정 제안 생성 |
| korean_vocab_grades.json | 한국어 학습용 어휘 모곡 (고난이도 단어 판별용) |

**분석 지표:** 평균 문장 길이(25어절 기준), 평균 어절 길이(4.5자 기준), 고난이도 어휘(40% 기준), 위치 의존 표현 탐지

---

### 모듈 3: cv-analyzer (시각 명암비 분석)

**언어:** Python  
**역할:** 스크린샷에서 OCR로 텍스트를 추출하고, 각 텍스트와 배경의 명암비를 WCAG 기준으로 측정한다.

| 파일 | 역할 |
|------|------|
| vision_ocr.py | Google Vision API로 이미지 내 텍스트 + 위치(바운딩박스) 추출. MD5 캐시로 중복 API 호출 방지 |
| contrast_analyzer.py | WCAG 명암비 공식으로 전경색/배경색 대비 계산 + AA/AAA 판정 + 수정 색상 추천 |
| cv_runner.py | OCR → 명암비 분석 → 결과 JSON 출력 통합 실행기 |

**검사 기준:** KWCAG 5.3.3 콘텐츠의 명도 대비 (AA 기준 4.5:1, 큰 텍스트 3.0:1)

---

## 실행 파이프라인

```
python run_all.py <URL>

  Step 1: [Node.js] 규칙 기반 평가     → result.json, result_api.json, result.html, result_artifact.json
  Step 2: [Python]  텍스트 추출        → result_text.json
  Step 3: [Python]  난이도 분석        → result_text_difficulty.json
  Step 4: [Python]  LLM 수정 제안      → result_text_suggestions.json
  Step 5: CV 명암비 분석               → 전용 임시 PNG 사용 후 즉시 삭제
  Step 6: 결과 통합 + 총점 계산        → result_final.json
  Step 7: 백엔드 전송                  → 평가 JSON 저장 후 DOM replay multipart 업로드
```

모든 결과 파일은 `output/` 폴더에 저장된다.

---

## 총점 계산 방식

```
정상 실행: 총점 = (규칙 기반 점수 × 50%) + (난이도 page_score × 30%) + (CV pass_rate × 20%)
```

| 모듈 | 가중치 | 점수 체계 | 근거 |
|------|--------|-----------|------|
| 규칙 기반 | 50% | 100점 감점 방식 | KWCAG 33개 항목 대부분 커버 |
| 난이도 분석 | 30% | 100점 감점 방식(높을수록 좋음) | 콘텐츠 품질 평가 |
| CV 시각 분석 | 20% | OCR 명암비 통과율 | 이미지·캔버스 렌더링 텍스트 보완 |

`run_all.py`가 만드는 PNG는 CV 프로세스에만 전달되는 OS 임시 파일이다. `output/`에
저장하거나 백엔드에 올리지 않으며, CV 성공·실패와 관계없이 즉시 삭제한다. CV가
실제로 실패한 경우에만 기존 부분 실패 규칙에 따라 남은 모듈 가중치를 재분배한다.

등급 기준: A+(95↑), A(90↑), B+(85↑), B(80↑), C(70↑), D(60↑), F(60미만)

---

## 백엔드 연동

### 백엔드가 받는 것

평가 JSON을 먼저 저장한 뒤, 같은 렌더 시점의 페이지 증적을 별도 업로드한다.

1. `result_final.json`: 점수, 규칙, 이슈, typed locator
2. `result_artifact.json` + `result.html`: 렌더 메타데이터와 UTF-8 정적 DOM replay

증적 업로드 실패는 이미 저장된 평가 JSON을 롤백하거나 재전송하지 않는다.

### result_final.json 구조

```json
{
  "url": "https://www.gov.kr",
  "analyzed_at": "2026-05-11T23:42:27",
  "elapsed_seconds": 13.31,
  "total_score": 94.2,
  "grade": "A",

  "score_breakdown": {
    "module_scores": {
      "rule_based": 95.0,
      "difficulty": 100.0,
      "cv": 83.3
    },
    "weights_applied": {
      "rule_based": 50.0,
      "difficulty": 30.0,
      "cv": 20.0
    }
  },

  "modules": {
    "rule_based": { ... },         // 규칙 기반 상세 결과 (위반 항목, 점수 등)
    "text_difficulty": { ... },    // 난이도 분석 상세 (블록별 점수, 지표별 점수)
    "text_suggestions": { ... },   // 수정 제안 (블록별 원문 + 수정안)
    "cv_visual": { ... }           // CV 분석 상세 (위반 텍스트, 명암비, 수정 추천 색상)
  }
}
```

### 백엔드 API 엔드포인트 (제안)

```
POST /api/v1/evaluations
Body: result_final.json 전체

Response: { "evaluation_id": "...", "status": "saved" }

POST /api/v1/evaluations/{requestId}/artifact
Content-Type: multipart/form-data
Parts:
  metadata (application/json): result_artifact.json
  document (text/html; charset=utf-8): result.html
```

`result_artifact.json` 계약:

```json
{
  "requestedUrl": "https://example.test",
  "finalUrl": "https://example.test/",
  "capturedAt": "2026-08-11T18:30:00.000",
  "viewportWidthCssPx": 1280,
  "viewportHeightCssPx": 720,
  "deviceScaleFactor": 1,
  "pageWidthCssPx": 1280,
  "pageHeightCssPx": 4200,
  "captureMode": "DOM_REPLAY"
}
```

규칙 기반 위반 노드는 기존 `selector`, `html`과 함께 아래 locator를 가진다.

```json
{
  "kind": "DOM_RECT",
  "pathSteps": [
    { "context": "DOCUMENT", "selector": "iframe#content", "frameUrl": "https://example.test/frame" },
    { "context": "FRAME", "selector": "my-widget", "frameUrl": "https://example.test/frame" },
    { "context": "SHADOW_ROOT", "selector": "button.submit", "frameUrl": "https://example.test/frame" }
  ],
  "x": 120,
  "y": 840,
  "width": 160,
  "height": 48,
  "coordinateSpace": "DOCUMENT_CSS_PX",
  "visible": true,
  "htmlSnippet": "<button class=\"submit\">...</button>"
}
```

`captureMode`는 항상 `DOM_REPLAY`다. locator 좌표는 분석 당시 문서의 CSS 좌표이며
더 이상 스크린샷 높이/타일로 잘리지 않는다. 재현 화면에서는 `pathSteps`로 요소를
다시 찾은 뒤 현재 `getBoundingClientRect()`를 우선 사용하고, 저장 좌표는 초기 위치
힌트로만 사용한다. 저장 HTML에는 실행 가능한 script/inline handler/meta refresh를
제거하고 원본 base URL을 넣어 상대 CSS·이미지 경로를 재현한다.

초기 2xx 페이지가 5초 뒤 교차 출처 봇/보안 챌린지로 바뀐 경우에만 최초 응답 HTML을
스크립트 없이 정적으로 다시 열어 분석한다. 이 제한적 fallback은 로그와 HTML의
`data-accessibility-replay-source="INITIAL_RESPONSE_STATIC"` 표식으로 드러나며,
CAPTCHA 우회나 `navigator.webdriver` 위장은 수행하지 않는다.

### 프론트엔드에 내려줄 때

대시보드에 필요한 데이터는 전부 `result_final.json` 안에 있음:
- 총점/등급 → `total_score`, `grade`
- 모듈별 점수 → `score_breakdown.module_scores`
- 위반 항목 리스트 → `modules.rule_based.violations`
- 수정 가이드 → `modules.text_suggestions`
- 명암비 위반 → `modules.cv_visual.violations`

---

## 중간 결과 파일 참고

디버깅이나 점수 추적용. 그냥 참고용

| 파일 | 내용 |
|------|------|
| result.json | axe-core 원본 결과 + KWCAG 매핑 |
| result_api.json | 규칙 기반 결과 API 스펙 형태 |
| result.html | 스크립트를 제거한 UTF-8 DOM replay (텍스트 추출 + 대시보드 렌더 입력) |
| result_artifact.json | 요청/최종 URL, 뷰포트, 문서 크기, `DOM_REPLAY` 메타데이터 |
| result_text.json | 추출된 텍스트 블록 (카테고리별 분류) |
| result_text_difficulty.json | 블록별 난이도 점수 상세 |
| result_text_suggestions.json | 블록별 수정 제안 |
| result_cv.json | CV 텍스트별 명암비 + 수정 추천 색상 (입력 이미지 경로 미포함) |
| result_final.json | 최종 통합 결과 (백엔드 전송용) |

---

## 환경 설정

### 필수 설치

```bash
# Node.js 패키지 (rule-based-analyzer 폴더에서)
npm install

# Python 패키지
pip install beautifulsoup4 mecab-python3 python-dotenv openai Pillow google-cloud-vision
```

### API 키 설정

- **OpenAI API 키:** `text-level-analyzer/.env` 파일에 `OPENAI_API_KEY=sk-...`
- **Google Vision API 키:** `cv-analyzer/uniaccess-*.json` (서비스 계정 키)
- **MeCab 사전:** `C:\mecab\share\mecab-ko-dic\`에 한국어 사전 설치

이 파일들은 `.gitignore`에 포함되어 있으므로 각자 로컬에 설정해야 한다.
