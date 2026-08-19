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
  GL(Grade Level) = 4.874 - 0.591 × A - 9.201 × B³
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

_tagger = MeCab.Tagger('-r C:/mecab/etc/mecabrc -d C:/mecab/share/mecab-ko-dic')


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


def calc_avg_sentence_length(text):
    """
    평균 문장 길이(어절 수)를 계산. Jo(2016) 공식의 A 변수.
    반환: (평균 어절 수, 전체 어절 수)
    """
    sentences = re.split(r'[.!?。]\s*', text)
    # '저는 학생입니다. 반갑습니다!' → ['저는 학생입니다', '반갑습니다', '']
    sentences = [s.strip() for s in sentences if s.strip()]
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
    명사 5개 미만이면 신뢰도 낮으므로 None 반환.
    반환: (쉬운 단어 비율, 쉬운 명사 목록, 전체 명사 목록, 등급별 상세)
    """
    nouns = extract_nouns(text)
    if len(nouns) < 5:
        return None, [], nouns, {}

    grade_detail = {}
    for n in nouns:
        g = get_word_grade(n)
        grade_detail.setdefault(g, []).append(n)

    easy_nouns = [n for n in nouns if get_word_grade(n) in EASY_GRADES]
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

    GL = 4.874 - 0.591 × A - 9.201 × B³
      A = 평균 문장 길이 (어절 수)
      B = 쉬운 단어 비율 (0.0~1.0)

    GL 해석: 낮을수록 쉬움. 일반적으로 1~12 범위.
    음수 GL = 매우 쉬운 텍스트 (단문 + 쉬운 단어).
    """
    gl = 4.874 - (0.591 * avg_sentence_len) - (9.201 * (easy_word_ratio ** 3))
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


THRESHOLD_DIFFICULTY_SCORE = 40  # 이 점수 이상이면 수정 제안 필요


# ─────────────────────────────────────────
# 6. 카테고리별 분석 (블록 단위)
# ─────────────────────────────────────────
#--------------------------------------------------------------------------
#    카테고리             적용 기준
#--------------------------------------------------------------------------
#    paragraph           Jo(2016) 공식 전체 + 위치 의존 탐지
#                        (문장 길이 + 쉬운 단어 비율 → GL → difficulty_score)
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
            # 명사 5개 미만 — 어휘 분석 생략, 문장 길이만 적용
            if avg_sent_len >= THRESHOLD_SENTENCE_LENGTH:
                result['flags'].append(
                    f'문장 길이 과다: 평균 {avg_sent_len:.1f}어절 (기준: {THRESHOLD_SENTENCE_LENGTH}어절)')

        loc_deps = detect_location_dependency(text)
        if loc_deps:
            result['flags'].extend(loc_deps)

        if (result['difficulty_score'] is not None
                and result['difficulty_score'] >= THRESHOLD_DIFFICULTY_SCORE) or loc_deps:
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
                'formula': 'Jo(2016): GL = 4.874 - 0.591×A - 9.201×B³',
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
