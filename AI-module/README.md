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
├── rule-based-analyzer/     # 모듈 1: 규칙 기반 코드 분석 (Node.js, 설명서 README(rule-based).md)
├── text-level-analyzer/     # 모듈 2: 문장 난이도 + 수정 제안 (Python, 설명서 README(text-level).md)
├── cv-analyzer/             # 모듈 3: 시각 명암비 분석 (Python, 설명서 README(CV).md)
├── tests/                   # run_all.py 단위 테스트 (점수 계산, 팝업 처리, CV 측정)
├── output/                  # 결과 파일 (실행 시 자동 생성)
├── run_all.py               # 통합 실행기
├── standard_mapping.py      # 파이썬 모듈이 mapping.js의 KWCAG 대조표를 읽어 오는 다리
├── requirements.txt         # Python 패키지 (버전 고정)
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
| excluded-regions.js | 광고와 두 번 불러올 때 내용이 바뀐 영역을 표시하고, 그 안의 위반을 점수 대상과 분리 |
| hidden-elements.js | 분석 화면 폭에서 렌더링되지 않는 요소를 스냅샷에 표시해 텍스트 분석이 같은 기준을 쓰게 함 |
| cv-anchors.js | CV 캡처 시점의 보이는 요소마다 문서 좌표·선택자·내용 서명(글자, 이미지 경로)을 `result_cv_anchors.json`에 기록 |
| popup-layers.js | 접속 직후 본문을 가리는 레이어 팝업을 찾아 따로 검사한 뒤 닫음 |
| artifact.js | typed locator를 만들고 annotation을 포함한 내부 분석용 DOM snapshot 직렬화 |
| adapter.js | axe-core 결과를 KWCAG 항목으로 매핑하는 어댑터 |
| mapping.js | KWCAG 33개 항목의 매핑 데이터 (axe 규칙 ID, 심각도, 가중치). `standard_mapping.py`를 거쳐 텍스트·CV 모듈도 이 표를 쓴다 |
| scorer.js | 100점 감점 방식 점수 계산 (심각도 × 가중치 × 위반 요소 수, 등급 없음) |
| test/ | Node 테스트 8개 파일 (`npm test`, 실제 Chromium을 띄움) |

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

**숨김 요소:** axe 검사가 끝난 뒤 실제 브라우저의 계산된 스타일로 `display:none`, `hidden` 속성,
`visibility:hidden`(보이는 자식이 없을 때), `content-visibility:hidden`인 요소에 `data-ua-hidden`을 붙인다.
분석 화면 폭(PC)에서 어떤 사용자에게도 전달되지 않는 콘텐츠라서 axe와 CV처럼 텍스트 분석도 읽지 않는다.
PC에서는 숨겨진 모바일 전용 공지 목록이 대표적이며, 같은 문장이 보이는 영역에 있으면 그쪽이 분석된다.
스크린리더 전용 텍스트(잘려 있거나 화면 밖으로 밀린 요소)와 투명한 요소는 스크린리더가 읽으므로 표시하지 않고,
캐러셀 슬라이드는 슬라이드별로 검사하므로 제외한다. 표시한 개수는 `metadata.hidden_element_count`에 남는다.
열어야 보이는 메뉴·탭·팝업은 아직 열린 상태로 검사하지 않는다.

**캐러셀 경로:** 캐러셀 검사가 슬라이드에 붙이는 임시 속성(`data-ua-audit-*`)을 axe가 선택자에 쓰면,
저장 전에 그 요소의 구조 경로(가장 가까운 고유 id와 `태그:nth-of-type`)로 바꾼다. 실시간 페이지에는 임시 속성이 없기 때문이다.

**제외 영역:** 사이트의 고정 콘텐츠가 아닌 영역은 모든 검사와 점수에서 빼고 따로 보고한다.

| 사유 | 판정 |
|---|---|
| `AD` | 광고 표식(`ins.adsbygoogle`, `data-ad-slot`, `aria-label="광고"` 등)이나 광고 서버 주소의 iframe. 두 번 모두 같은 광고가 나와도 제외한다. 페이지 안에 직접 그려진 광고도 대체 텍스트나 `aria-label`이 "[광고]"로 시작하면 감싸는 링크째 제외한다(네이버 상단 헤드라인 광고) |
| `DYNAMIC` | 쿠키·저장소가 비어 있는 새 브라우저 컨텍스트에서 페이지를 한 번 더 불러와 비교했을 때 글자·이미지 주소·iframe 주소가 달라졌거나 한쪽 로드에만 있는 요소(방문마다 탭·레이아웃이 바뀌는 추천 피드). 하위 내용의 절반 이상이 바뀐 부모까지(페이지 면적의 25% 이하) 넓혀 목록 전체를 묶는다. 두 번째 로드가 분석 페이지 요소의 절반도 공유하지 않으면 오류·차단 화면으로 보고 비교하지 않는다 |
| `POPUP` | 접속 직후 화면의 20% 이상을 덮는 fixed/absolute, z-index 100 이상 레이어(공지·이벤트 팝업). 팝업이 열린 상태에서 **세 모듈 모두** 팝업을 따로 검사한다: 규칙 기반은 팝업만 axe 검사, 텍스트는 팝업 내용을 `result_popup.html`로 저장해 같은 추출기(`--popup-layer`)·난이도 엔진으로 검사, CV는 팝업 부분만 캡처해 같은 CV 분석기로 검사(규칙 엔진이 이미 찾은 명도 대비 요소와 겹치면 뺌). 결과는 모두 `POPUP` 사유로 따로 보고하고 점수(규칙 점수, 난이도 page_score, CV 통과율)에는 넣지 않는다. 그다음 팝업의 닫기 버튼("닫기", "오늘 하루 보지 않기" 등)을 누르고 항상 `display:none`으로 숨긴 뒤 두 번째 로딩 비교, 본문 axe 검사, DOM snapshot, CV 이미지가 팝업이 닫힌 화면을 본다 |

사이트 캐러셀과 슬라이드 배너는 `carousel-audit.js`가 모든 슬라이드를 검사하므로 `DYNAMIC`으로 보지 않는다.
바뀌지 않는 배너와 광고 신호가 없는 자체 커머스 영역도 두 번 불러와 같으면 그대로 검사한다.
정적 fallback(`INITIAL_RESPONSE_STATIC`)은 비교할 두 번째 응답이 없어 `AD`만 적용한다.

두 번째 로딩을 새 컨텍스트에서 여는 이유: 첫 로딩과 같은 컨텍스트를 쓰면 첫 방문 때 사이트가 심은 쿠키(방문 기록, "오늘 하루 보지 않기" 등)를 들고 들어가 사이트가 재방문자로 판단한다.
그러면 "다시 오신 것을 환영합니다" 같은 재방문자용 문구나 쿠키를 보고 바꾼 스타일처럼 원래 고정된 요소가 바뀐 것으로 보여 `DYNAMIC`으로 잘못 빠지고, 쿠키가 언제 심어졌느냐에 따라 실행마다 결과도 달라진다.
두 로딩을 모두 처음 방문한 사용자 상태로 맞춰 실제로 방문마다 바뀌는 콘텐츠(뉴스·방문자 수·추천 피드)만 `DYNAMIC`으로 잡는다.
첫 방문마다 확인 화면을 띄우는 사이트(Cloudflare 등)는 두 번째 로딩이 다시 확인 화면일 수 있는데, 이때는 위의 공유 요소 50% 미만 조건에 걸려 비교 자체를 하지 않으므로 잘못 제외하는 일은 없다.

팝업을 점수에서 빼는 이유: 팝업은 행사·공지 기간에만 떠서 점수에 넣으면 같은 사이트 점수가 측정일마다 흔들린다(동적 영역과 같은 논리). 그래도 기관이 만든 콘텐츠이고 키보드로 닫을 수 없는 팝업처럼 실제 장벽이 될 수 있어 세 모듈 모두 검사해 리포트에 따로 보여준다. 광고·동적 영역은 사이트 콘텐츠가 아니라서 검사 자체를 하지 않는다는 점이 다르다.

표시한 요소에는 `data-ua-excluded-region` 속성을 남기고, `result_api.json`에 다음을 기록한다.

- `metadata.excluded_regions`: 최상위 제외 영역의 사유와 문서 좌표(CSS px)
- `excluded_violations`: 사유별 `{reason, violations, unmapped_violations}`. 형식은 점수 대상 위반과 같다
- `metadata.popup_layers`: 찾아서 닫은 레이어 팝업의 id·문서 좌표, 닫기 버튼 클릭 여부, 팝업 안 명도 대비 위반 요소 좌표(`color_contrast_boxes`, CV 중복 제거용). 팝업은 `data-ua-popup` 속성으로 표시한다
- 팝업 텍스트 블록: `text_difficulty`·`text_suggestions`의 `results` 뒤에 `exclusion_reason: "POPUP"`으로 붙는다(`meta.page_score`는 본문만으로 계산)
- 팝업 CV 위반: `cv_visual.excluded_violations`에 `reason: "POPUP"`으로 붙는다(좌표는 본문 CV와 같은 스크린샷 px)

텍스트 추출기는 이 속성(`data-ua-excluded-region`)과 `data-ua-hidden`이 붙은 요소를 읽지 않고, CV 분석기는 텍스트 상자 중심이 제외 영역 안에 있으면
통과율 표본에서 빼고 위반만 `excluded_violations`(사유 포함)에 남긴다. 백엔드는 제외 위반을
`exclusion_reason`과 함께 저장하되 점수와 문제 수에는 넣지 않고, 최종 리포트는 별도 항목으로 보여준다.

**CV 위반의 요소 연결:** CV 좌표는 스크린샷 기준이라 위쪽 콘텐츠 높이나 화면 폭이 달라지면 라이브 화면에서
엉뚱한 곳을 가리킨다. `run_all.py`는 CV 위반 상자 중심을 덮는 가장 작은 요소(`result_cv_anchors.json`)를 찾아
`locator`(선택자, 문서 좌표, `content: {text, image}`)로 붙인다. 라이브 리포트는 그 요소를 따라가고, 요소의
글자나 이미지 경로가 분석 때와 다르면 마커를 숨기고 ‘분석 이후 내용이 바뀜’으로 표시한다. 요소를 찾지 못한
위반은 기존처럼 좌표만 남는다.

---

### 모듈 2: text-level-analyzer (문장 난이도 분석)

**언어:** Python  
**역할:** 웹페이지 문장의 인지 난이도를 측정하고, 어려운 문장에 대한 수정 제안을 생성한다.

| 파일 | 역할 |
|------|------|
| text_extractor.py | HTML에서 분석 대상 텍스트를 추출하고 10개 카테고리로 분류 |
| difficulty_engine.py | MeCab 형태소 분석 기반 난이도 점수 산출. 문단은 Jo(2016) 이독성 공식(평균 문장 길이 + 쉬운 단어 비율 → 학년 수준 GL), UI 문구는 글자 수, 그 밖의 조각 글은 문장 길이를 본다. 위치 의존 표현과 명사 나열은 모든 글에서 탐지 |
| suggestion_generator.py | 난이도 높은 문장에 대해 규칙 기반 + GPT-4o-mini 수정 제안 생성 |
| text_standard_mapper.py | 난이도 플래그마다 WCAG 2.2 번호와 대응 KWCAG 항목을 붙임(`standard_issues`) |
| compute_pair_difficulty.py | 설문 원문·수정문 쌍에 같은 공식을 사후 적용 |
| export_study_pairs.py | 설문용 원문·수정문 블라인드 쌍 추출 (1차 설문 때 사용) |
| korean_vocab_grades.json | 국립국어원 학습용 어휘 등급 사전 (A·B등급 = 쉬운 단어) |
| test_*.py | 단위 테스트 5개 파일 (`test_difficulty_engine.py`는 MeCab 필요) |

**위반 기준 (2026-10-02 개정):**

- 문단 난이도 72.7점 이상(= GL 9, WCAG 3.1.5의 중학교 수준). 원인을 함께 적는다: 쉬운 단어 비율 60% 미만이면 "어려운 어휘 과다", 원인 플래그가 없으면 "읽기 수준 초과".
- 일반명사 5개 미만이라 공식을 못 쓰는 짧은 문단은 어려운 단어(학습용 어휘 C등급이나 목록 밖) 2개 이상.
- 평균 문장 길이 25어절 이상(문단·표·목록·알림·기타, 문장 끝 부호가 있는 글만).
- 명사로만 된 어절 4개 이상 연속(명사 나열, 모든 종류, 문장 끝 부호가 있는 글만, 감점 없음).
- 위치 의존 표현(모든 종류, "위의 버튼", "여기 클릭". 숫자 뒤 "N위"는 제외).
- UI 문구 글자 수(버튼 20·링크 30·레이블 40·안내 50·제목 60자). 보이는 글을 그대로 담은 title·aria-label은 제외.

고유명사는 어려운 단어로 세지 않는다. 버튼·링크 같은 UI 문구에는 어휘 검사를 하지 않는다(지금 어휘 목록으로는 오탐이 45%라 보류, 개수만 `metrics.hard_noun_count`에 기록). 플래그가 하나라도 붙은 블록이 수정 제안 대상(`needs_suggestion`)이고, 플래그마다 `standard_issues`에 기준 번호와 우선순위가 붙어 백엔드가 이슈의 기준 번호와 심각도로 저장한다. 기준별 근거와 실측은 `text-level-analyzer/README(text-level).md`에 있다.

**텍스트 모듈 점수:** `page_score = 100 − 문단 난이도 평균 − 위치 의존 감점(건당 3, 최대 15) − UI 글자 수 감점(건당 2, 최대 20)`.

**종합 난이도 v2 (검증 전):** `difficulty_score_v2 = (Jo 난이도 점수 + 명사 나열 점수) / 2`를 결과에 함께 기록한다. 2차 설문으로 검증하기 전까지 페이지 점수(`meta.page_score`)와 수정 제안 판정에는 쓰지 않는다.

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

**색상 측정:** 배경색은 텍스트 상자 안의 최빈색, 글자색은 상자 안에서 일정 비율 이상을 차지하면서
배경과 가장 대비가 큰 색으로 잡는다. 상자 바깥은 버튼·배너 밖의 페이지 배경일 수 있어 쓰지 않는다. 글자가 배경보다 어둡다고 가정하지 않으므로 어두운
배경의 밝은 글씨도 측정한다. 대표색은 양자화 구간이 아니라 실제 픽셀의 평균이다.

**판정 제외:** 글자색·배경색을 구분할 수 없는 텍스트는 위반·통과 어디에도 세지 않고
`summary.skipped_unmeasured`에 기록한다. `|`, `/`, `▼`처럼 기호만 인식된 결과도 다른 텍스트와 같이
판정한다. 인식한 텍스트가 모두 제외되면 `NO_MEASURABLE_TEXT` 사유의 미측정 결과가 된다.

**규칙 엔진과의 중복:** 결과 통합 단계에서 CV 위반 상자의 50% 이상이 규칙 엔진 `color-contrast`
위반 요소의 문서 좌표와 겹치면 CV 위반 목록에서 뺀다(스크린샷 픽셀은 `deviceScaleFactor`로 나눠
CSS px로 맞춘다). 위치를 표시할 수 있는 규칙 엔진 결과를 남기며, 뺀 건수는
`summary.duplicate_rule_violations`에 기록한다. CV 통과율(총점)은 바꾸지 않는다.

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

규칙 기반 Step 1은 axe 검사 전에 받은 문서가 대상 페이지인지 확인한다. 다음 경우에는 검사와 점수를 만들지 않고
`result_api.json`에 `metadata.document_health`만 기록한 뒤 종료 코드 2로 끝난다.

| 상태 | 판정 |
|---|---|
| `HTTP_ERROR` | 리다이렉트 뒤 최종 문서 응답이 4xx·5xx. 본문이 있어도 오류 화면으로 본다 |
| `EMPTY` | 보이는 글자 20자 미만이고 보이는 이미지·링크·입력 요소도 없음. 늦게 채워지는 본문을 위해 최대 15초 더 확인한다 |
| `BLOCKED` | 출처와 관계없이, 보이는 글자 600자 이하·링크 4개 이하의 짧은 문서에 보안 확인·자동 접근 차단 문구가 있음. 출처가 바뀐 봇 확인 화면에서 쓸 초기 HTML이 없을 때도 해당한다 |

본문 측정은 열린 Shadow DOM 안의 글자와 요소도 포함한다. CAPTCHA 입력칸이 있는 일반 페이지는 자체 본문과 링크가
있어 차단 화면으로 보지 않는다. `run_all.py`는 세 상태를 대상 페이지 접근 실패(종료 코드 2, 백엔드
`TARGET_PAGE_UNAVAILABLE`)로 처리하며 점수로 저장하지 않는다.

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

교차 출처 이동 판정에는 URL(`captcha`, `botmanager`, `challenge`, `/deny/`, `bot-check`), 정부24 MBuster 차단 주소(`/mbuster`),
Cloudflare 대기 화면 표식(`_cf_chl_`, `cf-chl-`, "Just a moment...", "Checking if the site connection is secure")을 함께 본다.
MBuster와 Cloudflare 표식은 그것만으로 차단으로 본다. Cloudflare·DataDome 태그가 심긴 정상 페이지는 차단으로 보지 않는다.

### 프론트엔드에 내려줄 때

대시보드에 필요한 데이터는 전부 `result_final.json` 안에 있음:
- 총점/등급 → `total_score`, `grade`
- 모듈별 점수 → `score_breakdown.module_scores`
- 위반 항목 리스트 → `modules.rule_based.violations`
- 수정 가이드 → `modules.text_suggestions`
- 명암비 위반 → `modules.cv_visual.violations`
- 분석 당시 화면 크기 → `capture_metadata`

---

## 테스트

```powershell
cd rule-based-analyzer; npm test; cd ..                                  # Node 8개 파일, 43개
.\.venv\Scripts\python -m unittest discover -s tests                   # run_all·팝업·CV 측정, 48개
.\.venv\Scripts\python -m unittest discover -s text-level-analyzer -p "test_*.py"   # 44개 (MeCab 필요)
.\.venv\Scripts\python cv-analyzer\test_contrast_formula.py            # 명암비 공식 대조
```

2026-10-02 기준 모두 통과. Node 테스트는 가끔 파일 단위로 "Unable to deserialize cloned data" 오류가 나는데, 테스트 러너 쪽 오류라 다시 돌리면 통과한다.

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
| result_text_difficulty.json | 블록별 난이도 점수·플래그·`standard_issues`, `meta.page_score`, 종합 난이도 v2(참고값) |
| result_text_suggestions.json | 블록별 수정 제안 |
| result_cv.json | CV 텍스트별 명암비 + 수정 추천 색상 (입력 이미지 경로 미포함) |
| result_cv_anchors.json | CV 캡처 시점의 요소 위치·선택자·내용 서명 (CV 위반을 요소에 연결) |
| result_popup.html | 레이어 팝업이 있을 때 닫기 전에 저장한 팝업 내용 |
| result_popup_text.json, result_popup_text_difficulty.json | 팝업 텍스트 추출·난이도 결과 (`POPUP`, 점수 제외) |
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

- **OpenAI API 키:** `text-level-analyzer/.env` 파일에 `OPENAI_API_KEY=...`(상위 폴더 `AI-module/.env`에 두어도 읽힘, 환경변수가 있으면 그 값 우선). 없으면 LLM 호출만 건너뛰고 규칙 기반 제안을 사용한다.
- **Google Vision 자격증명:** `GOOGLE_APPLICATION_CREDENTIALS`에 서비스 계정 JSON 경로를 지정한다. 없거나 잘못되면 CV 모듈만 실패로 기록한다.
- **MeCab 사전:** 현재 Windows 설정은 `C:\mecab\share\mecab-ko-dic\`을 사용한다. 사전이 없으면 난이도와 수정 제안 모듈만 건너뛴다.

자격증명과 `.env`는 `.gitignore`에 포함되므로 로컬에만 설정한다. 이 선택 설정이 없어도
규칙 기반 평가가 성공하면 성공한 모듈만으로 가중치를 재분배해 부분 분석 결과를 완료한다.
점수를 산출하는 모듈이 모두 실패하면 `result_final.json`은 진단용으로만 남기고,
백엔드에 0점 결과를 저장하지 않은 채 0이 아닌 종료 코드로 끝난다.
