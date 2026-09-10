# 공공 디지털 서비스 접근성 자동 평가 플랫폼

URL을 입력하면 웹페이지의 접근성을 자동으로 평가하고, 총점과 수정 가이드를 제공하는 플랫폼.

## 실행 방법

```powershell
# Windows PowerShell (환경 설정 완료 후)
cd AI-module
.\.venv\Scripts\python run_all.py https://www.gov.kr

# macOS/Linux
# cd AI-module && .venv/bin/python run_all.py https://www.gov.kr
```

이 한 줄이면 3개 모듈이 순서대로 실행되고, `output/result_final.json`에 최종 결과가 생성된다.

---

## 프로젝트 구조

```
AI-module/
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
| run.js | Playwright로 페이지를 열어 axe-core 검사 + 내부 분석용 DOM snapshot 저장. 통합 실행 시에만 CV 전용 임시 PNG 생성 |
| carousel-audit.js | Swiper/Slick/Splide/generic 캐러셀의 숨은 논리 슬라이드를 제한적으로 검사하고 결과 중복 제거 |
| artifact.js | typed locator를 만들고 annotation을 포함한 내부 분석용 DOM snapshot 직렬화 |
| adapter.js | axe-core 결과를 KWCAG 항목으로 매핑하는 어댑터 |
| mapping.js | KWCAG 33개 항목의 매핑 데이터 (axe 규칙 ID, 심각도, 가중치) |
| scorer.js | 100점 감점 방식 점수 계산 (심각도 × 가중치) |

**검사 예시:** 대체 텍스트 누락, heading 구조, 색 대비, 버튼 레이블 등 KWCAG 33개 항목

KWCAG에 매핑되지 않은 규칙 위반도 `unmapped_violations`에 규칙 ID와 노드별
selector·HTML·locator를 보존하고 백엔드 이슈로 저장한다. 실제 axe 규칙 ID를 유지하며,
위치 정보를 찾지 못한 문제도 결과 목록에서 확인할 수 있다.

기준 상태의 axe 검사에 더해 캐러셀의 비기준 논리 슬라이드를 하나씩 임시로
활성화해 검사한다. clone은 제외하고 캐러셀 12개, 캐러셀당 20개 슬라이드,
추가 상태 60개를 기본 상한으로 둔다. 원 페이지의 style/ARIA/scroll/focus는
복원하며 클릭과 사용자 네트워크 동작은 수행하지 않는다. 숨은 슬라이드에서 발견한
이슈에도 typed locator와 carousel context를 남겨 현재 페이지에서 요소를 다시 찾을
수 있게 한다. `result.html`의 annotation은 로컬 분석과 진단에만 사용한다.

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

**검사 기준:** KWCAG 5.4.3 텍스트 콘텐츠의 명도 대비 (AA 기준 4.5:1, 큰 텍스트 3.0:1)

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
  Step 7: 백엔드 전송                  → capture metadata를 포함한 평가 JSON을 한 번 저장
```

모든 결과 파일은 `output/` 폴더에 저장된다.

외부 명령의 기본 제한 시간은 120초이며, 느린 공공 사이트의 로딩·정적 fallback·axe 검사를
포함하는 규칙 기반 Step 1만 240초까지 기다린다. 제한 시간을 넘기면 Windows에서는
해당 프로세스 트리, macOS/Linux에서는 별도 프로세스 그룹을 종료해 Chromium 자식
프로세스가 남지 않게 한다.

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
실패했거나 측정한 텍스트가 0개이면 CV를 총점에서 제외하고 남은 모듈 가중치를
재분배한다. 텍스트를 실제로 측정한 뒤 통과율이 0%인 경우는 CV 0점으로 합산한다.
미측정 결과에는 이유를 남기고, 백엔드는 CV 점수를 `null`, 상태를 `NOT_MEASURED`로
저장한다. 실행 실패는 `FAILED`, 실제 측정 점수는 `SUCCESS`로 구분한다. 과거 기록의
상태가 `null`이면 당시 측정 여부를 확인할 수 없다는 뜻이며 기존 0점을 일괄 변경하지 않는다.
현재 실행에서 생성되고 계약 검증을 통과한 규칙 기반 결과와 capture metadata는 완료 저장의
필수 조건이며, 규칙 기반 단계가 실패하면 난이도/CV 결과만으로 완료 처리하지 않는다.

등급 기준: A+(95↑), A(90↑), B+(85↑), B(80↑), C(70↑), D(60↑), F(60미만)

---

## 백엔드 연동

### 백엔드가 받는 것

백엔드는 `result_final.json` 한 번만 받는다. 점수, 규칙, 이슈, typed locator와
라이브 화면 정렬에 필요한 `capture_metadata`가 모두 이 JSON에 포함된다.
`result.html`은 문장 난이도 추출을 위한 로컬 중간 파일이며 외부로 전송하지 않는다.

### result_final.json 구조

```json
{
  "url": "https://www.gov.kr",
  "analyzed_at": "2026-05-11T23:42:27",
  "elapsed_seconds": 13.31,
  "capture_metadata": {
    "requestedUrl": "https://www.gov.kr",
    "finalUrl": "https://www.gov.kr/portal/main",
    "capturedAt": "2026-08-11T18:30:00.000",
    "viewportWidthCssPx": 1280,
    "viewportHeightCssPx": 720,
    "deviceScaleFactor": 1,
    "pageWidthCssPx": 1280,
    "pageHeightCssPx": 4200
  },
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
```

`result_final.json.capture_metadata` 계약 (`result_artifact.json`에서 통합):

```json
{
  "requestedUrl": "https://example.test",
  "finalUrl": "https://example.test/",
  "capturedAt": "2026-08-11T18:30:00.000",
  "viewportWidthCssPx": 1280,
  "viewportHeightCssPx": 720,
  "deviceScaleFactor": 1,
  "pageWidthCssPx": 1280,
  "pageHeightCssPx": 4200
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

`finalUrl`은 규칙 기반 분석이 실제로 완료된 HTTPS 문서 URL과 일치해야 하며,
라이브 게이트웨이가 받을 수 있도록 fragment를 제외한다. locator 좌표는 분석 당시
문서의 CSS 좌표이며 스크린샷 높이/타일로
잘리지 않는다. 라이브 화면에서는 `pathSteps`로 요소를 다시 찾은 뒤 현재
`getBoundingClientRect()`를 우선 사용하고, 저장 좌표는 초기 위치 힌트로만 사용한다.
로컬 `result.html`에는 실행 가능한 script/inline handler/meta refresh를 제거하고
원본 base URL을 넣어 텍스트 추출 시 상대 CSS·이미지 경로를 해석할 수 있게 한다.

초기 2xx 페이지가 5초 뒤 교차 출처 봇/보안 챌린지로 이동하거나, 같은 URL에서
BotManager 전용 `#bm-wait-background`와 `#loading-overlay`가 표시되고 그 밖의 본문이
보이지 않는 경우 최초 응답 HTML을
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
- 분석 당시 화면 크기 → `capture_metadata`

---

## 중간 결과 파일 참고

디버깅이나 점수 추적용. 그냥 참고용

| 파일 | 내용 |
|------|------|
| result.json | axe-core 원본 결과 + KWCAG 매핑 |
| result_api.json | 규칙 기반 결과 API 스펙 형태 |
| result.html | 스크립트를 제거한 UTF-8 DOM snapshot (로컬 텍스트 추출 입력, 외부 미전송) |
| result_artifact.json | 최종 JSON의 `capture_metadata`로 통합할 URL·뷰포트·문서 크기 |
| result_text.json | 추출된 텍스트 블록 (카테고리별 분류) |
| result_text_difficulty.json | 블록별 난이도 점수 상세 |
| result_text_suggestions.json | 블록별 수정 제안 |
| result_cv.json | CV 텍스트별 명암비 + 수정 추천 색상 (입력 이미지 경로 미포함) |
| result_final.json | 최종 통합 결과 (백엔드 전송용) |

---

## 환경 설정

### 필수 설치

```bash
# AI-module 폴더에서 Python 가상 환경 생성
python -m venv .venv

# Windows PowerShell
.\.venv\Scripts\python -m pip install -r requirements.txt

# macOS/Linux
# .venv/bin/python -m pip install -r requirements.txt

# 잠금 파일로 Node.js 패키지 설치
npm --prefix rule-based-analyzer ci
```

백엔드에서 실행할 때도 가상 환경의 Python을 지정하면 하위 Python 모듈도
동일한 인터프리터와 패키지를 사용한다.

```powershell
$env:AI_PYTHON_EXECUTABLE = (Resolve-Path '.\.venv\Scripts\python.exe').Path
```

### 선택 기능 설정

- **OpenAI API 키:** `text-level-analyzer/.env` 파일에 `OPENAI_API_KEY=...`. 없으면 LLM 호출만 건너뛰고 규칙 기반 제안을 사용한다.
- **Google Vision 자격증명:** `GOOGLE_APPLICATION_CREDENTIALS`에 서비스 계정 JSON 경로를 지정한다. 없거나 잘못되면 CV 모듈만 실패로 기록한다.
- **MeCab 사전:** 현재 Windows 설정은 `C:\mecab\share\mecab-ko-dic\`을 사용한다. 사전이 없으면 난이도와 수정 제안 모듈만 건너뛴다.

자격증명과 `.env`는 `.gitignore`에 포함되므로 로컬에만 설정한다. 이 선택 설정이 없어도
규칙 기반 평가가 성공하면 성공한 모듈만으로 가중치를 재분배해 부분 분석 결과를 완료한다.
점수를 산출하는 모듈이 모두 실패하면 `result_final.json`은 진단용으로만 남기고,
백엔드에 0점 결과를 저장하지 않은 채 0이 아닌 종료 코드로 끝난다.
