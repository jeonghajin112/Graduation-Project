# text-level-analyzer

공공 웹사이트 접근성 자동 평가 플랫폼 **UniAccess**의 텍스트 난이도 분석 모듈.  
rule-based-analyzer가 저장한 렌더링 HTML에서 텍스트를 추출하고, 한국어 인지 난이도를 자체 설계 공식으로 측정한 뒤, 위반 항목에 대해 수정 제안을 자동 생성한다.

---

## 파일 구성

```
text-level-analyzer/
├── text_extractor.py        HTML → 텍스트 추출 + 종류별 분류
├── difficulty_engine.py     텍스트 → 한국어 인지 난이도 점수 산출
├── suggestion_generator.py  난이도 위반 항목 → 수정 제안 생성 (규칙 기반 + LLM)
├── text_standard_mapper.py  난이도 플래그 → WCAG 2.2 / KWCAG 항목
├── compute_pair_difficulty.py  설문 원문·수정문 쌍에 같은 공식을 사후 적용
├── export_study_pairs.py    설문용 원문·수정문 블라인드 쌍 추출
├── test_*.py                단위 테스트 5개 파일, 44개 (test_difficulty_engine.py 28개는 2026-10-02 추가)
├── korean_vocab_grades.json 국립국어원 학습용 어휘 등급 사전 (A/B/C 등급, 5543개)
└── .env                     OpenAI API 키 (git 제외, 직접 만듦)
```

---

## 파이프라인 내 위치

```
[rule-based-analyzer]
  run.js → result.html (렌더링된 DOM 저장)
                ↓
[text-level-analyzer]
  text_extractor.py       → output/result_text.json
  difficulty_engine.py    → output/result_text_difficulty.json
  mapping.js(KWCAG 2.2) → text_standard_mapper.py
  suggestion_generator.py → output/result_text_suggestions.json
                ↓
[run_all.py]
  세 모듈 결과 통합 → result_final.json → 백엔드 전송
```

run_all.py가 세 단계를 순서대로 자동 실행하므로, 개별 실행은 개발·디버깅 목적으로만 사용한다.
레이어 팝업이 있으면 run_all.py가 `result_popup.html`도 같은 세 단계로 분석해 결과 블록 뒤에 `exclusion_reason: "POPUP"`으로 붙인다(점수에는 넣지 않음).
`text_standard_mapper.py`는 루트의 `standard_mapping.py`를 거쳐 `node rule-based-analyzer/mapping.js`를 실행하므로 이 모듈을 돌리는 PC에도 Node가 있어야 한다.

---

## 실행 방법

### 전체 파이프라인 (권장)

run_all.py가 있는 폴더(개인 저장소는 `graduation_project/`, 팀 저장소는 `Graduation-Project/AI-module/`)에서 실행하면 이 모듈의 세 단계가 자동으로 순서대로 실행된다.

```bash
cd graduation_project            # 팀 저장소라면 cd Graduation-Project/AI-module
python run_all.py https://example.go.kr
```

### 단계별 개별 실행 (디버깅용)

`text-level-analyzer/` 폴더 안에서 실행한다(파일 경로는 그 폴더 기준).

```bash
cd text-level-analyzer

# Step 1 — 텍스트 추출
python text_extractor.py ../output/result.html ../output/result_text.json
# 두 번째 인자를 빼면 입력과 같은 폴더의 result_text.json

# Step 2 — 난이도 분석
python difficulty_engine.py ../output/result_text.json
# → ../output/result_text_difficulty.json (입력 이름 + _difficulty)

# Step 3 — 수정 제안 생성
python suggestion_generator.py ../output/result_text_difficulty.json
# → ../output/result_text_suggestions.json

# 레이어 팝업 문서는 팝업 모드로 추출 (모달·팝업 제거 규칙을 끔)
python text_extractor.py ../output/result_popup.html ../output/popup_text.json --popup-layer
```

세 스크립트 모두 두 번째 인자로 출력 경로를 직접 지정할 수 있다.

### 테스트

```bash
python -m unittest discover -s text-level-analyzer -p "test_*.py"   # run_all.py가 있는 폴더에서
```

`test_difficulty_engine.py`는 MeCab과 한국어 사전이 있어야 돌아간다. LLM 테스트는 실제 API를 부르지 않는다.

---

## 출력 파일

| 파일 | 생성 주체 | 용도 |
|---|---|---|
| `output/result_text.json` | text_extractor.py | 카테고리별 분류된 텍스트 블록 목록 (difficulty_engine.py 입력) |
| `output/result_text_difficulty.json` | difficulty_engine.py | 블록별 난이도 점수 + 위반 플래그 (suggestion_generator.py 입력) |
| `output/result_text_suggestions.json` | suggestion_generator.py | 위반 항목별 수정 제안 + LLM 수정문 (run_all.py가 통합에 사용) |

---

## 환경 설정

### Python 패키지

run_all.py가 있는 폴더의 `requirements.txt`에 세 모듈의 Python 패키지가 버전 고정으로 들어 있다. 이 모듈이 쓰는 것은 `beautifulsoup4`, `mecab-python3`, `python-dotenv`, `requests`다.

```bash
pip install -r requirements.txt
```

### MeCab 한국어 형태소 분석기 (Windows)

difficulty_engine.py는 MeCab을 사용하여 형태소 분석을 수행한다.  
Windows에서는 pip 설치만으로 동작하지 않으며, 아래 순서로 수동 설치가 필요하다.

1. [mecab-ko-msvc Releases](https://github.com/Pusnow/mecab-ko-msvc/releases)에서 다음 두 파일을 다운로드한다.
   - `mecab-ko-windows-x64.zip` — MeCab 바이너리
   - `mecab-ko-dic.zip` — 한국어 사전
2. 바이너리를 `C:\mecab\`에 압축 해제한다.
3. 사전을 `C:\mecab\share\mecab-ko-dic\`에 압축 해제한다.
4. `C:\mecab\etc\mecabrc` 파일을 생성하고 아래 한 줄을 작성한다.
   ```
   dicdir = C:\mecab\share\mecab-ko-dic
   ```
5. 설치 확인:
   ```bash
   python -c "import MeCab; t=MeCab.Tagger('-r C:/mecab/etc/mecabrc -d C:/mecab/share/mecab-ko-dic'); print(t.parse('접근성을 개선한다'))"
   ```

### OpenAI API 키 (suggestion_generator.py LLM 기능)

`text-level-analyzer/.env` 파일에 아래와 같이 저장한다. `suggestion_generator.py`는 `load_dotenv()`로 자기 폴더부터 위로 올라가며 `.env`를 찾으므로, 상위 폴더(run_all.py가 있는 폴더)에 두어도 읽힌다. 환경변수 `OPENAI_API_KEY`가 이미 있으면 그 값을 쓴다. git에는 올리지 않는다.

```
OPENAI_API_KEY=sk-xxxx
```

키가 없으면 자동으로 오프라인 모드로 전환되며, LLM 호출 없이 규칙 기반 템플릿 제안만 생성한다.

---

## 파일별 역할 설명

### text_extractor.py — 텍스트 추출 전처리

**입력:** `result.html` (rule-based-analyzer의 run.js가 저장한 렌더링된 DOM)  
**출력:** `result_text.json`

rule-based-analyzer가 저장한 렌더링 HTML에서 AI 분석 대상 텍스트를 깨끗하게 추출하고, 아래 10개 카테고리로 분류한다.

ARIA role을 먼저 보고, 없으면 태그 이름으로 분류한다. 기준값의 근거와 실제 검사 내용은 아래 difficulty_engine.py 절에 있다.

| 카테고리 | 대상 | 난이도 분석 기준 |
|---|---|---|
| `paragraph` | p, 그리고 article, section, main, div, span, blockquote | Jo(2016) 이독성 공식 전체 적용 (핵심 대상) |
| `heading` | h1~h6, role="heading" | 60자 초과 시 플래그 |
| `button` | button, input(submit, button, reset), role="button" | 20자 초과 시 플래그 |
| `link` | a | 30자 초과 시 플래그 |
| `label` | label, legend | 40자 초과 시 플래그 |
| `form_guide` | placeholder, aria-label, title 속성값 | 50자 초과 시 플래그 (보이는 글을 그대로 담은 title·aria-label은 제외) |
| `table` | th, td, caption | 평균 문장 길이 25어절 이상 (문장 끝 부호가 있는 글만) |
| `list` | li, dt, dd | 평균 문장 길이 25어절 이상 (문장 끝 부호가 있는 글만) |
| `alert` | role이 alert, status, log, marquee, timer | 평균 문장 길이 25어절 이상 (문장 끝 부호가 있는 글만) |
| `other` | em, strong, b, i, small, time, figcaption, summary, details, address 같은 인라인·보조 태그 | 평균 문장 길이 25어절 이상 (문장 끝 부호가 있는 글만) |

모든 카테고리에 위치 의존 표현 탐지와 명사 나열 검사가 공통으로 붙는다(2026-10-02).

처리 과정은 5단계로 구성된다.

1. 불필요한 태그 제거: `script`, `style`, `noscript`, `iframe`, `svg`, `math`, `template`, `code`, `pre`를 DOM에서 완전히 삭제한다. (그 전에 원래 형제 순서를 기록해, 요소를 지워도 `selector`의 `:nth-of-type(N)`이 실제 화면과 맞게 한다.)
2. HTML 주석 제거: `<!-- -->` 형태의 개발자 메모를 제거한다.
3. 숨겨진·제외된 요소 제거: rule-based-analyzer가 표시한 광고·동적 영역(`data-ua-excluded-region`)과 이 화면 폭에서 안 그려지는 요소(`data-ua-hidden`), 인라인 `display:none`, `aria-hidden="true"`, `role="dialog"`, class가 `modal`·`popup`·`loading`·`layer-loading`인 요소, id에 `modal`·`popup`·`tracer`·`loading`·`wait`가 들어간 요소를 제거한다. 정부24 실제 테스트 중 대기열 페이지(TRACER)·모달이 분석 대상으로 잡히는 문제가 발견되어 추가된 단계다. 스크린리더 전용 텍스트(`sr-only` 등)는 화면에 안 보여도 읽히므로 지우지 않는다. 팝업 모드(`--popup-layer`)에서는 `role="dialog"`와 modal·popup class·id 규칙을 끈다.
4. 요소 순회 + 텍스트 수집: 남은 HTML 요소를 순회하며 카테고리로 분류하고 텍스트를 수집한다. `nav`, `footer`, `header`(그리고 role이 navigation, banner, contentinfo인 요소) 내부는 반복 메뉴·저작권 표시이므로 건너뛴다. `div`, `section` 같은 컨테이너는 자식 블록 요소가 있으면 직접 텍스트만 수집하고, "카테고리:텍스트"가 같은 블록은 한 번만 남긴다. 두 글자 미만은 버린다.
5. form_guide 별도 추출: `placeholder`, `aria-label`, `title` 속성값은 태그의 텍스트 노드가 아닌 속성에 들어 있으므로 별도로 추출한다(페이지 `<title>`은 제외). `title`·`aria-label`이 그 요소에 보이는 글을 그대로 담고 있으면(예: `<a title="공고 제목 게시물로 이동">공고 제목</a>`) `attributes.duplicates_visible_text = true`를 붙인다(2026-10-02). 난이도 엔진은 이 블록의 글자 수 검사를 건너뛴다(같은 제목이 link와 form_guide로 두 번 감점되지 않도록).

출력 JSON 구조:

```json
{
  "meta": {
    "total_blocks": 413,
    "total_sentences": 414,
    "categories": { "paragraph": 135, "form_guide": 134, "link": 85 }
  },
  "blocks": [
    {
      "text": "급한 생활비, 대출 연체...",
      "category": "paragraph",
      "tag": "p",
      "selector": "html > body > main > section > p",
      "attributes": { "id": "...", "class": "..." },
      "sentences": ["급한 생활비, 대출 연체..."]
    }
  ]
}
```

`form_guide` 블록의 `attributes`에는 `source`(placeholder, aria-label, title 중 어디서 왔는지)와, 해당될 때 `duplicates_visible_text: true`가 들어간다. 문장은 마침표·물음표·느낌표 뒤 공백에서 나누는 간이 규칙으로 자르고, 소수점("3.5%", "2026.06.22")에서는 자르지 않는다.

---

### difficulty_engine.py — 한국어 인지 난이도 분석 엔진

**입력:** `result_text.json`  
**출력:** `result_text_difficulty.json`

text_extractor.py가 분류한 텍스트 블록을 카테고리별로 분석하여 인지 난이도 점수를 산출한다. 기존 도구(WAVE, Lighthouse)가 코드 구조만 검사하는 것과 달리, 이 엔진은 **콘텐츠 자체의 인지적 어려움**을 측정한다.

**종합 점수 산출 — Jo(2016) 국어 이독성 공식 기반**

paragraph 블록에는 아래 공식을 적용하여 학년 수준(GL)을 산출한다.

```
GL = 4.874 + 0.591 × A − 9.201 × B³

A = 평균 문장 길이 (어절 수)  → 길수록 어려움
B = 쉬운 단어 비율 (국립국어원 A+B등급 일반명사 / 전체 일반명사)  → 높을수록 쉬움
    고유명사(NNP)는 2026-10-02부터 세지 않는다. 일반명사가 5개 미만이면 B와 GL을 계산하지 않는다.
```

2026-09-27 수정: 예전 코드는 A 항의 부호가 `−`로 원 논문과 반대였다. 그래서 문장이 길수록 쉽다고 계산됐고, 평균 문장 길이가 약 6.55어절을 넘으면 난이도 점수가 항상 0이 되어 최댓값이 약 35.2점에 묶여 있었다. 원식대로 `+`로 고쳤다.

출처: 조용구(2016). 글의 수준을 평가하는 국어 이독성 공식. 독서연구 제41호, pp.71-91.  
논문의 공식 구조를 채택하되, 어휘 목록은 국립국어원 학습용 어휘 등급(A/B/C, 5543개)으로 대체하여 공공 웹 콘텐츠 도메인에 맞게 적용했다. A+B등급(2888개)을 쉬운 단어로 정의한다.

GL은 아래 공식으로 0~100 난이도 점수로 변환된다.

```
difficulty_score = clip((GL − 1) / 11 × 100, 0, 100)      GL 1 → 0점, GL 12 → 100점
수정 제안 기준   = difficulty_score 72.7 이상 (= GL 9)

page_score = 100 − (paragraph difficulty_score 평균)
                 − 위치 의존 감점 (건당 3점, 최대 15점)
                 − UI 텍스트 길이 감점 (건당 2점, 최대 20점)      0 미만은 0
```

`page_score`는 run_all.py가 텍스트 모듈 점수로 쓴다. `difficulty_score_v2`와 명사 나열은 여기에 들어가지 않는다(아래).

**보조 지표 및 감점**

| 지표 | 기준 | 감점 |
|---|---|---|
| 평균 문장 길이 | 25어절 이상이고 문장 끝 부호(. ? !)가 있는 글이면 플래그 | — |
| 쉬운 단어 비율 | 60% 미만이면서 난이도 점수가 기준(72.7) 이상일 때만 원인 설명으로 플래그 | — |
| 읽기 수준 초과 | 난이도 점수가 기준(72.7) 이상인데 위 두 원인 플래그가 없으면 점수 자체를 플래그로 남김 (10/2 점검에서 추가) | — |
| 위치 의존 표현 | "위의 버튼", "여기 클릭" 등 탐지 (모든 종류, 2026-10-02부터 table·list·alert·other 포함) | 건당 3점, 최대 15점 |
| UI 텍스트 길이 초과 | 카테고리별 기준 초과 시 | 건당 2점, 최대 20점 |
| 명사 나열 (10/2 추가) | 조사 없이 명사로만 된 어절이 4개 이상 연속이고 문장 끝 부호가 있는 글이면 플래그 | — (수정 제안만) |

**위치 의존 표현 탐지 패턴 (KWCAG 1.3.3)**

| 패턴 | 설명 |
|---|---|
| `위의?`, `아래의?`, `옆의?` | 방향성 참조 (앞 글자가 한글·숫자·`/`면 제외 — "2위" 같은 순위 표현) |
| `오른쪽의?`, `왼쪽의?` | 위치 참조 |
| `해당 (버튼\|메뉴\|링크\|항목\|페이지)` | 모호한 참조 |
| `(여기\|이곳)를? 클릭` | 모호한 클릭 유도 |

**카테고리별 분석 수준**

| 카테고리 | 적용 분석 |
|---|---|
| paragraph | Jo(2016) 공식 전체 + 위치 의존 표현 탐지. 명사 5개 미만이면 어려운 단어(C·D등급) 2개 이상일 때 보조 플래그. 고유명사(NNP)는 세지 않음. 플래그가 하나라도 있으면 수정 제안 대상(기준 72.7 이상인 문단은 항상 원인 플래그나 "읽기 수준 초과"를 받음) |
| button / link / label / form_guide / heading | 텍스트 길이 기준(20/30/40/50/60자) + 위치 의존 표현 탐지. 보이는 글을 그대로 담은 title·aria-label은 길이 검사 제외 |
| table / list / alert / other | 평균 문장 길이(문장 끝 부호가 있는 글만) + 위치 의존 표현 탐지(2026-10-02 추가) |
| 모든 카테고리 | 명사 나열 (문장 끝 부호가 있는 글만) |

UI 문구(button·link·label·form_guide·heading)와 table·list·alert·other에는 어휘 검사를 하지 않는다. 짧은 문단과 같은 "어려운 단어 2개 이상" 규칙을 UI 문구에 적용해 보면 10개 사이트 UI 문구 1,381개 중 620개(45%)가 걸리고(C등급 2개 이상으로 좁혀도 169개), "검색어를 입력해 주세요", "학부모게시판" 같은 오탐이 많았다. 학습용 어휘 목록이 "입력", "게시판", "안내"를 고급(C) 단어로 보기 때문이다. 대신 모든 블록의 `metrics.hard_noun_count`에 개수를 기록해 두고, 어휘 목록을 바꾸거나 2차 설문 뒤 다시 판단한다.

짧은 글에 Jo 공식을 쓰지 않는 것은 짧은 글이 쉬워서가 아니라 공식으로 잴 수 없어서다. 문장이 끝나지 않는 조각 글은 평균 문장 길이가 의미가 없고, 명사가 적으면 쉬운 단어 비율이 한 단어에 크게 흔들린다. 1차 설문에서 가장 어렵다고 평가된 두 글은 오히려 평균 문장 길이 3.5·4.3어절로 가장 짧은 편이었다.

**임계값 설계 근거** (2026-10-02 개정)

| 임계값 | 값 | 근거 |
|---|---|---|
| 문장 길이 | 25어절 | GOV.UK 콘텐츠 지침의 문장 상한 25단어를 어절에 대응. 기존 표기 "국립국어원 '쉬운 한국어' 가이드라인"은 원문을 확인하지 못함. 영어 단어와 어절은 같은 단위가 아니라는 한계 있음 |
| 난이도 점수 플래그 기준 | 72.7점 이상 (= GL 9) | WCAG 2.2 3.1.5(읽기 수준)의 "중학교 수준(초등 입학 후 9년)". 설문 58쌍 실측에서 이전 기준 40점은 쉽다고 평가된 수정문의 91%도 걸러 구분하지 못했음(Youden J 0.07 → GL 9 기준 0.28) |
| 쉬운 단어 비율 최솟값 | 60% | 자체 설계값. 설문 후보 58쌍에서 쉽게 고친 수정문도 54개 중 40개(74%)가 60% 미만이라(원문 84%) 원문과 거의 구분하지 못함. 그래서 단독 위반으로 쓰지 않고, 난이도 점수가 기준을 넘은 문단의 원인 설명으로만 붙임 |
| 고유명사 제외 | NNP 제외 | WCAG 2.2 3.1.5가 "고유명사와 제목을 제거한 뒤" 읽기 수준을 판단하라고 명시 |
| 짧은 문단 어려운 단어 수 | 2개 이상 | 1개 기준은 짧은 문단의 62%에 붙었고 "검색", "유튜브" 같은 흔한 말이 대부분이었음. 코드에 미리 적어 둔 "과탐지가 많으면 2 이상으로" 규칙을 적용 |
| UI 텍스트 길이 | 20/30/40/50/60자 | 근거 자료 없음(경험값). 30자 넘는 링크 대부분이 뉴스·공지 제목이라 재검토 필요 |
| 명사 나열 | 명사로만 된 어절 4개 연속 | 문화체육관광부·국어문화원연합회 "쉬운 우리말 쓰기"(2020)가 명사 나열 문장을 이해하기 어려운 표현으로 꼽고, 조사·서술어를 넣어 풀어 쓰라고 권함. 기준 4는 캠페인 예시 "사후 평가 결과 반영"의 길이 |

모든 카테고리에서 "플래그가 있음"과 `needs_suggestion`(수정 제안 필요)이 같다. 플래그마다 `standard_issues`에 WCAG·KWCAG 항목이 붙어 백엔드가 그대로 저장한다.

10개 사이트(9/14 실행 9곳 + 9/28 네이버) 재분석 결과, 수정 제안 대상 블록이 609개에서 301개로(이후 명사 나열 추가로 308개, 그중 6개는 "읽기 수준 초과"), 기준을 넘는 문단이 90%(149/165)에서 36%(55/151)로 줄었다. 문장 길이 플래그는 8건에서 2건(실제 긴 문장 1건, "공유재산이란?"이 섞인 메뉴 덩어리 1건)으로, 위치 참조는 2건("2위 하락")에서 0건으로, form_guide 길이 위반은 10건에서 3건으로 줄었다.

**명사 나열 지표와 종합 난이도 v2 (2026-10-02 추가, 검증 전)**

1차 설문(폼1 22개 글)의 체감 난이도와 순위 상관을 지표별로 탐색해, 체감 난이도와 같은 방향으로 움직이는 지표를 엔진에 더했다.

- `metrics.noun_eojeol_run`: 조사·어미 없이 명사류로만 된 어절이 가장 길게 이어진 개수. 글 전체를 한 번에 형태소 분석한 뒤 어절별로 나눠 센다. 쉼표·괄호 같은 문장부호가 든 어절, 숫자·로마자가 든 어절에서 끊고, 붙여 쓴 합성어("건강보험료")는 1개로 센다.
- `metrics.hard_noun_count`: 어려운 일반명사(C·D등급) 개수. 비율과 달리 짧은 글에서 왜곡되지 않는 참고 지표.
- `difficulty_score_v2` = (Jo 난이도 점수 + 명사 나열 점수) / 2. 명사 나열 점수는 1어절 0점, 4어절 50점, 7어절 이상 100점. 두 하위 점수를 같은 비중으로 더한 이유는, 22개 글로 가중치를 맞추면 그 22개에만 맞는 값이 나오기 때문이다(같은 비중이 작은 표본에서 더 안정적이라는 Dawes, 1979).
- `meta.readability.avg_difficulty_v2`: 문단 v2 평균.

1차 설문 탐색 결과 (같은 20개 글 기준, Spearman):

| 지표 | ρ | p |
|---|---|---|
| Jo 난이도 점수 (기존) | 0.06 | 0.80 |
| 글자 수 (비교 기준) | 0.15 | 0.53 |
| 명사 나열 길이 | 0.30 | 0.19 |
| **종합 난이도 v2** | **0.30** | 0.19 |
| 어려운 단어 개수 (참고, v2에 미포함) | 0.47 | 0.04 |

원문·수정문 58쌍에서는 명사 나열 4어절 이상이 원문 23개, 수정문 2개였고, v2 평균은 원문 58.8점, 수정문 39.8점이었다(Wilcoxon p<0.001).

**주의:** 이 22개 글은 지표를 고르는 데 쓴 탐색 자료이고 모두 링크·안내 문구 조각이다. 여기서 나온 상관은 증명이 아니다. 그래서 검증 전까지 페이지 점수와 "수정 제안 필요" 판정은 기존 Jo 점수를 그대로 쓰고, v2는 결과에 기록만 한다. 명사 나열 플래그는 수정 제안만 붙고 감점은 없다.

**2차 설문 검증 계획 (설문 전에 고정)**

- 대상: 실제 공공기관 본문 페이지의 문단 약 30개. GL 구간별로 고르게 뽑고, 같은 구간 안에서 길이를 섞는다. 폼 3개 × 12개(공통 2 + 고유 10), 글마다 1~5점 체감 난이도 1문항.
- 주 지표: 글별 체감 난이도 평균과 `difficulty_score_v2`의 Spearman ρ와 95% 신뢰구간. GL은 100점에서 잘리지 않도록 원값(`metrics.gl_score`)도 같이 본다.
- 성공 기준: v2의 ρ ≥ 0.5이고 신뢰구간이 0을 포함하지 않으며, 글자 수의 ρ보다 높을 것. 0.3~0.5는 부분 성공.
- 같은 데이터로 Jo 점수, 명사 나열 길이, 어려운 단어 개수, 글자 수를 함께 비교한다.
- 2차 결과로 v2 공식을 다시 고치면, 그 결과는 다시 탐색 자료가 된다.

10개 사이트에서 명사 나열 플래그는 17건 붙었다. 국민건강보험공단의 "소득 부과 건강보험료 조정 정산 제도"(7어절) 같은 실제 사례와 함께, `div`로 만든 메뉴 덩어리(봉화군청, 홈택스)도 2건 걸렸다. 메뉴를 문단으로 추출하는 쪽의 문제다.

**알려진 한계**
- 쉬운 단어 목록인 국립국어원 학습용 어휘(2003)는 외국인 학습자용이다. "안내", "가능", "지원"이 C등급, "검색", "정책", "확대"가 목록 밖(D)이라 한국어 모어 화자 기준으로는 어려운 단어가 과대 추정된다. 10개 사이트 문단 명사의 약 42%가 목록 밖이었다.
- 페이지 점수(`100 − 문단 난이도 평균 − 감점`)는 이번에 바꾸지 않았다. 쉽다고 평가된 수정문도 난이도 점수가 평균 68점이라, 실제 사이트의 텍스트 모듈 점수가 0~45점에 몰린다.

---

### suggestion_generator.py — 수정 제안 생성기

**입력:** `result_text_difficulty.json`  
**출력:** `result_text_suggestions.json`

difficulty_engine.py가 위반으로 판정한 블록들에 대해 수정 가이드를 자동 생성한다. 두 가지 방식을 병행한다.

**방식 1 — 규칙 기반 템플릿 (항상 동작)**

플래그 유형별로 미리 작성된 수정 가이드를 반환한다. OpenAI API 키 없이도 동작하며, LLM 호출이 활성화된 경우에도 함께 제공된다.

| 플래그 유형 | 제안 내용 | 저장되는 표준 참조 |
|---|---|---|
| 문장 길이 과다 | 접속사로 이어진 문장을 마침표로 분리 | WCAG 3.1.5 읽기 수준 (KWCAG 직접 대응 없음) |
| 어려운 어휘 과다 | C/D등급 어휘 목록 제시 + 쉬운 단어 대체 예시 | WCAG 3.1.5 읽기 수준 (KWCAG 직접 대응 없음) |
| 어려운 어휘 포함(표본 부족) | 짧은 문단의 어려운 단어 목록 + 일상어로 바꾸기 | WCAG 3.1.5 읽기 수준 (2026-10-02 매핑 추가. 예전에는 기준 번호 없이 KWCAG에 없는 "3.1.1"이 적혀 있었음) |
| 위치 참조 / 모호한 참조 | 구체적 이름 사용 ("위의 버튼" → "'제출' 버튼") | WCAG 1.3.3 → KWCAG 5.3.3 명확한 지시사항 제공 |
| 링크 텍스트 길이 초과 | 목적지를 간결하게, 부가 설명은 링크 밖으로 | WCAG 2.4.4 → KWCAG 6.4.3 적절한 링크 텍스트 |
| 버튼 텍스트 길이 초과 | 동작을 2~4단어로 표현 | WCAG 2.4.4 → KWCAG 6.4.3 적절한 링크 텍스트 |
| form_guide·label 길이 초과 | 자세한 설명은 별도 안내 텍스트로 분리 | WCAG 3.3.2 → KWCAG 7.3.2 레이블 제공 |
| heading 길이 초과 | 제목을 간결하게 요약 | WCAG 2.4.6 → KWCAG 6.4.2 제목 제공 |
| 명사 나열 (10/2 추가) | 명사 사이에 조사·서술어를 넣어 풀어 쓰기 ("사후 평가 결과 반영" → "사후 평가 결과를 반영하여") | WCAG 3.1.5 읽기 수준 (KWCAG 직접 대응 없음) |
| 읽기 수준 초과 (10/2 점검에서 추가) | 긴 문장을 마침표로 나누고, 마침표 없이 이어 붙인 제목·날짜·설명은 줄을 나누거나 문장으로 정리 | WCAG 3.1.5 읽기 수준 (KWCAG 직접 대응 없음) |

**방식 2 — LLM 수정 제안 (OpenAI GPT API, 조건부)**

난이도 엔진의 측정 수치(평균 문장 길이, 어휘 등급 상세, 종합 난이도 점수)를 프롬프트에 포함하여 원문을 실제로 쉽게 다시 쓴 수정문과 수정 이유를 생성한다.

측정은 자체 엔진이 수행하고, LLM은 분석 결과를 바탕으로 수정안만 제시하는 역할 분담이 핵심이다.

**LLM 호출 대상 및 비용 관리**

| 조건 | 대상 |
|---|---|
| paragraph이고 난이도 점수 50 이상 | LLM 호출 (2026-10-02부터 수정 제안 기준이 72.7이라, 50~72점 문단은 위치 의존 표현·명사 나열로 수정 제안 대상이 됐을 때만 해당) |
| link 또는 form_guide이고 텍스트 40자 이상 | LLM 호출 |
| 그 외 | 규칙 기반 제안만 제공 |
| 최대 호출 수 | 20건/실행 (MAX_LLM_CALLS, 실패한 호출 포함) |
| 동시 호출과 시간 예산 | 4건씩 동시에(LLM_CONCURRENCY), 전체 80초 안에서만(LLM_TIME_BUDGET_SECONDS). run_all.py의 단계 제한 시간 120초 안에 끝내기 위해서 |
| 사용 모델 | gpt-4o-mini (temperature 0.3, max_tokens 500, 실패 시 2번 재시도) |
| STUDY_MODE=1 | 설문용 원문·수정문 쌍을 모을 때 위 조건을 풀고 최대 60건까지 호출 |

출력 블록에는 `standard_issues`, `suggestions`(유형, 문제, 가이드, `wcag_ref`, `kwcag_items`, 우선순위), `llm_revision`(수정문, 이유, 모델명, 안 불렀거나 실패하면 null)이 붙는다. `meta.suggestion_stats`에 제안 수와 LLM 호출·성공 건수가 기록된다.

---

### korean_vocab_grades.json — 국립국어원 학습용 어휘 등급 사전

difficulty_engine.py의 쉬운 단어 비율(B 변수) 계산에 사용되는 어휘 목록이다.

등급은 학교 학년이 아니라 한국어 학습자(주로 외국인)의 학습 단계다.

| 등급 | 수준 | 어휘 수 | 엔진에서의 취급 |
|---|---|---|---|
| A | 초급 | 894개 | 쉬운 단어 |
| B | 중급 | 1,994개 | 쉬운 단어 |
| C | 고급 | 2,655개 | 어려운 단어 |
| D | 목록에 없음 (코드상 표기) | - | 어려운 단어 (행정·전문 용어 대부분) |

출처: 국립국어원 (2003), 공공누리 제1유형.  
A+B등급 합계 2,888개를 Jo(2016) 공식의 "쉬운 단어"로 정의하여 적용한다. 동사·형용사도 들어 있지만 엔진은 일반명사만 비교한다. 외국인 학습자용 목록이라 "안내", "입력"처럼 한국어 모어 화자에게 쉬운 말도 C등급이나 목록 밖으로 잡히는 한계가 있다.

---

## 관련 접근성 표준 항목

WCAG 번호는 `mapping.js`를 통해 KWCAG 2.2로 변환한다. KWCAG에 직접 대응하지 않는 읽기 수준은 WCAG 번호를 그대로 보존한다.

| 저장 항목 | 내용 | 담당 기능 |
|---|---|---|
| WCAG 3.1.5 읽기 수준 | 문장의 인지적 난이도 | Jo(2016) 이독성 공식(읽기 수준 초과), 문장 길이, 어려운 어휘(비율·짧은 문단), 명사 나열(2026-10-02 추가) |
| KWCAG 5.3.3 명확한 지시사항 제공 | 위치·방향·색상 참조 금지 | 위치 의존 표현 탐지 |
| KWCAG 6.4.3 적절한 링크 텍스트 | 링크·버튼 텍스트 명확성 | 텍스트 길이 기준 검사 |
| KWCAG 7.3.2 레이블 제공 | 입력 필드 안내 문구 | form_guide·label 길이 검사 |
| KWCAG 6.4.2 제목 제공 | 제목 텍스트 명확성 | heading 길이 검사 |

---

## 기존 도구와의 차이

| 구분 | WAVE / Lighthouse | text-level-analyzer |
|---|---|---|
| 검사 대상 | HTML 코드 구조 | 텍스트 콘텐츠 자체 |
| 문장 난이도 측정 | ✗ | ✓ (Jo(2016) 이독성 공식) |
| 어휘 난이도 측정 | ✗ | ✓ (국립국어원 A/B/C 등급) |
| 명사 나열 탐지 | ✗ | ✓ (형태소 분석, 2026-10-02) |
| 위치 의존 표현 탐지 | ✗ | ✓ (패턴 매칭) |
| 수정문 자동 생성 | ✗ | ✓ (LLM + 규칙 기반 템플릿) |
