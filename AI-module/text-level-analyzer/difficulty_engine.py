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
    B  = 쉬운 단어 비율 (국립국어원 학습용 어휘 A+B등급 / 전체 명사)
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
  페이지 점수 = 100 - difficulty_score (높을수록 읽기 쉬움)

[보조 지표]
  - 위치 의존 표현: 건당 3점 감점 (최대 15점)
  - UI 텍스트 길이 위반: 건당 2점 감점 (최대 20점)
  -> 위치의존표현은 UI 텍스트 길이 위반보다 더 심각한 문제로 간주.

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


# ─────────────────────────────────────────
# 2. Jo(2016) 이독성 공식 — A 변수: 평균 문장 길이
# ─────────────────────────────────────────

THRESHOLD_SENTENCE_LENGTH = 25  # 플래그 기준 (25어절 이상이면 인지 부담 높음)

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
    반환: (쉬운 단어 비율 또는 None, 쉬운 명사 목록, 전체 명사 목록, 등급별 상세)
    """
    nouns = extract_nouns(text)
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

LOCATION_PATTERNS = [
    (re.compile(r'(?<![가-힣/])위의?\s'), '위치 참조: "위(의)" 사용'),
    (re.compile(r'(?<![가-힣/])아래의?\s'), '위치 참조: "아래(의)" 사용'),
    (re.compile(r'(?<![가-힣/])옆의?\s'), '위치 참조: "옆(의)" 사용'),
    (re.compile(r'(?<![가-힣/])오른쪽의?\s'), '위치 참조: "오른쪽(의)" 사용'),
    (re.compile(r'(?<![가-힣/])왼쪽의?\s'), '위치 참조: "왼쪽(의)" 사용'),
    (re.compile(r'해당\s+(버튼|메뉴|링크|항목|페이지)'), '모호한 참조: "해당 ~" 사용'),
    (re.compile(r'(여기|이곳)를?\s*클릭'), '모호한 참조: "여기/이곳 클릭" 사용'),
]


def detect_location_dependency(text):
    """위치 의존 표현을 탐지하여 플래그 리스트 반환."""
    return [msg for pattern, msg in LOCATION_PATTERNS if pattern.search(text)]


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
THRESHOLD_DIFFICULTY_SCORE = 40  # 이 점수 이상이면 수정 제안 필요

# 명사 5개 미만(비율/GL 계산 생략 대상)인 텍스트에서, 어려운 단어(C/D등급)가
# 몇 개 이상이면 "어려운 어휘 포함" 보조 플래그를 붙일지의 기준.
# 1로 두면 어려운 단어가 하나만 있어도 걸림 — 급식 메뉴 코드, 행정 용어 약어처럼
# 짧지만 어려운 파편 텍스트를 잡기 위한 의도적으로 민감한 값.
# D등급은 "국립국어원 목록에 없는 단어"라 고유명사·신조어까지 걸릴 수 있으므로,
# 실제 사이트에 돌려보고 과탐지가 많으면 이 값을 2 이상으로 올릴 것.
SHORT_TEXT_MIN_HARD_NOUNS = 1


# ─────────────────────────────────────────
# 6. 카테고리별 분석 (블록 단위)
# ─────────────────────────────────────────
#--------------------------------------------------------------------------
#    카테고리             적용 기준
#--------------------------------------------------------------------------
#    paragraph           Jo(2016) 공식 전체 + 위치 의존 탐지
#                        (문장 길이 + 쉬운 단어 비율 → GL → difficulty_score)
#                        단, 명사 5개 미만이면 비율/GL은 생략하고 "어려운 단어가
#                        하나라도 있는가"만 개별 단어 기준으로 보조 판정(2026-09-23)
#
#    button              글자수 > 20이면 플래그 + 위치 의존 탐지
#    link                글자수 > 30이면 플래그 + 위치 의존 탐지
#    label               글자수 > 40이면 플래그 + 위치 의존 탐지
#    form_guide          글자수 > 50이면 플래그 + 위치 의존 탐지
#    heading             글자수 > 60이면 플래그 + 위치 의존 탐지
#
#    table               문장 길이 > 25어절이면 플래그
#    list                문장 길이 > 25어절이면 플래그
#    alert               문장 길이 > 25어절이면 플래그
#    other               문장 길이 > 25어절이면 플래그
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
        'needs_suggestion': False,
    }

    # 기본 지표: 모든 카테고리 공통 계산
    avg_sent_len, total_eojeols = calc_avg_sentence_length(text)
    result['metrics']['avg_sentence_length'] = avg_sent_len

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

            # 위반 플래그 생성
            if avg_sent_len >= THRESHOLD_SENTENCE_LENGTH:
                result['flags'].append(
                    f'문장 길이 과다: 평균 {avg_sent_len:.1f}어절 (기준: {THRESHOLD_SENTENCE_LENGTH}어절)')

            if easy_ratio < 0.60 and len(all_nouns) >= 5:
                hard_pct = round((1 - easy_ratio) * 100, 1)
                result['flags'].append(
                    f'어려운 어휘 과다: 쉬운 단어 비율 {easy_ratio*100:.1f}% '
                    f'(어려운 단어 {hard_pct}%, C등급+미등재 기준)')

        else:
            # 명사 5개 미만 — 비율/GL 계산은 생략(기준 유지)하되,
            # 있는 명사 중 어려운 단어가 하나라도 있으면 개별 단어 기준으로 보조 판정.
            # (짧은 파편 텍스트가 "명사 5개 미만"이라는 이유만으로 검사망을
            #  통째로 빠져나가던 문제 보완 — 2026-09-23)
            if avg_sent_len >= THRESHOLD_SENTENCE_LENGTH:
                result['flags'].append(
                    f'문장 길이 과다: 평균 {avg_sent_len:.1f}어절 (기준: {THRESHOLD_SENTENCE_LENGTH}어절)')

            hard_nouns_short = [n for n in all_nouns if get_word_grade(n) in ('C', 'D')]
            if len(hard_nouns_short) >= SHORT_TEXT_MIN_HARD_NOUNS:
                result['metrics']['grade_detail'] = grade_detail
                result['metrics']['total_noun_count'] = len(all_nouns)
                result['flags'].append(
                    f'어려운 어휘 포함(표본 부족): 명사 {len(all_nouns)}개 중 어려운 단어 '
                    f'{len(hard_nouns_short)}개({", ".join(hard_nouns_short[:5])}) — '
                    f'표본이 적어 비율 대신 개별 단어 기준으로 판정')

        loc_deps = detect_location_dependency(text)
        if loc_deps:
            result['flags'].extend(loc_deps)

        short_hard_vocab = any('어려운 어휘 포함(표본 부족)' in f for f in result['flags'])

        if (result['difficulty_score'] is not None
                and result['difficulty_score'] >= THRESHOLD_DIFFICULTY_SCORE) or loc_deps or short_hard_vocab:
            result['needs_suggestion'] = True

    # ── button, link, label, form_guide, heading: 길이 + 위치 의존 ──
    elif category in MAX_TEXT_LENGTH:
        max_len = MAX_TEXT_LENGTH[category]
        if len(text) > max_len:
            result['flags'].append(
                f'{category} 텍스트 길이 과다: {len(text)}글자 (기준: {max_len}글자)')
            result['needs_suggestion'] = True

        loc_deps = detect_location_dependency(text)
        if loc_deps:
            result['flags'].extend(loc_deps)
            result['needs_suggestion'] = True

    # ── table, list, alert, other: 문장 길이만 기본 검사 ──
    else:
        if avg_sent_len >= THRESHOLD_SENTENCE_LENGTH and word_count >= 5:
            result['flags'].append(
                f'문장 길이 과다: 평균 {avg_sent_len:.1f}어절 (기준: {THRESHOLD_SENTENCE_LENGTH}어절)')
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
            },
            'total_analyzed': len(results),
            'flagged_count': flagged_count,
            'suggestion_needed': suggestion_count,
            'thresholds': {
                'sentence_length': THRESHOLD_SENTENCE_LENGTH,
                'easy_word_ratio_min': 0.60,
                'difficulty_score': THRESHOLD_DIFFICULTY_SCORE,
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
