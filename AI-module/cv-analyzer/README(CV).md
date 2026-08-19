# cv-analyzer

공공 웹사이트 접근성 자동 평가 플랫폼 **UniAccess**의 시각 접근성 분석 모듈.  
웹페이지 스크린샷에서 이미지 내 텍스트를 OCR로 추출하고, 각 텍스트와 배경 간의 명암비를 WCAG 공식으로 측정하여 **DOM 기반 검사(rule-based-analyzer)가 잡을 수 없는 이미지·캔버스 렌더링 텍스트의 시각적 접근성 위반을 탐지**한다.

---

## 파일 구성

```
cv-analyzer/
├── screenshot_capture.py  URL 크롤링 + 대표 페이지 최대 5개 스크린샷 캡처
├── vision_ocr.py          스크린샷 이미지 → OCR 텍스트 + 바운딩박스 추출
├── contrast_analyzer.py   텍스트 위치의 전경색/배경색 추출 → WCAG 명암비 계산 + 판정
└── cv_runner.py           위 3단계를 하나로 묶어 실행하는 통합 실행기
```

---

## 현재 실행 위치

```
[rule-based-analyzer / run_all.py]
  같은 일시정지 렌더에서 CV 전용 OS 임시 PNG 생성
  → cv_runner.py 입력으로만 사용 → 성공/실패와 무관하게 즉시 삭제

[cv-analyzer]
  run_all.py             → output/result_cv.json
  screenshot_capture.py  → screenshots/index.json, page_0.png ~ page_N.png
  vision_ocr.py          → result_ocr.json (각 페이지별)
  contrast_analyzer.py   → result_contrast.json (각 페이지별)
  cv_runner.py           → output/result_cv.json
                ↓
```

통합 실행에서는 DOM replay HTML만 저장·업로드한다. 임시 PNG는 기존 CV 분석을
유지하기 위한 비공개 입력일 뿐이며 `output/`, 백엔드, 결과 메타데이터에 남지 않는다.
사용자 제공 이미지 또는 `screenshot_capture.py` 결과를 대상으로 한 독립 실행도 지원한다.

---

## 왜 CV 모듈이 필요한가

rule-based-analyzer(axe-core)의 색 대비 검사는 브라우저의 `getComputedStyle()`로 CSS 속성을 읽는 방식이다. 이 방식은 **이미지·캔버스·SVG 내부에 렌더링된 텍스트**는 HTML 코드에 색상 정보가 없으므로 검사할 수 없다.

예를 들어 배너 이미지 위에 올라간 안내 문구, 차트 내 라벨 텍스트, CSS 그라데이션 배경 위의 텍스트 등이 이에 해당한다. CV 모듈은 스크린샷을 픽셀 수준에서 분석하여 이런 사각지대를 보완한다.

| 검사 방식 | 검사 대상 | 한계 |
|---|---|---|
| axe-core (DOM 기반) | CSS로 지정된 텍스트 색상 | 이미지·캔버스 내 텍스트 불가 |
| CV 모듈 (이미지 기반) | 스크린샷 픽셀에서 추출한 모든 텍스트 | OCR 인식 정확도에 의존 |

두 방식은 상호 보완 관계이며, 프로젝트의 성능평가에서 "DOM 미탐지 + CV 탐지" 사례를 별도 수집하여 CV 모듈의 존재 근거로 활용한다.

---

## 실행 방법

### cv_runner.py 단독 실행 (사용자 제공 이미지 대상)

```bash
python ai-analysis/cv/cv_runner.py path/to/page.png
```

옵션:

```bash
# Vision API 서비스 계정 키 파일 직접 지정
python ai-analysis/cv/cv_runner.py path/to/page.png --credentials path/to/key.json

# 결과 파일 경로 지정
python ai-analysis/cv/cv_runner.py path/to/page.png --output output/result_cv.json
```

### 단계별 개별 실행 (디버깅용)

```bash
# Step 1 — 서브페이지 스크린샷 캡처
python ai-analysis/cv/screenshot_capture.py https://example.go.kr screenshots/
# → screenshots/index.json, page_0.png ~ page_4.png 생성

# Step 2 — OCR 텍스트 추출
python ai-analysis/cv/vision_ocr.py screenshots/page_0.png
# → page_0_ocr.json 생성

# Step 3 — 명암비 분석
python ai-analysis/cv/contrast_analyzer.py screenshots/page_0.png page_0_ocr.json
# → page_0_contrast.json 생성
```

`contrast_analyzer.py`는 두 색상의 명암비를 직접 계산하는 모드도 지원한다.

```bash
# 전경색 RGB(0,0,0)과 배경색 RGB(255,255,255)의 명암비 확인
python ai-analysis/cv/contrast_analyzer.py 0,0,0 255,255,255
```

---

## 출력 파일

| 파일 | 생성 주체 | 용도 |
|---|---|---|
| `screenshots/index.json` | screenshot_capture.py | 캡처된 페이지 목록 및 메타 정보 (vision_ocr.py의 처리 대상 파악) |
| `screenshots/page_N.png` | screenshot_capture.py | 각 페이지 전체 스크린샷 |
| `<페이지명>_ocr.json` | vision_ocr.py | OCR 추출 텍스트 + 바운딩박스 목록 |
| `<페이지명>_contrast.json` | contrast_analyzer.py | 각 텍스트별 명암비 + AA/AAA 판정 결과 |
| `output/result_cv.json` | cv_runner.py | 위반 목록 + 수정 추천 + 요약 통계 (run_all.py가 총점 계산에 사용) |

`result_final.json`으로 통합되는 파일은 `result_cv.json`뿐이다. 나머지 중간 파일들은 디버깅·성능평가용이다.

---

## result_cv.json 구조

```json
{
  "module": "cv_visual_contrast",
  "version": "1.0.0",
  "analyzed_at": "2026-05-25T14:32:00",
  "elapsed_seconds": 8.42,
  "ocr_backend": "google_vision",

  "kwcag_item": {
    "id": "5.3.3",
    "name": "콘텐츠의 명도 대비",
    "description": "텍스트와 배경 간의 명도 대비는 4.5:1 이상이어야 한다",
    "level": "AA",
    "wcag_ref": "1.4.3"
  },

  "summary": {
    "total_texts_analyzed": 87,
    "pass_count": 71,
    "fail_count": 16,
    "pass_rate": 81.6,          ← run_all.py가 가중치(×20%) 적용하여 총점 산정
    "avg_contrast_ratio": 5.83,
    "min_contrast_ratio": 1.94,
    "worst_text": "서비스 이용 안내"
  },

  "violations": [
    {
      "text": "서비스 이용 안내",
      "location": {"x": 120, "y": 340, "width": 180, "height": 22},
      "contrast_ratio": 1.94,
      "contrast_display": "1.94:1",
      "required_ratio": 4.5,
      "is_large_text": false,
      "foreground_color": [180, 180, 180],
      "background_color": [220, 220, 220],
      "fix_suggestion": {
        "darken_text": {
          "suggested_color": [80, 80, 80],
          "suggested_hex": "#505050",
          "new_ratio": 4.63
        },
        "lighten_background": {
          "suggested_color": [255, 255, 255],
          "suggested_hex": "#FFFFFF",
          "new_ratio": 4.52
        }
      }
    }
  ]
}
```

---

## 환경 설정

### Python 패키지

```bash
pip install pillow
pip install google-cloud-vision
pip install playwright
playwright install chromium
```

### Google Cloud Vision API 인증

1. [Google Cloud Console](https://console.cloud.google.com)에서 프로젝트 생성 후 Cloud Vision API 활성화
2. 서비스 계정 키(JSON) 발급
3. 환경변수 설정:

```bash
# PowerShell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:/path/to/your/key.json"

# CMD
set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\your\key.json
```

또는 `cv_runner.py` 실행 시 `--credentials` 옵션으로 직접 경로를 지정해도 된다.

**무료 티어**: Vision API는 월 1,000건까지 무료. `vision_ocr.py`는 이미지 파일의 MD5 해시를 캐시 키로 사용하여 같은 이미지 재분석 시 API 호출을 건너뛴다. 캐시 파일은 `.ocr_cache/` 폴더에 저장된다.

---

## 파일별 역할 상세

### screenshot_capture.py — 스크린샷 캡처

Playwright로 브라우저를 자동 제어하여 웹사이트의 대표 페이지를 최대 5개 캡처한다.

**샘플링 전략**

메인 페이지를 먼저 캡처한 뒤, 페이지 내 내부 링크를 수집하여 접근성 문제가 집중되는 페이지 유형(로그인 → 마이페이지 → 민원신청 → FAQ → 게시판 순)을 우선으로 나머지를 캡처한다.

```
최대 5개로 제한하는 이유:
Vision API 무료 티어가 월 1,000건이므로,
한 사이트에 과도한 이미지를 분석하면 빠르게 소진됨.
접근성 취약 페이지 유형 5개를 샘플링하는 것이
비용 대비 커버리지를 최대화하는 전략임.
```

**주요 상수**

| 상수 | 기본값 | 설명 |
|---|---|---|
| `MAX_PAGES` | 5 | 최대 캡처 페이지 수 |
| `PAGE_LOAD_WAIT` | 3000ms | 동적 콘텐츠 로딩 대기 시간 |
| `VIEWPORT` | 1280×720 | 캡처 뷰포트 크기 (run.js와 동일) |

---

### vision_ocr.py — OCR 텍스트 추출

Google Cloud Vision API를 사용하여 스크린샷 이미지에서 텍스트와 그 위치(바운딩박스)를 추출한다.

**어댑터 패턴 설계**

`OCRBackend` 추상 클래스를 인터페이스로 정의하고, `VisionAPIBackend`가 이를 구현한다. 나중에 네이버 Clova OCR, AWS Textract 등 다른 OCR 엔진으로 교체하려면 `OCRBackend`를 구현하는 새 클래스만 추가하면 된다. rule-based-analyzer의 axe-core 어댑터(`adapter.js`)와 같은 설계 원리다.

**바운딩박스 변환**

Vision API는 텍스트 위치를 꼭짓점 4개(사각형)로 반환한다. 기울어진 텍스트의 경우 이 사각형이 직사각형이 아닐 수 있으므로, 4개 꼭짓점의 min/max를 구해 최소 외접 직사각형 `(x, y, width, height)`으로 변환한다.

**캐시 구조**

```
.ocr_cache/
  <이미지MD5해시>.json   ← 이미지 내용 기반 캐시 (파일명이 달라도 재사용)
```

---

### contrast_analyzer.py — 명암비 계산

OCR이 찾은 각 텍스트 바운딩박스에서 전경색(글자색)과 배경색을 픽셀 수준으로 추출하고, WCAG 표준 공식으로 명암비를 계산하여 기준 통과 여부를 판정한다.

**WCAG 명암비 계산 공식**

```
1. sRGB → 선형 RGB 변환 (감마 보정 제거)
2. 상대 휘도 계산: L = 0.2126R + 0.7152G + 0.0722B
   (사람 눈의 색상별 민감도: G > R > B)
3. 명암비 = (L_밝은쪽 + 0.05) / (L_어두운쪽 + 0.05)
   범위: 1.0(동일색) ~ 21.0(흰색 vs 검정)
```

**판정 기준 (KWCAG 5.3.3 = WCAG 1.4.3 AA)**

| 텍스트 크기 | AA 기준 | AAA 기준 |
|---|---|---|
| 일반 텍스트 (바운딩박스 높이 < 24px) | 4.5:1 이상 | 7.0:1 이상 |
| 큰 텍스트 (바운딩박스 높이 ≥ 24px) | 3.0:1 이상 | 4.5:1 이상 |

이 모듈의 주요 판정 기준은 **AA(4.5:1)** 이다. KWCAG 5.3.3이 AA 수준을 요구하기 때문이다.

**색상 추출 전략**

단순 평균을 구하면 글자색과 배경색이 섞여서 실제 어느 쪽도 아닌 중간값이 나오므로, 전경과 배경을 분리 추출한다.

- **전경색(글자)**: 바운딩박스 내 픽셀에서 어두운 색상 하위 30% 중 최빈 색상을 선택. 텍스트는 보통 배경보다 어두우므로, 어두운 쪽이 글자색에 해당.
- **배경색**: 바운딩박스를 상하좌우 20% 확장한 영역에서 최빈 색상을 선택. 배경은 넓게 균일하게 퍼져 있으므로 가장 빈번한 색이 배경색.
- **색상 양자화**: RGB 각 채널을 8 단위로 반올림하여 안티앨리어싱으로 생긴 미세한 색상 차이를 하나로 묶음.

**수정 추천**

명암비 미달 시 기준을 충족하는 대체 색상을 두 가지 방안으로 추천한다. 실무에서는 브랜드 가이드라인 등으로 한쪽 색상을 못 바꾸는 경우가 있으므로 양쪽을 모두 제안한다.

- **방안 1**: 전경색(글자)을 RGB 각 채널에서 1씩 줄여가며(더 어둡게) 목표 명암비에 도달하는 색상을 탐색
- **방안 2**: 배경색을 RGB 각 채널에서 1씩 늘려가며(더 밝게) 목표 명암비에 도달하는 색상을 탐색

---

### cv_runner.py — 통합 실행기

`screenshot_capture.py → vision_ocr.py → contrast_analyzer.py` 세 단계를 순서대로 실행하고 결과를 `result_cv.json`으로 출력하는 진입점 파일이다.

**점수 체계**

이 모듈은 100점 만점 자체 점수를 계산하지 않는다. `pass_rate`(명암비 통과율)를 원시 통계로 제공하고, `run_all.py`가 가중치(20%)를 적용하여 총점에 합산한다.

```
총점 기여분 = pass_rate × 0.20
예: pass_rate 81.6 → 81.6 × 0.20 = 16.3점
```

**AI 개입 지점**

Step 2(OCR)에서만 외부 AI(Google Vision API)를 사용한다. Step 3(명암비 계산)과 Step 4(수정 추천)는 WCAG 공식 + 임계값 비교로 이루어지는 순수 규칙 기반 처리다.

---

## 관련 KWCAG 항목

| KWCAG 항목 | 내용 | 이 모듈의 역할 |
|---|---|---|
| 5.3.3 콘텐츠의 명도 대비 | 텍스트와 배경 명도 대비 4.5:1 이상 (AA) | 이미지 내 텍스트 명암비 측정 및 위반 탐지 |

rule-based-analyzer는 동일한 KWCAG 5.3.3 항목을 CSS 기반으로 검사한다. 두 모듈의 결과를 합산하면 DOM 텍스트와 이미지 텍스트 양쪽을 모두 커버하게 된다.

---

## 기존 도구와의 차별점

| 도구 | 명암비 검사 방식 | 이미지 내 텍스트 |
|---|---|---|
| WAVE | DOM CSS 파싱 | ❌ 검사 불가 |
| Lighthouse | DOM CSS 파싱 | ❌ 검사 불가 |
| axe-core (우리 rule-based) | getComputedStyle() | ❌ 검사 불가 |
| **CV 모듈 (이 모듈)** | **스크린샷 픽셀 분석** | **✅ OCR로 탐지** |

성능평가(성능평가\_개선계획.pdf 3.3절)에서 "DOM 기반으로는 안 잡히지만 CV 모듈로는 잡히는 위반" 사례를 정량적으로 수집하여 이 차별점을 근거로 제시할 예정이다.

---

## 주의사항

- **Vision API 비용**: 무료 티어 월 1,000건 초과 시 과금된다. 같은 스크린샷을 반복 분석할 때는 캐시(`.ocr_cache/`)가 자동으로 재사용된다. 캐시 키는 이미지 파일의 MD5 해시이므로, 파일명이 달라도 내용이 같으면 재사용된다.
- **OCR 인식 정확도**: 이미지 압축, 안티앨리어싱, 낮은 해상도 등으로 인해 일부 텍스트가 누락될 수 있다. 이 경우는 성능평가의 한계점으로 명시한다.
- **색상 추출 오차**: 이미지 기반 색상 추출은 DOM의 CSS 파싱보다 오차가 있을 수 있다. 성능평가(3.3절)에서 DOM 기반 명암비와 이미지 기반 명암비의 오차율을 실측하여 정량적으로 기록한다.
- **`run_all.py`는 프로젝트 루트에서 실행**: 개별 모듈 파일을 직접 실행하면 출력 파일 경로가 달라질 수 있다.
