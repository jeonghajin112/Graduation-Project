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
└── korean_vocab_grades.json 국립국어원 학습용 어휘 등급 사전 (A/B/C 등급, 5543개)
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
  suggestion_generator.py → output/result_text_suggestions.json
                ↓
[run_all.py]
  세 모듈 결과 통합 → result_final.json → 백엔드 전송
```

run_all.py가 세 단계를 순서대로 자동 실행하므로, 개별 실행은 개발·디버깅 목적으로만 사용한다.

---

## 실행 방법

### 전체 파이프라인 (권장)

프로젝트 루트에서 run_all.py를 실행하면 이 모듈의 세 단계가 자동으로 순서대로 실행된다.

```bash
cd graduation_project
python run_all.py https://example.go.kr
```

### 단계별 개별 실행 (디버깅용)

```bash
# Step 1 — 텍스트 추출
python text_extractor.py output/result.html
# → output/result_text.json 생성

# Step 2 — 난이도 분석
python difficulty_engine.py output/result_text.json
# → output/result_text_difficulty.json 생성

# Step 3 — 수정 제안 생성
python suggestion_generator.py output/result_text_difficulty.json
# → output/result_text_suggestions.json 생성
```

출력 파일명을 직접 지정하려면 두 번째 인자로 경로를 넘긴다.

```bash
python text_extractor.py output/result.html output/my_text.json
```

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

```bash
pip install beautifulsoup4 python-dotenv requests
pip install mecab-python3
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

프로젝트 루트의 `.env` 파일에 아래와 같이 저장한다.

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

| 카테고리 | 대상 | 난이도 분석 기준 |
|---|---|---|
| `paragraph` | p, article, section 등 | Jo(2016) 이독성 공식 전체 적용 (핵심 대상) |
| `heading` | h1~h6 | 텍스트 길이 기준 (60자 초과 시 플래그) |
| `button` | button, input[submit] | 텍스트 길이 기준 (20자 초과 시 플래그) |
| `link` | a 태그 | 텍스트 길이 기준 (30자 초과 시 플래그) |
| `label` | label, legend | 텍스트 길이 기준 (40자 초과 시 플래그) |
| `form_guide` | placeholder, aria-label, title 속성 | 텍스트 길이 기준 (50자 초과 시 플래그) + 위치 의존 표현 탐지 |
| `table` | th, td, caption | 문장 길이 기준 (25어절 초과 시 플래그) |
| `list` | li, dt, dd | 문장 길이 기준 (25어절 초과 시 플래그) |
| `alert` | role=alert, role=status | 문장 길이 기준 (25어절 초과 시 플래그) |
| `other` | em, strong 등 인라인 | 문장 길이 기준 (25어절 초과 시 플래그) |

처리 과정은 5단계로 구성된다.

1. 불필요한 태그 제거: `script`, `style`, `svg`, `iframe` 등 자연어 분석 대상이 아닌 태그를 DOM에서 완전히 삭제한다.
2. HTML 주석 제거: `<!-- -->` 형태의 개발자 메모를 제거한다.
3. 숨겨진 요소 제거: `display:none`, `aria-hidden="true"`, `role="dialog"`, 모달·팝업·로딩 관련 class/id 요소를 제거한다. 정부24 실제 테스트 중 대기열 페이지(TRACER)·모달이 분석 대상으로 잡히는 문제가 발견되어 추가된 단계다.
4. 요소 순회 + 텍스트 수집: 남은 HTML 요소를 순회하며 카테고리로 분류하고 텍스트를 수집한다. `nav`, `footer`, `header` 내부는 반복 메뉴·저작권 표시이므로 건너뛴다. `div`, `section` 같은 컨테이너는 자식 블록 요소가 있으면 직접 텍스트만 수집하여 중복 수집을 방지한다.
5. form_guide 별도 추출: `placeholder`, `aria-label`, `title` 속성값은 태그의 텍스트 노드가 아닌 속성에 들어 있으므로 별도로 추출한다.

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
      "sentences": ["급한 생활비, 대출 연체..."]
    }
  ]
}
```

---

### difficulty_engine.py — 한국어 인지 난이도 분석 엔진

**입력:** `result_text.json`  
**출력:** `result_text_difficulty.json`

text_extractor.py가 분류한 텍스트 블록을 카테고리별로 분석하여 인지 난이도 점수를 산출한다. 기존 도구(WAVE, Lighthouse)가 코드 구조만 검사하는 것과 달리, 이 엔진은 **콘텐츠 자체의 인지적 어려움**을 측정한다.

**종합 점수 산출 — Jo(2016) 국어 이독성 공식 기반**

paragraph 블록에는 아래 공식을 적용하여 학년 수준(GL)을 산출한다.

```
GL = 4.874 − 0.591 × A − 9.201 × B³

A = 평균 문장 길이 (어절 수)
B = 쉬운 단어 비율 (국립국어원 A+B등급 명사 / 전체 명사)
```

출처: 조용구(2016). 글의 수준을 평가하는 국어 이독성 공식. 독서연구 제41호, pp.71-91.  
논문의 공식 구조를 채택하되, 어휘 목록은 국립국어원 학습용 어휘 등급(A/B/C, 5543개)으로 대체하여 공공 웹 콘텐츠 도메인에 맞게 적용했다. A+B등급(2888개)을 쉬운 단어로 정의한다.

GL은 아래 공식으로 0~100 난이도 점수로 변환된다.

```
difficulty_score = clip((GL − 1) / 11 × 100, 0, 100)
페이지 점수 = 100 − difficulty_score
```

**보조 지표 및 감점**

| 지표 | 기준 | 감점 |
|---|---|---|
| 평균 문장 길이 | 25어절 이상 시 플래그 | — |
| 쉬운 단어 비율 | 60% 미만 시 플래그 | — |
| 위치 의존 표현 | "위의 버튼", "여기 클릭" 등 탐지 | 건당 3점, 최대 15점 |
| UI 텍스트 길이 초과 | 카테고리별 기준 초과 시 | 건당 2점, 최대 20점 |

**위치 의존 표현 탐지 패턴 (KWCAG 1.3.3)**

| 패턴 | 설명 |
|---|---|
| `위의?`, `아래의?`, `옆의?` | 방향성 참조 |
| `오른쪽의?`, `왼쪽의?` | 위치 참조 |
| `해당 (버튼\|메뉴\|링크\|항목\|페이지)` | 모호한 참조 |
| `(여기\|이곳)를? 클릭` | 모호한 클릭 유도 |

**카테고리별 분석 수준**

| 카테고리 | 적용 분석 |
|---|---|
| paragraph | Jo(2016) 공식 전체 + 위치 의존 표현 탐지 |
| button / link / label / form_guide / heading | 텍스트 길이 기준 + 위치 의존 표현 탐지 |
| table / list / alert / other | 평균 문장 길이 기준만 |

**임계값 설계 근거**

| 임계값 | 값 | 근거 |
|---|---|---|
| 문장 길이 | 25어절 | 국립국어원 '쉬운 한국어' 가이드라인 |
| 쉬운 단어 비율 최솟값 | 60% | 자체 설계값 (10개 사이트 테스트 전까지 조정 보류) |
| 난이도 점수 플래그 기준 | 40점 이상 | 자체 설계값 |

---

### suggestion_generator.py — 수정 제안 생성기

**입력:** `result_text_difficulty.json`  
**출력:** `result_text_suggestions.json`

difficulty_engine.py가 위반으로 판정한 블록들에 대해 수정 가이드를 자동 생성한다. 두 가지 방식을 병행한다.

**방식 1 — 규칙 기반 템플릿 (항상 동작)**

플래그 유형별로 미리 작성된 수정 가이드를 반환한다. OpenAI API 키 없이도 동작하며, LLM 호출이 활성화된 경우에도 함께 제공된다.

| 플래그 유형 | 제안 내용 | KWCAG 참조 |
|---|---|---|
| 문장 길이 과다 | 접속사로 이어진 문장을 마침표로 분리 | 3.1.1 읽기 쉬운 콘텐츠 |
| 어려운 어휘 과다 | C/D등급 어휘 목록 제시 + 쉬운 단어 대체 예시 | 3.1.1 읽기 쉬운 콘텐츠 |
| 위치 참조 / 모호한 참조 | 구체적 이름 사용 ("위의 버튼" → "'제출' 버튼") | 1.3.3 감각적 특성에 의존하지 않는 콘텐츠 |
| 링크 텍스트 길이 초과 | 목적지를 간결하게, 부가 설명은 링크 밖으로 | 2.4.4 링크 목적 식별 |
| 버튼 텍스트 길이 초과 | 동작을 2~4단어로 표현 | 2.4.4 링크 목적 식별 |
| form_guide 길이 초과 | 자세한 설명은 별도 안내 텍스트로 분리 | 3.3.2 레이블 또는 설명 제공 |

**방식 2 — LLM 수정 제안 (OpenAI GPT API, 조건부)**

난이도 엔진의 측정 수치(평균 문장 길이, 어휘 등급 상세, 종합 난이도 점수)를 프롬프트에 포함하여 원문을 실제로 쉽게 다시 쓴 수정문과 수정 이유를 생성한다.

측정은 자체 엔진이 수행하고, LLM은 분석 결과를 바탕으로 수정안만 제시하는 역할 분담이 핵심이다.

**LLM 호출 대상 및 비용 관리**

| 조건 | 대상 |
|---|---|
| paragraph이고 난이도 점수 50 이상 | LLM 호출 |
| link 또는 form_guide이고 텍스트 40자 이상 | LLM 호출 |
| 그 외 | 규칙 기반 제안만 제공 |
| 최대 호출 수 | 20건/실행 (MAX_LLM_CALLS) |
| 사용 모델 | gpt-4o-mini |

---

### korean_vocab_grades.json — 국립국어원 학습용 어휘 등급 사전

difficulty_engine.py의 쉬운 단어 비율(B 변수) 계산에 사용되는 어휘 목록이다.

| 등급 | 수준 | 어휘 수 |
|---|---|---|
| A | 초급 (초등) | 894개 |
| B | 중급 (중등) | 1,994개 |
| C | 고급 (고등) | 2,655개 |

출처: 국립국어원 (2003), 공공누리 제1유형.  
A+B등급 합계 2,888개를 Jo(2016) 공식의 "쉬운 단어"로 정의하여 적용한다.

---

## 관련 KWCAG 항목

이 모듈이 주로 커버하는 KWCAG 2.2 항목은 다음과 같다.

| KWCAG 항목 | 내용 | 담당 기능 |
|---|---|---|
| 3.1.1 읽기 쉬운 콘텐츠 | 문장의 인지적 난이도 | Jo(2016) 이독성 공식 |
| 1.3.3 감각적 특성에 의존하지 않는 콘텐츠 | 위치·방향·색상 참조 금지 | 위치 의존 표현 탐지 |
| 2.4.4 링크 목적 식별 | 링크·버튼 텍스트 명확성 | 텍스트 길이 기준 검사 |
| 3.3.2 레이블 또는 설명 제공 | 입력 필드 안내 문구 | form_guide 길이 검사 |

---

## 기존 도구와의 차이

| 구분 | WAVE / Lighthouse | text-level-analyzer |
|---|---|---|
| 검사 대상 | HTML 코드 구조 | 텍스트 콘텐츠 자체 |
| 문장 난이도 측정 | ✗ | ✓ (Jo(2016) 이독성 공식) |
| 어휘 난이도 측정 | ✗ | ✓ (국립국어원 A/B/C 등급) |
| 위치 의존 표현 탐지 | ✗ | ✓ (패턴 매칭) |
| 수정문 자동 생성 | ✗ | ✓ (LLM + 규칙 기반 템플릿) |
