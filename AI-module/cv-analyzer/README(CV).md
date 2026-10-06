# cv-analyzer

공공 웹사이트 접근성 자동 평가 플랫폼 **UniAccess**의 시각 접근성 분석 모듈.  
웹페이지 스크린샷에서 글자를 OCR로 찾고, 각 글자와 배경의 명암비를 WCAG 공식으로 측정하여 **DOM 기반 검사(rule-based-analyzer)가 잡을 수 없는 이미지·캔버스 렌더링 텍스트의 시각적 접근성 위반을 탐지**한다. 담당 항목은 KWCAG 5.4.3 "텍스트 콘텐츠의 명도 대비"다.

---

## 파일 구성

```
cv-analyzer/
├── vision_ocr.py            스크린샷 → Google Vision OCR → 글자 + 바운딩박스
├── contrast_analyzer.py     글자 위치의 글자색/배경색 추출 → WCAG 명암비 계산 + 판정 + 수정 색 추천
├── cv_runner.py             OCR → 제외 영역 분리 → 명암비 판정 → 수정 색 추천 → result_cv.json
├── test_contrast_formula.py 명암비 공식을 명세서만 보고 따로 구현해 결과를 대조하는 테스트
└── uniaccess-*.json         Google Cloud 서비스 계정 키 (git 제외, 직접 둠)
```

색 측정 방법(어두운 배경, 색 버튼, 측정 불가)은 루트 `tests/test_cv_measurement.py`가 확인한다.

---

## 파이프라인 내 위치

```
[rule-based-analyzer/run.js --cv-screenshot <임시 PNG>]
  axe가 본 것과 같은 화면을 전체 페이지 PNG 1장으로 저장 (가로 1280px, 세로 페이지 전체)
  같은 순간의 요소 위치를 result_cv_anchors.json에 기록
                ↓
[run_all.py 5단계]
  광고·동적 영역 좌표를 스크린샷 px로 바꿔 output/cv_excluded_regions.json 저장
  cv_runner.py <임시 PNG> --output output/result_cv.json [--excluded-regions ...]
  (작업 폴더는 output/, 끝나면 성공·실패와 관계없이 임시 PNG 삭제)
                ↓
[run_all.py 6단계]
  규칙 엔진 color-contrast와 겹치는 CV 위반 제거, 위반마다 locator 연결,
  레이어 팝업 이미지는 따로 분석해 POPUP으로 붙임 → result_final.json
```

예전에 있던 `screenshot_capture.py`(대표 페이지 최대 5개 캡처)는 없어졌다. 스크린샷은 브라우저를 띄우는 `run.js` 한 곳에서만 만든다. 임시 PNG는 `output/`, 백엔드, 결과 메타데이터에 남지 않는다.

---

## 왜 CV 모듈이 필요한가

rule-based-analyzer(axe-core)의 색 대비 검사는 브라우저의 `getComputedStyle()`로 CSS 속성을 읽는 방식이다. 이 방식은 **이미지·캔버스·SVG 내부에 렌더링된 텍스트**는 HTML 코드에 색상 정보가 없으므로 검사할 수 없다.

예를 들어 배너 이미지 위에 올라간 안내 문구, 차트 내 라벨 텍스트, CSS 그라데이션 배경 위의 텍스트 등이 이에 해당한다. CV 모듈은 스크린샷을 픽셀 수준에서 분석하여 이런 사각지대를 보완한다.

| 검사 방식 | 검사 대상 | 한계 |
|---|---|---|
| axe-core (DOM 기반) | CSS로 지정된 텍스트 색상 | 이미지·캔버스 내 텍스트 불가 |
| CV 모듈 (이미지 기반) | 스크린샷 픽셀에서 추출한 모든 텍스트 | OCR 인식 정확도에 의존 |

두 방식은 상호 보완 관계다. 같은 글자를 양쪽이 모두 잡으면 위치를 정확히 표시할 수 있는 규칙 엔진 결과를 남기고 CV 위반은 뺀다(아래 "규칙 엔진과의 중복").

---

## 실행 방법

### 전체 파이프라인 (권장)

run_all.py가 있는 폴더에서 `python run_all.py <URL>`. CV는 5단계에서 자동으로 돈다.

### cv_runner.py 단독 실행 (이미지가 있을 때)

`cv-analyzer/` 안에서 실행한다.

```bash
python cv_runner.py path/to/page.png
python cv_runner.py path/to/page.png --credentials path/to/key.json     # 키 파일 직접 지정
python cv_runner.py path/to/page.png --output ../output/result_cv.json  # 결과 경로 (기본: 현재 폴더의 result_cv.json)
python cv_runner.py path/to/page.png --excluded-regions regions.json    # 이 영역(AD/DYNAMIC/POPUP) 안 글자는 점수에서 뺌
```

분석할 스크린샷이 필요하면 `rule-based-analyzer/`에서 `node run.js <URL> result.json --cv-screenshot 확인용.png`처럼 경로를 주고 돌린다.

### 단계별 개별 실행 (디버깅용)

```bash
python vision_ocr.py page.png                     # → page_ocr.json
python contrast_analyzer.py page.png page_ocr.json  # → page_contrast.json
python contrast_analyzer.py 0,0,0 255,255,255     # 두 색의 명암비, AA/AAA 통과 여부, 수정 색
```

`<이름>_ocr.json`, `<이름>_contrast.json`은 이렇게 따로 돌릴 때만 생긴다. `cv_runner.py`는 출력 파일 옆에 `result_ocr.json`(이미지 경로는 지움)만 남긴다.

---

## 출력 파일

| 파일 | 생성 주체 | 용도 |
|---|---|---|
| `result_cv.json` | cv_runner.py | 요약 통계, 위반 목록과 수정 추천, 제외 영역 위반. `run_all.py`가 총점 계산에 사용 |
| `result_ocr.json` | cv_runner.py | OCR 결과(글자, 상자, 엔진 이름). 디버깅용 |
| `.ocr_cache/<MD5>.json` | vision_ocr.py | OCR 캐시. 작업 폴더 기준으로 생겨서 통합 실행이면 `output/.ocr_cache/` |

`result_final.json`으로 통합되는 것은 `result_cv.json`뿐이다(`modules.cv_visual`).

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
    "id": "5.4.3",
    "name": "텍스트 콘텐츠의 명도 대비",
    "standard": "KWCAG",
    "version": "2.2"
  },

  "summary": {
    "total_texts_analyzed": 87,
    "pass_count": 71,
    "fail_count": 16,
    "pass_rate": 81.6,
    "avg_contrast_ratio": 5.83,
    "min_contrast_ratio": 2.96,
    "worst_text": "서비스 이용 안내",
    "skipped_unmeasured": 4
  },

  "violations": [
    {
      "text": "서비스 이용 안내",
      "location": {"x": 120, "y": 340, "width": 180, "height": 22},
      "contrast_ratio": 2.96,
      "contrast_display": "2.96:1",
      "required_ratio": 4.5,
      "is_large_text": false,
      "foreground_color": [150, 150, 150],
      "background_color": [255, 255, 255],
      "fix_suggestion": {
        "darken_text": {
          "suggested_color": [118, 118, 118],
          "suggested_hex": "#767676",
          "new_ratio": 4.54
        },
        "lighten_background": {
          "suggested_color": [255, 255, 255],
          "suggested_hex": "#FFFFFF",
          "new_ratio": 2.96
        }
      }
    }
  ],

  "pass_count_detail": {"aa_normal": 60, "aa_large": 11},
  "excluded_violations": []
}
```

- `kwcag_item`은 `mapping.js` 대조표에서 WCAG 1.4.3에 대응하는 항목을 가져온다(루트 `standard_mapping.py`를 거쳐 `node rule-based-analyzer/mapping.js` 실행).
- `location`은 스크린샷 픽셀 좌표다. 통합 실행에서는 `run_all.py`가 위반마다 그 자리를 덮는 가장 작은 요소를 찾아 `locator`(선택자, 문서 좌표, 글자·이미지 서명)를 붙인다.
- 예시의 `lighten_background`처럼 배경이 이미 흰색이면 더 밝게 할 수 없어 `new_ratio`가 기준에 못 미친 채로 나온다. 이럴 때는 다른 방안을 쓴다.
- `excluded_violations`: 제외 영역 안 글자의 위반. 위반 형식에 `reason`(`AD`, `DYNAMIC`, `POPUP`)이 붙는다. 통과율 표본에는 넣지 않는다.
- **측정하지 못한 경우.** OCR이 글자를 하나도 못 찾으면 `"status": "not_measured"`, `"reason": "NO_TEXT_DETECTED"`, 찾았지만 전부 측정 불가면 `"reason": "NO_MEASURABLE_TEXT"`이고 `pass_rate`는 `null`, `note`에 이유가 적힌다. `run_all.py`는 CV를 총점에서 빼고, 백엔드는 CV 점수를 `null`, 상태를 `NOT_MEASURED`로 저장한다.

---

## 환경 설정

### Python 패키지

run_all.py가 있는 폴더의 `requirements.txt`에 버전이 고정되어 있다. 이 모듈이 쓰는 것은 `Pillow`와 `google-cloud-vision`이다.

```bash
pip install -r requirements.txt
```

KWCAG 번호를 `mapping.js`에서 읽어 오므로 Node.js도 있어야 한다.

### Google Cloud Vision API 인증

1. [Google Cloud Console](https://console.cloud.google.com)에서 프로젝트 생성 후 Cloud Vision API 활성화 (결제가 꺼져 있으면 키가 있어도 실패한다)
2. 서비스 계정 키(JSON) 발급
3. 다음 중 하나로 키를 넘긴다.
   - `cv-analyzer/uniaccess-495010-08a5c6701cd7.json`에 둔다. 환경변수가 없으면 `run_all.py`가 이 파일을 `--credentials`로 넘긴다. git에는 올리지 않는다.
   - 환경변수 `GOOGLE_APPLICATION_CREDENTIALS`에 키 경로를 넣는다.

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:/path/to/your/key.json"
```

   - 단독 실행이면 `--credentials` 옵션으로 직접 지정한다.

**무료 티어**: Vision API는 월 1,000건까지 무료. `vision_ocr.py`는 이미지 파일 내용의 MD5 해시를 캐시 키로 써서 같은 이미지를 다시 분석할 때 API 호출을 건너뛴다. 파일 이름이 달라도 내용이 같으면 재사용하고, 이름이 같아도 내용이 바뀌면 새로 부른다.

---

## 파일별 역할 상세

### vision_ocr.py — OCR 텍스트 추출

Google Cloud Vision API의 `text_detection`으로 스크린샷에서 단어와 위치(바운딩박스)를 뽑는다. 응답의 0번째(이미지 전체 글을 합친 것)는 버리고 단어별 결과를 쓴다.

**어댑터 패턴 설계**

`OCRBackend` 추상 클래스를 인터페이스로 정의하고, `VisionAPIBackend`가 이를 구현한다. 나중에 네이버 Clova OCR, AWS Textract 등 다른 OCR 엔진으로 교체하려면 `OCRBackend`를 구현하는 새 클래스만 추가하면 된다. rule-based-analyzer의 axe-core 어댑터(`adapter.js`)와 같은 설계 원리다.

**바운딩박스 변환**

Vision API는 텍스트 위치를 꼭짓점 4개로 반환한다. 4개 꼭짓점의 min/max를 구해 외접 직사각형 `(x, y, width, height)`으로 바꾼다.

**confidence는 측정값이 아니다.** `text_detection`은 단어별 신뢰도를 주지 않아서 코드가 기본값 0.95를 적어 넣는다.

### contrast_analyzer.py — 명암비 계산

**WCAG 명암비 계산 공식**

```
1. sRGB → 선형 RGB 변환 (감마 보정 제거): 값/255 ≤ 0.04045면 /12.92, 아니면 ((값+0.055)/1.055)^2.4
2. 상대 휘도: L = 0.2126R + 0.7152G + 0.0722B  (사람 눈의 민감도 G > R > B)
3. 명암비 = (L_밝은쪽 + 0.05) / (L_어두운쪽 + 0.05)   범위 1.0(같은 색) ~ 21.0(흰색 vs 검정)
```

**판정 기준 (KWCAG 5.4.3 = WCAG 1.4.3 AA)**

| 텍스트 크기 | AA 기준 (판정에 사용) | AAA 기준 (참고) |
|---|---|---|
| 일반 텍스트 (OCR 상자 높이 < 24px) | 4.5:1 이상 | 7.0:1 이상 |
| 큰 텍스트 (OCR 상자 높이 ≥ 24px, 18pt ≈ 24px) | 3.0:1 이상 | 4.5:1 이상 |

굵은 글씨(14pt bold) 기준은 픽셀로 알 수 없어 쓰지 않는다.

**글자색·배경색 추출**

단순 평균을 구하면 흰 배경의 검은 글자가 회색이 되므로 둘을 따로 뽑는다(`measure_text_colors()`).

- **배경색**: OCR 상자 **안의 최빈색**. 상자는 글자에 맞춰 잡히므로 바탕 픽셀이 더 많다. 상자 바깥은 버튼·배너 밖의 페이지 배경일 수 있어 쓰지 않는다.
- **글자색**: 상자 안 색 묶음 중 픽셀의 2% 이상이고 배경과 대비가 1.15:1 이상인 색 가운데 **배경과 대비가 가장 큰 색**. 글자가 배경보다 어둡다고 가정하지 않으므로 어두운 배경의 밝은 글씨도 측정한다.
- **색 묶기**: RGB 각 채널을 8 단위로 묶되, 대표색은 묶음 구간이 아니라 실제 픽셀의 평균을 쓴다. 속도를 위해 상자를 최대 160×80으로 줄여서 센다.
- **측정 불가**: 배경과 구분되는 색이 없으면 위반으로도 통과로도 세지 않고 `summary.skipped_unmeasured`에 센다.

**표시값은 버림.** 명암비를 적을 때는 소수 둘째 자리에서 버린다. 반올림하면 4.4976:1이 4.50:1로 보여 기준을 충족한 것처럼 읽히기 때문이다. 합격 판정은 원래 값으로 한다.

**통과율.** `pass_rate = 통과 수 / 측정한 글자 수 × 100`(소수 첫째 자리). 측정 불가와 제외 영역 글자는 분모에 들어가지 않는다.

**수정 추천 (`suggest_fix`)**

명암비가 기준(일반 4.5, 큰 글자 3.0)에 못 미치면 두 가지 방안을 낸다. 실무에서는 브랜드 가이드라인 등으로 한쪽 색을 못 바꾸는 경우가 있으므로 양쪽을 모두 제안한다.

- **방안 1**: 글자색을 RGB 각 채널에서 1씩 줄여가며(더 어둡게) 기준에 닿는 색을 찾는다.
- **방안 2**: 배경색을 RGB 각 채널에서 1씩 늘려가며(더 밝게) 기준에 닿는 색을 찾는다.
- 끝까지 가도 닿지 않으면 검정·흰색과 그때의 명암비를 그대로 준다.
- 글자가 배경보다 밝은 경우(어두운 배경의 흰 글자)에도 "글자를 어둡게 / 배경을 밝게"만 추천하는 한계가 있다.

### cv_runner.py — 통합 실행기

이미지 하나를 받아 다음을 한 번에 한다. 다른 파이썬 코드에서 `CVRunner().analyze(...)`로 불러 쓸 수도 있다.

1. 이미지 존재 확인
2. `vision_ocr.run_ocr()`로 글자 추출(`result_ocr.json` 저장, 이미지 경로는 지움)
3. 글자 상자 중심이 제외 영역 안에 있으면 따로 빼서 명암비만 재고 `excluded_violations`에 사유와 함께 남김
4. 나머지 글자로 `ContrastAnalyzer.analyze_screenshot()` 판정
5. 위반마다 `suggest_fix()`로 추천 색 생성, `result_cv.json` 저장

**점수 체계**

이 모듈은 100점 만점 자체 점수를 계산하지 않는다. `pass_rate`(명암비 통과율)를 내고, `run_all.py`가 총점에 합산한다.

```
세 모듈이 모두 점수를 낼 때: 총점 기여분 = pass_rate × 0.20
예: pass_rate 81.6 → 16.3점
빠진 모듈이 있으면 남은 모듈의 가중치 합으로 다시 나눈다. CV가 not_measured면 CV를 빼고 나눈다.
글자를 실제로 측정했는데 통과율이 0%면 0점으로 합산한다.
```

**AI 개입 지점**

OCR에서만 외부 AI(Google Vision API)를 쓴다. 명암비 계산과 수정 추천은 WCAG 공식과 기준값 비교로 이루어지는 규칙 기반 처리다.

### run_all.py가 CV 결과에 더 하는 것

- **제외 영역.** 규칙 분석기가 표시한 광고(`AD`)·동적 영역(`DYNAMIC`)의 문서 좌표를 스크린샷 px로 바꿔 `--excluded-regions`로 넘긴다.
- **레이어 팝업.** `run.js`가 팝업 부분만 찍은 이미지(`<CV 이미지>-popup-<번호>.png`)를 이미지 전체를 `POPUP` 영역으로 두고 같은 방식으로 분석해 `excluded_violations`에 붙인다. 점수에는 넣지 않는다.
- **규칙 엔진과의 중복.** CV 위반 상자의 50% 이상이 규칙 엔진 `color-contrast` 위반 요소의 문서 좌표와 겹치면 CV 위반 목록에서 빼고 그 수를 `summary.duplicate_rule_violations`에 적는다. 통과율(총점)은 바꾸지 않는다.
- **요소 연결.** `result_cv_anchors.json`으로 위반마다 `locator`를 붙인다. 라이브 리포트는 그 요소를 따라가고, 분석 뒤 요소 내용이 바뀌었으면 표시를 숨긴다.

---

## 관련 KWCAG 항목

| KWCAG 항목 | 내용 | 이 모듈의 역할 |
|---|---|---|
| 5.4.3 텍스트 콘텐츠의 명도 대비 | 텍스트와 배경 명도 대비 4.5:1 이상 (AA) | 스크린샷 속 글자(이미지 속 글자 포함) 명암비 측정 및 위반 탐지 |

rule-based-analyzer는 같은 KWCAG 5.4.3 항목을 CSS 기반으로 검사한다. 두 모듈을 함께 쓰면 DOM 텍스트와 이미지 텍스트를 모두 다루고, 겹치는 위반은 위 규칙으로 한 번만 남는다. `mapping.js`에서 CV 담당으로 적힌 5.4.4 "콘텐츠 간의 구분"은 아직 검사하지 않는다.

---

## 기존 도구와의 차별점

| 도구 | 명암비 검사 방식 | 이미지 내 텍스트 |
|---|---|---|
| WAVE | DOM CSS 파싱 | ❌ 검사 불가 |
| Lighthouse | DOM CSS 파싱 | ❌ 검사 불가 |
| axe-core (우리 rule-based) | getComputedStyle() | ❌ 검사 불가 |
| **CV 모듈 (이 모듈)** | **스크린샷 픽셀 분석** | **✅ OCR로 탐지** |

---

## 주의사항

- **Vision API 비용**: 무료 티어 월 1,000건 초과 시 과금된다. 같은 스크린샷을 반복 분석할 때는 캐시(`.ocr_cache/`)가 자동으로 재사용된다. 팝업 이미지는 임시 폴더에서 분석해 캐시가 남지 않는다.
- **OCR 인식 정확도**: 이미지 압축, 안티앨리어싱, 낮은 해상도 등으로 일부 글자가 누락되거나 잘못 읽힐 수 있다.
- **색상 추출 오차**: 이미지 기반 색상 추출은 DOM의 CSS 값보다 오차가 있을 수 있다.
- **스크롤 없는 전체 캡처**: 스크롤해야 불러오는 이미지는 빈 칸으로 찍힐 수 있다.
- **`run_all.py`는 run_all.py가 있는 폴더에서 실행**: 개별 모듈 파일을 직접 실행하면 출력 파일 경로가 달라질 수 있다.
