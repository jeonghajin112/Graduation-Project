"""
============================================================
 한국어 인지 난이도 분석 엔진 (difficulty_engine.py)
 웹페이지 텍스트의 인지적 난이도를 측정하는 자체 설계 엔진
============================================================

[파일 목적]
  웹페이지에서 추출한 텍스트가 노인/인지약자에게 얼마나 어려운지를
  자동으로 측정하고, 위반 플래그를 생성하는 엔진.

[기존 도구와의 차이]
  기존 도구: HTML 코드만 검사 (alt 태그 유무, 색 대비 등)
  본 엔진:   콘텐츠 자체의 인지적 난이도를 측정
             → 코드상으로 문제없어도 "내용이 어려워서 이해 못하는" 경우를 잡아냄

[종합 점수 산출 방식 — Jo(2016) 국어 이독성 공식 기반]
  GL(Grade Level) = 4.874 + 0.591 × A - 9.201 × B³
    (2026-09-27 수정: 문장 길이 항의 부호를 원 논문대로 +로 고침. 예전 코드는
     -였기 때문에 문장이 길수록 오히려 쉽다고 계산되었음.)
    A  = 평균 문장 길이 (어절 수)
    B  = 쉬운 단어 비율 (국립국어원 학습용 어휘 A+B등급 / 전체 일반명사,
         2026-10-02부터 고유명사 제외)
    GL = 학년 수준 (낮을수록 쉬움, 높을수록 어려움)

  출처: Jo, YongGu (2016). 글의 수준을 평가하는 국어 이독성 공식.
        독서연구 제41호, pp.71-91.
  적용: 논문의 공식 구조를 채택하되, 어휘 목록은 국립국어원 학습용
        어휘 등급(A/B/C, 5543개)으로 대체하여 공공 웹 콘텐츠 도메인에
        적합하게 적용. A+B등급(2888개)을 쉬운 단어로 정의.

  GL → 0~100 점수 정규화:
    difficulty_score = clip((GL - 1) / 11 × 100, 0, 100)
    (GL 1 → 점수 0, GL 12 → 점수 100)
    즉, GL은 1~12 범위인데, 이걸 0~100 범위로 선형 변환하여 점수로 사용.
  수정 제안 기준: difficulty_score 72.7 이상 (= GL 9, 2026-10-02 변경, 이전 40)
               원인 플래그(문장 길이·어려운 어휘)가 없으면 '읽기 수준 초과' 플래그를 붙임
  페이지 점수 = 100 - (paragraph difficulty_score 평균) - 위치 의존 감점 - 길이 감점
               (높을수록 읽기 쉬움, 0 미만은 0)

[보조 지표]
  - 위치 의존 표현: 건당 3점 감점 (최대 15점)
  - UI 텍스트 길이 위반: 건당 2점 감점 (최대 20점)
  -> 위치의존표현은 UI 텍스트 길이 위반보다 더 심각한 문제로 간주.
  - 명사 나열(2026-10-02): 명사로만 된 어절 4개 이상 연속이면 플래그(감점 없음).
  - 종합 난이도 v2(2026-10-02, 검증 전): (Jo 점수 + 명사 나열 점수) / 2.
    결과에 같이 기록만 하고 페이지 점수에는 아직 쓰지 않는다.

[파이프라인 내 위치]
  text_extractor.py → [이 파일] difficulty_engine.py → suggestion_generator.py

[사용법]
  python difficulty_engine.py result_text.json
  python difficulty_engine.py result_text.json output.json
"""

import json
import re
import sys
import os
import MeCab

from text_standard_mapper import classify_text_block


# ─────────────────────────────────────────
# 0. 어휘 사전 로딩 (국립국어원 학습용 어휘 등급)
# ─────────────────────────────────────────
# A등급(초급) 894개, B등급(중급) 1994개, C등급(고급) 2655개, 총 5543개
# 출처: 국립국어원 (2003), 공공누리 제1유형
# 쉬운 단어(EASY) = A+B등급 합계 2888개 → Jo(2016) B 변수에 적용

_VOCAB_DICT_PATH = os.path.join(os.path.dirname(__file__), 'korean_vocab_grades.json')
with open(_VOCAB_DICT_PATH, 'r', encoding='utf-8') as _f:
    VOCAB_GRADES = json.load(_f)

EASY_GRADES = {'A', 'B'}  # 쉬운 단어 기준: 논문의 5,000개 목록 역할


# ─────────────────────────────────────────
# 1. MeCab 래퍼 (형태소 분석 인터페이스)
# ─────────────────────────────────────────

try:
    if os.name == 'nt':
        _tagger = MeCab.Tagger('-r C:/mecab/etc/mecabrc -d C:/mecab/share/mecab-ko-dic')
    else:
        # Mac Homebrew paths for mecab-ko-dic
        if os.path.exists('/opt/homebrew/lib/mecab/dic/mecab-ko-dic'):
            _tagger = MeCab.Tagger('-r /opt/homebrew/etc/mecabrc -d /opt/homebrew/lib/mecab/dic/mecab-ko-dic')
        elif os.path.exists('/usr/local/lib/mecab/dic/mecab-ko-dic'):
            _tagger = MeCab.Tagger('-r /usr/local/etc/mecabrc -d /usr/local/lib/mecab/dic/mecab-ko-dic')
        else:
            _tagger = MeCab.Tagger()
except Exception:
    _tagger = MeCab.Tagger()


def parse_morphemes(text):
    """문장을 형태소 분석하여 (표층형, 품사) 리스트를 반환."""
    parsed = _tagger.parse(text)
    morphemes = []
    for line in parsed.strip().split('\n'):
        if line == 'EOS' or line == '':
            continue
        parts = line.split('\t')
        if len(parts) < 2:
            continue
        surface = parts[0]
        pos = parts[1].split(',')[0]
        morphemes.append((surface, pos))
    return morphemes
     # ex) → [('접근성', 'NNG'), ('을', 'JKO'), ('개선', 'NNG'), ('한다', 'XSV+EC')]


def extract_nouns(text):
    """텍스트에서 명사(NNG, NNP)만 추출하여 리스트로 반환."""
    morphemes = parse_morphemes(text)
    return [surface for surface, pos in morphemes if pos in ('NNG', 'NNP')]


def extract_common_nouns(text):
    """
    텍스트에서 일반명사(NNG)만 추출. 고유명사(NNP)는 뺀다.

    [2026-10-02 근거] WCAG 2.2 성공 기준 3.1.5(읽기 수준)는 읽기 수준을
    "고유명사와 제목을 제거한 뒤(after removal of proper names and titles)" 판단하라고
    명시한다. 기관명·지명·서비스명(보건복지부, 청량산, 유튜브 등)은 더 쉬운 말로 바꿀 수
    없어서, 어려운 단어로 세면 고칠 수 없는 감점과 수정 제안이 생긴다. 국립국어원
    학습용 어휘 목록에는 고유명사가 없으므로 지금까지는 전부 D등급(어려운 단어)으로
    세어졌다.
    """
    morphemes = parse_morphemes(text)
    return [surface for surface, pos in morphemes if pos == 'NNG']


# ─────────────────────────────────────────
# 2. Jo(2016) 이독성 공식 — A 변수: 평균 문장 길이
# ─────────────────────────────────────────

THRESHOLD_SENTENCE_LENGTH = 25  # 플래그 기준 (25어절 이상이면 인지 부담 높음)
# [근거] GOV.UK 콘텐츠 지침의 문장 길이 상한 25단어("Sentence length: why 25 words is
# our limit", Inside GOV.UK 블로그, 2014)를 띄어쓰기 단위인 어절에 대응시킨 값이다.
# 영어 단어와 한국어 어절은 같은 단위가 아니므로 한국어 사용자 대상 검증은 남아 있다.

# 문장 끝 문장부호. 이것이 하나도 없는 글(메뉴·기관명 나열, 게시판 제목 목록 등)은
# 문장이 아니라 낱말 나열이라 "평균 문장 길이"가 블록 전체 어절 수가 되어 버린다.
# [2026-10-02] 10개 사이트 실측에서 "문장 길이 과다" 8건 중 7건이 이런 나열(사이트맵의
# 기관명 목록, 게시판 제목 목록, 메뉴 전체)이었고, 진짜 긴 문장 1건은 마침표가 있었다.
# 그래서 문장 길이 플래그는 문장부호가 있는 글에만 붙인다. Jo(2016) 공식의 A 변수
# 계산(calc_avg_sentence_length)은 그대로 둔다.
_SENTENCE_TERMINATOR = re.compile(r'[.!?。](?!\d)')


def has_sentence_terminator(text):
    """마침표·물음표·느낌표 같은 문장 끝 부호가 있는지. 숫자 사이 마침표(3.5)는 제외."""
    return bool(_SENTENCE_TERMINATOR.search(_protect_decimal_points(text)))


def sentence_length_flag(text, avg_sent_len):
    """평균 문장 길이 기준을 넘고, 실제로 문장으로 쓰인 글이면 플래그 문구를 반환."""
    if avg_sent_len >= THRESHOLD_SENTENCE_LENGTH and has_sentence_terminator(text):
        return f'문장 길이 과다: 평균 {avg_sent_len:.1f}어절 (기준: {THRESHOLD_SENTENCE_LENGTH}어절)'
    return None

# ── 문장 분리 보정: 숫자 사이의 마침표는 문장 구분자가 아님 ──
# 기존 정규식 r'[.!?。]\s*'는 '.' 뒤에 공백이 0개여도 매칭되므로
# "3.5%", "2026.06.22", "5.3.3" 같은 소수점/버전 표기가 전부
# 별도 문장으로 쪼개져 평균 문장 길이(A 변수)가 실제보다 부풀려지는
# 문제가 있었다. 공공기관 텍스트에는 수수료(%), 날짜, 조항 번호 등
# 숫자.숫자 표기가 매우 흔하므로 실사용 시 영향이 큼.
# → 분리 전에 숫자 사이의 마침표를 임시 문자로 치환해 보호한다.
_DECIMAL_POINT = re.compile(r'(?<=\d)\.(?=\d)')
_DECIMAL_PLACEHOLDER = ''  # 유니코드 사설 영역(private use area) 문자 — 실제 텍스트와 충돌 안 함


def _protect_decimal_points(text):
    """숫자.숫자 형태의 마침표를 문장 분리에서 보호하기 위해 임시 치환."""
    return _DECIMAL_POINT.sub(_DECIMAL_PLACEHOLDER, text)


def calc_avg_sentence_length(text):
    """
    평균 문장 길이(어절 수)를 계산. Jo(2016) 공식의 A 변수.
    반환: (평균 어절 수, 전체 어절 수)
    """
    protected = _protect_decimal_points(text)
    sentences = re.split(r'[.!?。]+\s*', protected)
    # '저는 학생입니다. 반갑습니다!' → ['저는 학생입니다', '반갑습니다', '']
    # '수수료는 3.5%입니다.' → ['수수료는 3.5%입니다']  (보정 전에는 '3'과 '5%입니다'로 잘못 분리됨)
    sentences = [s.replace(_DECIMAL_PLACEHOLDER, '.').strip() for s in sentences if s.strip()]
    if not sentences:
        return 0.0, 0
    total_eojeols = sum(len(s.split()) for s in sentences)
    # 각 문장을 띄어쓰기로 쪼개서 어절 수를 세고 전부 더함
    avg = total_eojeols / len(sentences)
    return round(avg, 2), total_eojeols


# ─────────────────────────────────────────
# 3. Jo(2016) 이독성 공식 — B 변수: 쉬운 단어 비율
# ─────────────────────────────────────────
# 논문 원본: 약 5,000개 어휘 목록 대비 쉬운 단어 비율
# 본 적용:  국립국어원 A+B등급(2888개)을 쉬운 단어로 정의하여 대체

def get_word_grade(noun):
    """명사의 어휘 등급을 반환. A/B/C/D(미등재)"""
    # D는 등급 미등재 단어
    return VOCAB_GRADES.get(noun, 'D')


def calc_easy_word_ratio(text):
    """
    쉬운 단어 비율(B)을 계산. Jo(2016) 공식의 B 변수.
    쉬운 단어 = 국립국어원 A+B등급.
    명사 5개 미만이면 비율(ratio) 자체는 통계적으로 신뢰할 수 없으므로 None을
    반환한다 — 이 기준(5개)은 그대로 유지.
    다만 등급별 상세(grade_detail)와 전체 명사 목록은 명사 개수와 무관하게
    항상 계산해서 반환한다. GL 공식(비율 기반)은 못 돌리더라도, 짧은 텍스트에
    "어려운 단어가 하나라도 있는지" 같은 개별 단어 기준의 보조 판정에 쓰기 위함
    (2026-09-23: 짧은 paragraph가 통째로 검사망을 빠져나가는 문제 보완).
    2026-10-02부터 고유명사(NNP)는 세지 않는다(extract_common_nouns 참고).
    반환: (쉬운 단어 비율 또는 None, 쉬운 명사 목록, 전체 명사 목록, 등급별 상세)
    """
    nouns = extract_common_nouns(text)
    if not nouns:
        return None, [], [], {}

    grade_detail = {}
    for n in nouns:
        g = get_word_grade(n)
        grade_detail.setdefault(g, []).append(n)

    easy_nouns = [n for n in nouns if get_word_grade(n) in EASY_GRADES]

    if len(nouns) < 5:
        # 표본 부족 — ratio/GL 계산에는 안 쓰지만 등급 정보는 그대로 반환
        return None, easy_nouns, nouns, grade_detail

    ratio = len(easy_nouns) / len(nouns)
    # 쉬운 명사 비율 = 쉬운 명사 수 / 전체 명사 수
    return round(ratio, 3), easy_nouns, nouns, grade_detail


# ─────────────────────────────────────────
# 4. 보조 지표: 위치 의존 표현 탐지
# ─────────────────────────────────────────
# r'(?<![가-힣/])위의?\s'
#  ─────────────  ──  ─  ──
#       ①         ②  ③  ④

# ① (?<![가-힣/]) → 부정 후방탐색
#   '위' 앞에 한글이나 '/'가 오면 매칭 안 함
#   예: '서비스위의' → 건너뜀 (앞에 '스' 있음)
#       '위의 버튼'  → 매칭됨 (앞에 한글 없음)

# ② 위 → '위' 글자

# ③ 의? → '의'가 있어도 되고 없어도 됨
#   '위 버튼'도 잡고, '위의 버튼'도 잡음

# ④ \s → 공백 (띄어쓰기)
#   '위의버튼'처럼 붙어있으면 매칭 안 함

# [2026-10-02] 앞 글자 제외 목록에 숫자를 추가했다. "박스오피스 2위 하락"처럼 순위를
# 뜻하는 "N위"가 위치 참조로 잡히고 있었다(10개 사이트 실측에서 위치 참조 탐지 2건이
# 모두 이 경우). 숫자 바로 뒤의 "위"는 순위·등급이지 화면 위치가 아니다.
LOCATION_PATTERNS = [
    (re.compile(r'(?<![가-힣/0-9])위의?\s'), '위치 참조: "위(의)" 사용'),
    (re.compile(r'(?<![가-힣/0-9])아래의?\s'), '위치 참조: "아래(의)" 사용'),
    (re.compile(r'(?<![가-힣/0-9])옆의?\s'), '위치 참조: "옆(의)" 사용'),
    (re.compile(r'(?<![가-힣/0-9])오른쪽의?\s'), '위치 참조: "오른쪽(의)" 사용'),
    (re.compile(r'(?<![가-힣/0-9])왼쪽의?\s'), '위치 참조: "왼쪽(의)" 사용'),
    (re.compile(r'해당\s+(버튼|메뉴|링크|항목|페이지)'), '모호한 참조: "해당 ~" 사용'),
    (re.compile(r'(여기|이곳)를?\s*클릭'), '모호한 참조: "여기/이곳 클릭" 사용'),
]


def detect_location_dependency(text):
    """위치 의존 표현을 탐지하여 플래그 리스트 반환."""
    return [msg for pattern, msg in LOCATION_PATTERNS if pattern.search(text)]


# ─────────────────────────────────────────
# 4-2. 보조 지표: 명사 나열 (2026-10-02 추가)
# ─────────────────────────────────────────
# "소득 부과 건강보험료 조정 정산 제도"처럼 조사·서술어 없이 명사만 띄어 쓴 어절이
# 이어지면, 어느 말이 어느 말을 꾸미는지 알기 어렵다.
#
# [근거]
#   (1) 문화체육관광부·국어문화원연합회 "쉬운 우리말 쓰기" 캠페인(2020)이 명사 나열
#       문장을 "각 성분이 어떤 성분과 호응하는지 명확하지 않은" 표현으로 꼽고, 조사와
#       서술어를 넣어 풀어 쓰라고 권한다. 예: "사후 평가 결과 반영" → "사후 평가 결과를
#       반영하여".
#   (2) 1차 설문(폼1 22개 글)에서 체감 난이도와 같은 방향으로 움직였다(Spearman ρ 0.19,
#       유의하지 않음). 원문·수정문 58쌍에서는 이 지표가 4 이상인 글이 원문 23개, 수정문
#       2개로, 사람이 쉽다고 평가한 수정문에서는 거의 사라졌다.
#       단, 이 데이터는 지표를 고르는 데 쓴 탐색 자료라 2차 설문에서 다시 확인해야 한다.
#
# [세는 방법] 띄어쓰기 단위(어절)로 본다. 형태소가 전부 명사류(일반·고유·의존명사,
# 단위명사, 접두사·접미사)인 어절이 몇 개 연속되는지 센다.
#   - 조사·어미·동사가 하나라도 붙은 어절에서 끊긴다("결과를", "반영하여").
#   - 쉼표·괄호·마침표 같은 문장부호가 들어간 어절에서 끊긴다. "사업, 근로, 이자"처럼
#     쉼표로 나열한 것은 명사 나열이 아니라 목록이다.
#   - 숫자나 로마자가 들어간 어절에서 끊긴다. "2026년 9월 16일" 같은 날짜, 영어 문장이
#     명사 나열로 잡히지 않게 하기 위해서다.
#   - 한 어절 안에서 붙여 쓴 합성어("건강보험료")는 1개로 센다. 기관명처럼 원래 긴
#     고유명사가 형태소 수만큼 부풀려지는 것을 막는다.
_NOUN_STACK_TAGS = {'NNG', 'NNP', 'NNB', 'NNBC', 'XPN', 'XSN'}
_NOUN_STACK_BREAK = re.compile(r'[,·;:()\[\]{}<>「」『』“”"\'‘’|/…!?.。]')
_NOUN_STACK_NONWORD = re.compile(r'[0-9A-Za-z]')

NOUN_STACK_MIN_EOJEOLS = 4    # 플래그 기준. 위 캠페인 예시 "사후 평가 결과 반영"이 4어절
NOUN_STACK_FULL_EOJEOLS = 7   # 하위 점수 100점이 되는 길이(1어절 → 0점, 4어절 → 50점)


def _morphemes_by_eojeol(text):
    """
    글 전체를 한 번에 형태소 분석한 뒤 어절별로 나눠 돌려준다.
    어절 하나만 따로 분석하면 문맥이 없어 오분석된다("조사의"를 명사 하나로 봄).
    """
    eojeols = text.split()
    spans, pos = [], 0
    for e in eojeols:
        start = text.index(e, pos)
        spans.append((start, start + len(e)))
        pos = start + len(e)
    grouped = [[] for _ in eojeols]
    cursor, idx = 0, 0
    for surface, tag in parse_morphemes(text):
        found = text.find(surface, cursor)
        if found < 0:
            continue
        cursor = found + len(surface)
        while idx < len(spans) - 1 and found >= spans[idx][1]:
            idx += 1
        grouped[idx].append((surface, tag))
    return list(zip(eojeols, grouped))


def longest_noun_eojeol_run(text):
    """조사·어미 없이 명사류로만 된 어절이 가장 길게 연속된 개수."""
    run = best = 0
    for eojeol, parsed in _morphemes_by_eojeol(text):
        morphemes = [(s, p) for s, p in parsed if not p.startswith('S')]
        is_noun_only = (
            not _NOUN_STACK_NONWORD.search(eojeol)
            and bool(morphemes)
            and all(set(p.split('+')) <= _NOUN_STACK_TAGS for _, p in morphemes)
        )
        run = run + 1 if is_noun_only else 0
        best = max(best, run)
        if _NOUN_STACK_BREAK.search(eojeol):
            run = 0
    return best


def noun_stacking_score(run):
    """명사 나열 길이를 0~100 하위 점수로 바꾼다. 1어절 0점, 4어절 50점, 7어절 이상 100점."""
    span = NOUN_STACK_FULL_EOJEOLS - 1
    return round(max(0.0, min(100.0, (run - 1) / span * 100)), 1)


def noun_stacking_flag(text, run):
    """문장으로 쓰인 글에서 명사 나열이 기준 이상이면 플래그 문구를 반환."""
    if run >= NOUN_STACK_MIN_EOJEOLS and has_sentence_terminator(text):
        return (f'명사 나열: 조사 없이 명사만으로 된 어절 {run}개 연속 '
                f'(기준: {NOUN_STACK_MIN_EOJEOLS}개)')
    return None


def count_hard_common_nouns(text):
    """어려운 일반명사(C·D등급) 개수. 비율과 달리 글이 짧아도 왜곡되지 않는 참고 지표."""
    return sum(1 for n in extract_common_nouns(text) if get_word_grade(n) in ('C', 'D'))


# ─────────────────────────────────────────
# 4-3. 종합 난이도 v2 (2026-10-02 추가, 검증 전)
# ─────────────────────────────────────────
# difficulty_score_v2 = (Jo 공식 난이도 점수 + 명사 나열 하위 점수) / 2
#
# 두 하위 점수를 같은 비중으로 더한다. 1차 설문 22개 글로 가중치를 맞추면 그 22개에만
# 맞는 값이 나오기 때문에, 표본이 작을 때 회귀로 맞춘 가중치보다 같은 비중이 새 자료에서
# 더 안정적이라는 결과(Dawes, 1979, "The robust beauty of improper linear models")를 따랐다.
# 1차 설문(탐색 자료)에서는 체감 난이도와의 순위 상관이 Jo 점수 0.06 → v2 0.30으로
# 올랐지만(n=20, 유의하지 않음), 이 자료로 지표를 골랐으므로 증명이 아니다.
# 2차 설문(문단 30개)에서 Jo 점수·v2·글자 수를 같이 비교해 검증할 것.
# 검증 전까지 페이지 점수와 "수정 제안 필요" 판정은 기존 Jo 점수(difficulty_score)를 쓴다.

def calc_difficulty_score_v2(difficulty_score, noun_run):
    if difficulty_score is None:
        return None
    return round((difficulty_score + noun_stacking_score(noun_run)) / 2, 1)


# ─────────────────────────────────────────
# 5. Jo(2016) 공식 기반 종합 난이도 점수 산출
# ─────────────────────────────────────────

def calc_gl_score(avg_sentence_len, easy_word_ratio):
    """
    Jo(2016) 국어 이독성 공식으로 학년 수준(GL)을 계산.

    GL = 4.874 + 0.591 × A - 9.201 × B³
      A = 평균 문장 길이 (어절 수)  → 길수록 GL 상승(어려움)
      B = 쉬운 단어 비율 (0.0~1.0)  → 높을수록 GL 하락(쉬움)

    [2026-09-27 수정] 예전 코드는 `4.874 - 0.591*A - ...`로 A 항의 부호가
    원 논문과 반대였다. 그 결과 문장이 길수록 점수가 내려가고, 평균 문장 길이가
    약 6.55어절만 넘어도 난이도 점수가 항상 0이 되었으며, 난이도 점수의 이론적
    최댓값이 약 35.2점에 묶여 있었다. 원 논문 공식으로 고쳐 0~100 전 구간이
    나올 수 있게 됨.

    GL 해석: 낮을수록 쉬움. 일반적으로 1~12 범위.
    음수 GL = 매우 쉬운 텍스트 (단문 + 쉬운 단어).
    """
    gl = 4.874 + (0.591 * avg_sentence_len) - (9.201 * (easy_word_ratio ** 3))
    return round(gl, 2)


def gl_to_difficulty_score(gl):
    """
    GL(학년 수준)을 0~100 난이도 점수로 정규화.
      GL 1  → 난이도 0   (매우 쉬움)
      GL 12 → 난이도 100 (매우 어려움)
    GL 범위 밖은 0/100으로 clip.
    """
    score = (gl - 1) / 11 * 100
    return round(max(0.0, min(100.0, score)), 1)


# [기준값 이력]
# - 6월 설계값: 40점
# - 2026-09-23: 10점으로 하향. 당시 공식(GL = 4.874 - 0.591×A - 9.201×B³)은 A 항
#   부호가 뒤집혀 있어 난이도 점수 상한이 약 35.2점이었고, 40점은 절대 도달 불가능한
#   값이었기 때문(paragraph 534개 실측 최댓값 24.5).
# - 2026-09-27: 공식 부호를 원 논문대로 고치면서 상한 문제가 사라졌으므로 원래 설계값
#   40점(GL 약 5.4 = 초등 5학년 수준)으로 복원. 10점을 그대로 두면 고친 공식에서는
#   평범한 문단도 거의 전부 걸린다(예: 평균 10어절·쉬운 단어 60% → 70.9점).
#   고친 공식으로 실제 사이트를 다시 돌려 분포를 보고 필요하면 재조정할 것.
# - 2026-10-02: GL 9(= 72.7점)로 변경. 근거 두 가지.
#   (1) 외부 기준: WCAG 2.2 성공 기준 3.1.5(읽기 수준)는 "중학교 수준(lower secondary
#       education level, 초등 입학 후 9년)"보다 높은 읽기 능력을 요구하는 글을 문제로
#       본다. 한국 학제로 중학교 3학년 = GL 9.
#   (2) 실측: 설문에 쓴 원문·수정문 58쌍(수정문이 체감상 유의하게 쉬웠음, d=1.05)에
#       고친 공식을 적용하면, 40점 기준은 원문 57개 중 56개와 함께 "쉽다고 평가된"
#       수정문 57개 중 52개(91%)도 걸러 둘을 거의 구분하지 못했다(Youden J 0.07).
#       GL 9 기준(고유명사 제외 적용 후 53쌍)은 원문 39개, 수정문 24개를 걸러 구분력이
#       올라갔다(J 0.28).
#       10개 사이트 문단 중 걸리는 비율도 90%(149/165)에서 36%(55/151)로 내려간다.
#   한계: 어휘 목록을 원 논문 목록 대신 국립국어원 학습용 어휘(외국인 학습자용)로
#   바꿨기 때문에 같은 글도 GL이 높게 나오는 경향이 있다(쉬운 단어 비율이 낮게 잡힘).
#   설문 데이터상 구분력은 80~85점에서 가장 높았지만(J 0.47) 외부 근거가 없어 쓰지
#   않았다. 문단 단위 사람 평가로 다시 맞출 것.
THRESHOLD_GL = 9.0
THRESHOLD_DIFFICULTY_SCORE = round((THRESHOLD_GL - 1) / 11 * 100, 1)  # = 72.7, 이 점수 이상이면 수정 제안 필요

# "어려운 어휘 과다" 플래그의 쉬운 단어 비율 기준.
# [2026-10-02] 이 플래그는 난이도 점수가 기준(THRESHOLD_DIFFICULTY_SCORE)을 넘은 문단에만
# "원인 설명"으로 붙인다. 60%라는 값에는 근거가 없고, 설문 후보 58쌍에서 쉽게 고친
# 수정문도 54개 중 40개(74%, 중앙값 44%)가 60% 미만이었다(원문은 55개 중 46개, 84%).
# 학습용 어휘 목록이 작아서 생기는 현상이라 이 기준만으로는 원문과 수정문을 거의 못 가른다.
# (고유명사 제외 기준으로 다시 센 값, 2026-10-02 점검)
# 단독 위반으로 두면 문단 대부분(10개 사이트 실측 약 78%)에 붙어 아무것도 구분하지 못한다.
EASY_WORD_RATIO_MIN = 0.60

# 명사 5개 미만(비율/GL 계산 생략 대상)인 텍스트에서, 어려운 단어(C/D등급)가
# 몇 개 이상이면 "어려운 어휘 포함" 보조 플래그를 붙일지의 기준.
# 1로 두면 어려운 단어가 하나만 있어도 걸림 — 급식 메뉴 코드, 행정 용어 약어처럼
# 짧지만 어려운 파편 텍스트를 잡기 위한 의도적으로 민감한 값.
# D등급은 "국립국어원 목록에 없는 단어"라 고유명사·신조어까지 걸릴 수 있으므로,
# 실제 사이트에 돌려보고 과탐지가 많으면 이 값을 2 이상으로 올릴 것.
# [2026-10-02] 위 규칙대로 2로 올림. 10개 사이트 실측에서 1개 기준은 GL을 못 내는 짧은
# 문단 541개 중 337개(62%)에 붙었고, "검색", "행정", "공지사항", "유튜브", "연합뉴스"
# 같은 흔한 말·고유명사가 대부분이었다. 학습용 어휘 목록은 외국인 학습자용이라 "안내",
# "가능", "지원"이 C등급, "검색", "정책", "확대"가 목록 밖(D)이다. 2개 기준 + 고유명사
# 제외로 약 110개로 줄지만, 목록의 한계 때문에 여전히 흔한 말이 걸리는 경우가 남는다.
SHORT_TEXT_MIN_HARD_NOUNS = 2


# ─────────────────────────────────────────
# 6. 카테고리별 분석 (블록 단위)
# ─────────────────────────────────────────
#--------------------------------------------------------------------------
#    카테고리             적용 기준
#--------------------------------------------------------------------------
#    paragraph           Jo(2016) 공식 전체 + 위치 의존 탐지
#                        (문장 길이 + 쉬운 단어 비율 → GL → difficulty_score)
#                        단, 명사 5개 미만이면 비율/GL은 생략하고 "어려운 단어가
#                        2개 이상인가"만 개별 단어 기준으로 보조 판정(2026-09-23, 10-02)
#                        고유명사는 세지 않음(2026-10-02)
#                        점수가 기준을 넘었는데 원인 플래그가 없으면 "읽기 수준 초과"
#                        (2026-10-02). 문단은 플래그가 있으면 수정 제안 대상
#
#    button              글자수 > 20이면 플래그 + 위치 의존 탐지
#    link                글자수 > 30이면 플래그 + 위치 의존 탐지
#    label               글자수 > 40이면 플래그 + 위치 의존 탐지
#    form_guide          글자수 > 50이면 플래그 + 위치 의존 탐지
#                        (보이는 글을 그대로 담은 title·aria-label은 길이 검사 제외)
#    heading             글자수 > 60이면 플래그 + 위치 의존 탐지
#    ※ 20/30/40/50/60글자는 근거 자료가 확인되지 않은 경험값이다(2026-10-02 기준).
#
#    table               평균 문장 길이 ≥ 25어절이면 플래그 + 위치 의존 탐지
#    list                평균 문장 길이 ≥ 25어절이면 플래그 + 위치 의존 탐지
#    alert               평균 문장 길이 ≥ 25어절이면 플래그 + 위치 의존 탐지
#    other               평균 문장 길이 ≥ 25어절이면 플래그 + 위치 의존 탐지
#    ※ 문장 길이 플래그는 문장 끝 부호(. ? !)가 있는 글에만 붙인다(2026-10-02).
#    ※ 위치 의존 탐지는 2026-10-02에 이 네 종류에도 추가해 모든 종류 공통이 됐다.
#
#    모든 카테고리   명사로만 된 어절이 4개 이상 연속이면 "명사 나열" 플래그
#                   (문장 끝 부호가 있는 글만, 2026-10-02 추가, 4-2절)
#
#    [UI 문구 어휘 검사를 넣지 않은 이유, 2026-10-02]
#    button·link 등 UI 문구에도 "어려운 단어(C·D등급) 2개 이상" 규칙을 적용해 보면
#    10개 사이트 UI 문구 1,381개 중 620개(45%)가 걸리고, C등급 2개 이상으로 좁혀도
#    169개(12%)가 걸렸다. "검색어를 입력해 주세요", "학부모게시판", "온라인 상담문의"
#    같은 오탐이 많았다. 학습용 어휘 목록이 외국인 학습자용이라 "입력", "게시판",
#    "안내"가 고급(C) 단어로 잡히기 때문이다. 오탐 위반이 리포트를 덮지 않도록 위반으로는
#    넣지 않았다. 어려운 단어 개수는 모든 블록의 metrics.hard_noun_count에 기록되므로
#    2차 설문 뒤 어휘 목록과 함께 다시 판단한다.
#--------------------------------------------------------------------------
FULL_ANALYSIS_CATEGORIES = {'paragraph'}

# 카테고리별 최대 허용 텍스트 길이 (글자 수)
MAX_TEXT_LENGTH = {
    'button': 20,
    'link': 30,
    'label': 40,
    'form_guide': 50,
    'heading': 60,
}


def analyze_block(block):
    """
    개별 텍스트 블록을 분석하여 난이도 결과를 반환.
    카테고리에 따라 분석 수준을 다르게 적용.
    """
    text = block.get('text', '').strip()
    category = block.get('category', 'other')
    tag = block.get('tag', '')
    selector = block.get('selector', '')

    if not text or len(text) < 2:
        return None

    word_count = len(text.split())

    # 결과 dict 초기화
    result = {
        'text': text,
        'category': category,
        'tag': tag,
        'selector': selector,
        'metrics': {
            'avg_sentence_length': None,   # Jo(2016) A 변수
            'easy_word_ratio': None,       # Jo(2016) B 변수
            'gl_score': None,              # Jo(2016) 학년 수준 출력
            'word_count': word_count,
        },
        'flags': [],
        'difficulty_score': None,          # GL → 0~100 정규화
        'difficulty_score_v2': None,       # (Jo 점수 + 명사 나열 하위 점수) / 2, 검증 전
        'needs_suggestion': False,
    }

    # 기본 지표: 모든 카테고리 공통 계산
    avg_sent_len, total_eojeols = calc_avg_sentence_length(text)
    result['metrics']['avg_sentence_length'] = avg_sent_len
    noun_run = longest_noun_eojeol_run(text)
    result['metrics']['noun_eojeol_run'] = noun_run           # 명사 나열 길이(어절)
    result['metrics']['hard_noun_count'] = count_hard_common_nouns(text)  # 참고 지표

    # ── paragraph: Jo(2016) 공식 전체 적용 ──
    if category in FULL_ANALYSIS_CATEGORIES:
        easy_ratio, easy_nouns, all_nouns, grade_detail = calc_easy_word_ratio(text)

        if easy_ratio is not None:
            # Jo(2016) 공식으로 GL 및 난이도 점수 산출
            gl = calc_gl_score(avg_sent_len, easy_ratio)
            difficulty_score = gl_to_difficulty_score(gl)

            result['metrics']['easy_word_ratio'] = easy_ratio
            result['metrics']['easy_word_nouns'] = easy_nouns
            result['metrics']['grade_detail'] = grade_detail
            result['metrics']['total_noun_count'] = len(all_nouns)
            result['metrics']['gl_score'] = gl
            result['difficulty_score'] = difficulty_score
            result['difficulty_score_v2'] = calc_difficulty_score_v2(difficulty_score, noun_run)

            # 위반 플래그 생성
            length_flag = sentence_length_flag(text, avg_sent_len)
            if length_flag:
                result['flags'].append(length_flag)

            # 쉬운 단어 비율은 난이도 점수가 기준을 넘은 문단에서만 원인 설명으로 붙인다
            # (EASY_WORD_RATIO_MIN 주석 참고).
            if (difficulty_score >= THRESHOLD_DIFFICULTY_SCORE
                    and easy_ratio < EASY_WORD_RATIO_MIN and len(all_nouns) >= 5):
                hard_pct = round((1 - easy_ratio) * 100, 1)
                result['flags'].append(
                    f'어려운 어휘 과다: 쉬운 단어 비율 {easy_ratio*100:.1f}% '
                    f'(어려운 단어 {hard_pct}%, C등급+미등재 기준)')

        else:
            # 명사 5개 미만 — 비율/GL 계산은 생략(기준 유지)하되,
            # 있는 명사 중 어려운 단어가 기준 개수 이상이면 개별 단어 기준으로 보조 판정.
            # (짧은 파편 텍스트가 "명사 5개 미만"이라는 이유만으로 검사망을
            #  통째로 빠져나가던 문제 보완 — 2026-09-23)
            length_flag = sentence_length_flag(text, avg_sent_len)
            if length_flag:
                result['flags'].append(length_flag)

            hard_nouns_short = [n for n in all_nouns if get_word_grade(n) in ('C', 'D')]
            if len(hard_nouns_short) >= SHORT_TEXT_MIN_HARD_NOUNS:
                result['metrics']['grade_detail'] = grade_detail
                result['metrics']['total_noun_count'] = len(all_nouns)
                result['flags'].append(
                    f'어려운 어휘 포함(표본 부족): 명사 {len(all_nouns)}개 중 어려운 단어 '
                    f'{len(hard_nouns_short)}개({", ".join(hard_nouns_short[:5])}) — '
                    f'표본이 적어 비율 대신 개별 단어 기준으로 판정')

        # [2026-10-02] 점수가 기준을 넘었는데 원인 플래그(문장 길이·어려운 어휘)가 하나도
        # 붙지 않는 문단이 있었다. 쉬운 단어 비율이 60% 이상이고 문장 끝 부호가 없거나 평균
        # 문장이 25어절 미만인 경우다(10개 사이트 수정 제안 대상 308개 중 6개). 이런 블록은
        # standard_issues가 비어 백엔드에 "분류되지 않은 텍스트 접근성 이슈"로 저장되고
        # 템플릿 제안도 없었다. 원인 플래그가 없을 때만 점수 자체를 플래그로 남긴다.
        score = result['difficulty_score']
        has_cause_flag = any(('문장 길이 과다' in f) or ('어려운 어휘 과다' in f)
                             for f in result['flags'])
        if score is not None and score >= THRESHOLD_DIFFICULTY_SCORE and not has_cause_flag:
            result['flags'].append(
                f'읽기 수준 초과: 난이도 점수 {score}점 (기준: {THRESHOLD_DIFFICULTY_SCORE}점 = GL {THRESHOLD_GL:g})')

        loc_deps = detect_location_dependency(text)
        if loc_deps:
            result['flags'].extend(loc_deps)

        # 문단은 플래그가 하나라도 있으면 수정 제안 대상이다. 기준 점수를 넘은 문단은 위에서
        # 반드시 플래그를 받으므로, "점수 기준 초과 또는 플래그 있음"과 같다.
        # (예전에는 명사 5개 미만 문단의 문장 길이 플래그가 제안 대상이 되지 않았다.)
        if result['flags']:
            result['needs_suggestion'] = True

    # ── button, link, label, form_guide, heading: 길이 + 위치 의존 ──
    elif category in MAX_TEXT_LENGTH:
        max_len = MAX_TEXT_LENGTH[category]
        # [2026-10-02] title·aria-label이 그 요소에 보이는 글을 그대로 담고 있으면
        # (예: <a title="공고 제목 게시물로 이동">공고 제목</a>) 길이 검사는 보이는 글
        # 쪽(link 등)에서 이미 한다. 10개 사이트 실측에서 form_guide 길이 위반 10건 중
        # 8건이 이런 중복이라 같은 제목이 link와 form_guide로 두 번 감점되고 있었다.
        # 위치 의존 표현 검사는 그대로 한다.
        duplicates_visible = bool((block.get('attributes') or {}).get('duplicates_visible_text'))
        if len(text) > max_len and not duplicates_visible:
            result['flags'].append(
                f'{category} 텍스트 길이 과다: {len(text)}글자 (기준: {max_len}글자)')
            result['needs_suggestion'] = True

        loc_deps = detect_location_dependency(text)
        if loc_deps:
            result['flags'].extend(loc_deps)
            result['needs_suggestion'] = True

    # ── table, list, alert, other: 문장 길이 + 위치 의존 ──
    else:
        length_flag = sentence_length_flag(text, avg_sent_len) if word_count >= 5 else None
        if length_flag:
            result['flags'].append(length_flag)
            result['needs_suggestion'] = True

        # [2026-10-02] 위치 의존 표현 검사를 이 네 종류에도 적용했다. 문단과 UI 문구에는
        # 하던 검사인데 여기만 빠져 있어서, 목록 항목의 "위의 표를 참고하세요" 같은 글을
        # 잡지 못했다. 10개 사이트에서는 해당 사례가 없어 결과 변화는 없다.
        loc_deps = detect_location_dependency(text)
        if loc_deps:
            result['flags'].extend(loc_deps)
            result['needs_suggestion'] = True

    # ── 명사 나열: 모든 종류 공통 (문장 끝 부호가 있는 글만) ──
    stacking_flag = noun_stacking_flag(text, noun_run)
    if stacking_flag:
        result['flags'].append(stacking_flag)
        result['needs_suggestion'] = True

    # Standards metadata is produced before the optional suggestion/LLM step,
    # so the backend can persist correct criterion codes even if that later
    # step is unavailable.
    result['standard_issues'] = classify_text_block(result)
    return result


# ─────────────────────────────────────────
# 7. 메인: 전체 분석 실행
# ─────────────────────────────────────────

def analyze(input_path, output_path=None):
    """result_text.json 전체를 분석하여 난이도 결과 JSON을 생성."""
    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    blocks = data.get('blocks', [])
    results = []
    flagged_count = 0
    suggestion_count = 0

    for block in blocks:
        result = analyze_block(block)
        if result is None:
            continue
        results.append(result)
        if result['flags']:
            flagged_count += 1
        if result['needs_suggestion']:
            suggestion_count += 1

    # ── 페이지 단위 점수 산출 ──
    # paragraph 블록들의 difficulty_score(GL 기반) 평균을 감점으로 적용
    para_scores = [
        r['difficulty_score'] for r in results
        if r['category'] == 'paragraph' and r['difficulty_score'] is not None
    ]
    avg_difficulty = round(sum(para_scores) / len(para_scores), 1) if para_scores else 0.0

    # 위치 의존 감점 (건당 3점, 최대 15점)
    location_violations = sum(
        1 for r in results
        if any('위치 참조' in f or '모호한 참조' in f for f in r['flags'])
    )
    location_penalty = min(location_violations * 3, 15)

    # UI 텍스트 길이 위반 감점 (건당 2점, 최대 20점)
    length_violations = sum(
        1 for r in results
        if any('텍스트 길이 과다' in f for f in r['flags'])
    )
    length_penalty = min(length_violations * 2, 20)

    page_score = round(max(0.0, 100 - avg_difficulty - location_penalty - length_penalty), 1)

    # paragraph 블록 GL 평균 (발표용 참고 지표)
    para_gls = [
        r['metrics']['gl_score'] for r in results
        if r['category'] == 'paragraph' and r['metrics'].get('gl_score') is not None
    ]
    avg_gl = round(sum(para_gls) / len(para_gls), 2) if para_gls else None

    # paragraph 블록 종합 난이도 v2 평균 (검증 전 참고 지표)
    para_v2 = [
        r['difficulty_score_v2'] for r in results
        if r['category'] == 'paragraph' and r.get('difficulty_score_v2') is not None
    ]
    avg_v2 = round(sum(para_v2) / len(para_v2), 1) if para_v2 else None

    output = {
        'meta': {
            'page_score': page_score,
            'score_breakdown': {
                'avg_difficulty_deduction': avg_difficulty,
                'location_penalty': location_penalty,
                'length_penalty': length_penalty,
            },
            'readability': {
                'avg_gl_score': avg_gl,
                'formula': 'Jo(2016): GL = 4.874 + 0.591×A - 9.201×B³',
                'vocab_source': '국립국어원 학습용 어휘 등급 A+B등급(2888개) = 쉬운 단어',
                # 검증 전 참고값. page_score에는 쓰지 않는다(4-3절 주석).
                'avg_difficulty_v2': avg_v2,
                'formula_v2': '(Jo 난이도 점수 + 명사 나열 점수) / 2, 명사 나열 점수 = (어절 수 - 1) / 6 × 100',
            },
            'total_analyzed': len(results),
            'flagged_count': flagged_count,
            'suggestion_needed': suggestion_count,
            'thresholds': {
                'sentence_length': THRESHOLD_SENTENCE_LENGTH,
                'easy_word_ratio_min': EASY_WORD_RATIO_MIN,
                'difficulty_score': THRESHOLD_DIFFICULTY_SCORE,
                'gl': THRESHOLD_GL,
                'short_text_min_hard_nouns': SHORT_TEXT_MIN_HARD_NOUNS,
                'noun_stack_min_eojeols': NOUN_STACK_MIN_EOJEOLS,
            },
        },
        'results': results,
    }

    if output_path is None:
        output_path = input_path.replace('.json', '_difficulty.json')

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f'분석 완료: {len(results)}개 블록 분석')
    print(f'  페이지 점수: {page_score}/100')
    print(f'    - 난이도 감점 (GL 기반): -{avg_difficulty}')
    print(f'    - 위치 의존 감점: -{location_penalty}')
    print(f'    - 길이 위반 감점: -{length_penalty}')
    if avg_gl is not None:
        print(f'  평균 GL (학년 수준): {avg_gl}')
    print(f'  위반 플래그: {flagged_count}개')
    print(f'  수정 제안 필요: {suggestion_count}개')
    print(f'  결과 저장: {output_path}')

    return output


# ─────────────────────────────────────────
# CLI 진입부
# ─────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('사용법: python difficulty_engine.py <result_text.json> [output.json]')
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None
    analyze(input_path, output_path)
