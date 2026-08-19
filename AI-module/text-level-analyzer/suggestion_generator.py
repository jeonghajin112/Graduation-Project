"""
============================================================
 LLM 수정 제안 생성기 (suggestion_generator.py)
 위반 블록에 대한 구체적 수정 가이드 자동 생성
============================================================

[파일 목적]
  difficulty_engine.py가 "이 문장은 어렵다"고 판정한 블록들에 대해,
  "그러면 어떻게 고쳐야 하는가"를 구체적으로 제시하는 모듈.

[핵심 설계: 역할 분담]
  측정/판정: difficulty_engine.py (자체 구현 엔진)
  수정 제안: 이 모듈 (규칙 기반 템플릿 + LLM 보조)

[두 가지 제안 생성 방식]
  1) 규칙 기반 템플릿 (오프라인, 항상 동작)
     - 플래그 유형별로 미리 작성해 둔 수정 가이드 템플릿
     - LLM 없이도 동작하므로 API 키가 없어도 기본 가이드 제공
     - 예: "문장 길이 과다" → "한 문장에 하나의 정보만 담도록 분리하세요"

  2) LLM 수정 제안 (온라인, OpenAI GPT API)
     - 난이도 엔진의 측정 수치를 프롬프트에 포함하여 LLM에게 전달
     - LLM이 원문을 쉽게 다시 작성한 수정문과 수정 이유를 반환
     - 비용 관리를 위해 난이도 점수가 높은 paragraph만 대상 (최대 20건/실행)

[비용 관리 전략]
  - MAX_LLM_CALLS = 20: 한 번 실행에 최대 20건만 LLM 호출
  - 대상 제한: paragraph 중 난이도 점수 50 이상, 또는 40글자 이상 link/form_guide만
  - 모델: gpt-4o-mini (gpt-4 대비 비용 대폭 절감, 수정 제안 품질은 충분)
  - 향후 개선: 배치 처리(여러 문장을 한 번에 묶어 호출)로 추가 절감 가능

[파이프라인 내 위치]
  text_extractor.py (텍스트 추출)
    → difficulty_engine.py (난이도 측정 + 위반 플래그)
    → [이 파일] suggestion_generator.py (수정 제안 생성)
    → result_text_suggestions.json (최종 출력)

[사용법]
  python suggestion_generator.py result_text_difficulty.json
  python suggestion_generator.py result_text_difficulty.json output.json

[환경변수]
  OPENAI_API_KEY: OpenAI API 키 (없으면 오프라인 모드)

[입출력]
  입력: result_text_difficulty.json (difficulty_engine.py 출력)
  출력: 각 위반 블록에 수정 제안(suggestions)과 LLM 수정문(llm_revision)이 추가된 JSON

[difficulty_engine.py 플래그 문자열 기준 — 2026.06 기준]
  '문장 길이 과다'   : paragraph/table/list/alert/other에서 avg_sent_len >= 25어절
  '어려운 어휘 과다' : paragraph에서 easy_word_ratio < 0.60 (C등급+미등재 기준)
  '위치 참조'        : 위/아래/옆/오른쪽/왼쪽 등 위치 의존 표현
  '모호한 참조'      : 해당 버튼/여기 클릭 등 모호한 참조 표현
  '텍스트 길이 과다' : button/link/label/form_guide/heading 글자수 초과
"""

import json
import sys
import os

# .env 파일에서 환경변수 로드 (OPENAI_API_KEY 등)
from dotenv import load_dotenv
load_dotenv()

import time


# ─────────────────────────────────────────
# 0. 설정
# ─────────────────────────────────────────

# OpenAI API 키: .env 파일 또는 시스템 환경변수에서 읽음
# .env 파일에 OPENAI_API_KEY=sk-xxxx 형태로 저장해두면 자동으로 읽어옴
# 키가 없으면 OFFLINE_MODE가 True로 설정되어 LLM 호출 없이 동작함
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', '')

# LLM 모델 선택
# gpt-4o-mini: 비용 절감 + 수정 제안 수준의 작업에는 충분한 품질
# gpt-4o로 바꾸면 품질은 올라가지만 비용이 약 10배 증가함 (데모에서는 mini로 충분)
LLM_MODEL = 'gpt-4o-mini'

# ── LLM 호출 제한 (비용 관리) ──
MAX_LLM_CALLS = 20       # 한 번 실행 시 최대 LLM 호출 수 (비용 상한)
                          # 공공 사이트 1개 기준 paragraph가 수백 개일 수 있으므로
                          # 전부 LLM에 보내면 비용이 폭발함 → 20건으로 제한
LLM_RETRY_COUNT = 2      # API 실패 시 재시도 횟수 (일시적 오류 대비)
LLM_RETRY_DELAY = 2      # 재시도 간 대기 시간 (초) — Rate Limit 해소를 위한 간격

# API 키가 없으면 오프라인 모드로 자동 전환
# 오프라인 모드: 규칙 기반 템플릿 제안만 생성 (LLM 호출 안 함)
# → 개발/테스트 환경에서 API 키 없이도 파이프라인 전체를 돌릴 수 있음
OFFLINE_MODE = not bool(OPENAI_API_KEY)


# ─────────────────────────────────────────
# 1. 규칙 기반 수정 제안 (LLM 없이 템플릿으로 생성)
# ─────────────────────────────────────────
# [왜 규칙 기반 템플릿이 필요한가]
#   LLM은 API 키가 있어야 동작하고, 비용도 발생.
#   규칙 기반 템플릿은 API 없이도 항상 동작하는 기본 가이드이며,
#   LLM이 활성화된 경우에도 함께 제공됨.
#
# [difficulty_engine.py 플래그 문자열과 1:1 대응]
#   '문장 길이 과다'   → sentence_length 제안
#   '어려운 어휘 과다' → hard_vocab_ratio 제안
#   '위치 참조'        → location_dependency 제안
#   '모호한 참조'      → location_dependency 제안
#   '텍스트 길이 과다' → 카테고리별 길이 제안
#
# [제공하는 정보]
#   각 제안에는 다음 정보가 포함:
#     type      : 문제 유형 (sentence_length, hard_vocab_ratio 등)
#     issue     : 구체적 문제 설명 + 측정 수치
#     guide     : 수정 방법 가이드 + 예시
#     kwcag_ref : 관련 KWCAG 항목 참조
#     priority  : 우선순위 (high/medium/low)

def generate_rule_based_suggestion(block):
    """
    플래그 유형에 따라 템플릿 기반 수정 제안을 생성.

    difficulty_engine.py가 생성한 flags 배열의 각 플래그를 확인하고,
    해당 유형에 맞는 수정 가이드를 반환.

    [플래그 유형별 처리 — difficulty_engine.py 출력 기준]
      '문장 길이 과다'   → 문장 분리 가이드 (priority: high)
      '어려운 어휘 과다' → 쉬운 어휘 대체 가이드 + 고난이도 어휘 목록 (priority: medium)
      '위치 참조'        → 구체적 이름 사용 가이드 (priority: high)
      '모호한 참조'      → 구체적 이름 사용 가이드 (priority: high)
      '텍스트 길이 과다' → 카테고리별 간결화 가이드 (priority: low~medium)

    Args:
      block: difficulty_engine.py가 출력한 분석 결과 블록
    Returns:
      수정 제안 dict의 리스트
    """
    suggestions = []
    text = block.get('text', '')           # 원문 텍스트 (길이 계산에 사용)
    category = block.get('category', '')   # 텍스트 유형 (paragraph/button/link 등)
    flags = block.get('flags', [])         # difficulty_engine이 붙인 위반 플래그 목록
    metrics = block.get('metrics', {})     # 난이도 측정 수치 (avg_sentence_length 등)

    # 블록에 달린 플래그를 하나씩 확인하여 해당 유형의 제안을 생성
    # 한 블록에 여러 플래그가 있을 수 있으므로 반복문으로 처리
    for flag in flags:

        # ── 문장 길이 과다 ──
        # difficulty_engine: f'문장 길이 과다: 평균 {avg_sent_len:.1f}어절 (기준: {THRESHOLD_SENTENCE_LENGTH}어절)'
        # 발생 조건: paragraph/table/list/alert/other에서 평균 문장 길이가 25어절 이상
        # 예: "본 서비스의 이용에 관한 제반 사항은 관계 법령에 의거하여 처리되며 민원인의
        #      권리와 의무에 관한 사항은 별도의 고지 없이 변경될 수 있습니다." (30어절)
        if '문장 길이 과다' in flag:
            # metrics에서 평균 문장 길이를 읽어서 issue 메시지에 실제 수치를 포함
            # (단순히 "길다"가 아니라 "30.2어절로 기준을 초과합니다" 형태로 구체화)
            avg_len = metrics.get('avg_sentence_length', 0)
            suggestions.append({
                'type': 'sentence_length',
                'issue': f'평균 문장 길이가 {avg_len:.1f}어절로 기준(25어절)을 초과합니다.',
                'guide': '한 문장에 하나의 정보만 담도록 분리하세요. '
                         '접속사(~하고, ~하며, ~하여)로 이어진 문장을 마침표로 나누면 됩니다.',
                'kwcag_ref': '3.1.1 읽기 쉬운 콘텐츠',
                'priority': 'high',
            })

        # ── 어려운 어휘 과다 ──
        # difficulty_engine: f'어려운 어휘 과다: 쉬운 단어 비율 {easy_ratio*100:.1f}% (어려운 단어 {hard_pct}%, C등급+미등재 기준)'
        # 발생 조건: paragraph에서 쉬운 단어(A/B등급) 비율이 60% 미만
        # 등급 기준: A(초등), B(중등) = 쉬운 단어 / C(고등), D(미등재) = 어려운 단어
        # grade_detail에서 C/D등급 명사를 추출하여 issue에 포함
        elif '어려운 어휘 과다' in flag:
            easy_ratio = metrics.get('easy_word_ratio', 0) or 0
            grade_detail = metrics.get('grade_detail', {})

            # C등급(고등 수준)과 D등급(미등재 단어) 명사를 최대 5개까지 추출
            # 너무 많으면 issue 메시지가 길어지므로 각 등급에서 최대 3개씩만 가져옴
            # 예: grade_detail = {'A': ['주민', '신청'], 'C': ['이행', '제반'], 'D': ['고시']}
            hard_nouns = grade_detail.get('C', [])[:3] + grade_detail.get('D', [])[:3]
            hard_nouns = hard_nouns[:5]

            # 어려운 어휘 목록이 있으면 issue에 포함 (없으면 비율 정보만 제공)
            # 예: "주요 어려운 어휘: 이행, 제반, 고시"
            examples = ', '.join(hard_nouns) if hard_nouns else ''
            issue_text = f'쉬운 단어 비율이 {easy_ratio*100:.1f}%로 기준(60%)에 미달합니다.'
            if examples:
                issue_text += f' 주요 어려운 어휘: {examples}'
            suggestions.append({
                'type': 'hard_vocab_ratio',
                'issue': issue_text,
                'guide': '고급 어휘나 전문 용어를 쉬운 단어로 바꾸세요. '
                         '예: "이행" → "지키기", "제반 사항" → "모든 내용", '
                         '"의거하여" → "따라서", "시행" → "실시/시작"',
                'kwcag_ref': '3.1.1 읽기 쉬운 콘텐츠',
                'priority': 'medium',
            })

        # ── 위치 의존 표현 (위치 참조 / 모호한 참조) ──
        # difficulty_engine LOCATION_PATTERNS 출력:
        #   '위치 참조: "위(의)" 사용', '위치 참조: "아래(의)" 사용' 등
        #   '모호한 참조: "해당 ~" 사용', '모호한 참조: "여기/이곳 클릭" 사용'
        #
        # 두 플래그를 같은 elif로 처리하는 이유:
        #   위치 참조("위의 버튼")와 모호한 참조("해당 버튼")는 발생 원인은 다르지만
        #   수정 방향이 동일함 → "구체적 이름을 쓰세요"
        #   KWCAG 1.3.3: 위치/방향/색상 등 감각에만 의존해서 UI를 가리키면 안 됨
        elif '위치 참조' in flag or '모호한 참조' in flag:
            # flag 문자열 자체를 issue에 포함하여 어떤 표현이 문제인지 구체적으로 표시
            # 예: '위치에 의존하는 모호한 표현이 있습니다: 위치 참조: "위(의)" 사용'
            suggestions.append({
                'type': 'location_dependency',
                'issue': f'위치에 의존하는 모호한 표현이 있습니다: {flag}',
                'guide': '위치 참조 대신 구체적 이름을 사용하세요. '
                         '예: "위의 버튼을 클릭하세요" → "\'제출\' 버튼을 클릭하세요", '
                         '"해당 메뉴" → "\'민원 신청\' 메뉴"',
                'kwcag_ref': '1.3.3 감각적 특성에 의존하지 않는 콘텐츠',
                'priority': 'high',
            })

        # ── 카테고리별 텍스트 길이 과다 ──
        # difficulty_engine: f'{category} 텍스트 길이 과다: {len(text)}글자 (기준: {max_len}글자)'
        # 발생 조건: 아래 카테고리가 각 기준 글자수를 초과할 때
        #   link:       30글자 초과 — "이 링크를 클릭하시면 민원 신청 페이지로 이동하실 수 있습니다(45글자)"
        #   button:     20글자 초과 — "신청서 작성 및 제출하기(11글자)"는 OK, "전체 서비스 목록 보기(12글자)"는 OK
        #   form_guide: 50글자 초과 — placeholder/aria-label
        #   label:      40글자 초과
        #   heading:    60글자 초과
        #
        # category에 따라 다른 제안을 생성하는 이유:
        #   각 UI 요소마다 적절한 길이 기준과 수정 방향이 다름
        #   예: 버튼은 "동작을 2~4단어로" / 링크는 "목적지를 간결하게" / heading은 "핵심만 60자 이내"
        elif '텍스트 길이 과다' in flag:
            if category == 'link':
                suggestions.append({
                    'type': 'link_length',
                    'issue': f'링크 텍스트가 {len(text)}글자로 기준(30글자)을 초과합니다.',
                    'guide': '링크 텍스트는 목적지를 간결하게 설명해야 합니다. '
                             '부가 설명은 링크 밖에 두고, 링크 자체는 핵심만 담으세요.',
                    'kwcag_ref': '2.4.4 링크 목적 식별',
                    'priority': 'low',
                })
            elif category == 'button':
                suggestions.append({
                    'type': 'button_length',
                    'issue': f'버튼 텍스트가 {len(text)}글자로 기준(20글자)을 초과합니다.',
                    'guide': '버튼 텍스트는 동작을 명확하게 2~4단어로 표현하세요. '
                             '예: "신청서 작성 및 제출하기" → "신청하기"',
                    'kwcag_ref': '2.4.4 링크 목적 식별',
                    'priority': 'medium',
                })
            elif category == 'form_guide':
                # form_guide: placeholder, aria-label 등 입력 필드 안내 문구
                # 안내 문구가 너무 길면 화면 낭독기(스크린리더) 사용자에게 부담이 됨
                suggestions.append({
                    'type': 'form_guide_length',
                    'issue': f'안내 문구가 {len(text)}글자로 기준(50글자)을 초과합니다.',
                    'guide': 'placeholder나 aria-label은 간결해야 합니다. '
                             '자세한 설명은 별도 안내 텍스트로 분리하세요.',
                    'kwcag_ref': '3.3.2 레이블 또는 설명 제공',
                    'priority': 'low',
                })
            elif category == 'label':
                suggestions.append({
                    'type': 'label_length',
                    'issue': f'레이블 텍스트가 {len(text)}글자로 기준(40글자)을 초과합니다.',
                    'guide': '레이블은 입력 필드의 목적을 간결하게 설명해야 합니다. '
                             '부가 설명은 별도 안내 텍스트로 분리하세요.',
                    'kwcag_ref': '3.3.2 레이블 또는 설명 제공',
                    'priority': 'low',
                })
            elif category == 'heading':
                suggestions.append({
                    'type': 'heading_length',
                    'issue': f'제목 텍스트가 {len(text)}글자로 기준(60글자)을 초과합니다.',
                    'guide': '제목은 섹션 내용을 간결하게 요약해야 합니다. '
                             '60글자 이내로 핵심만 남기세요.',
                    'kwcag_ref': '2.4.6 제목과 레이블',
                    'priority': 'low',
                })
            else:
                # 위에서 커버되지 않은 카테고리(other 등)에 대한 범용 처리
                suggestions.append({
                    'type': 'text_length',
                    'issue': f'{category} 텍스트가 길이 기준을 초과합니다.',
                    'guide': '핵심 내용만 남기고 부가 설명은 분리하세요.',
                    'kwcag_ref': '3.1.1 읽기 쉬운 콘텐츠',
                    'priority': 'low',
                })

    return suggestions


# ─────────────────────────────────────────
# 2. LLM 수정 제안 (OpenAI GPT API)
# ─────────────────────────────────────────
# [규칙 기반 템플릿과의 차이]
#   규칙 기반 템플릿: "이렇게 고치면 됩니다"라는 일반적 가이드 제공
#   LLM 수정 제안:    원문을 실제로 쉽게 다시 써서 구체적 수정문 제공
#
# [LLM에게 전달하는 정보]
#   난이도 엔진의 측정 수치(평균 문장 길이, 어휘 난이도 등)를 프롬프트에 포함
#   → LLM은 "어디가 왜 어려운지"를 이미 알고 있는 상태에서 수정안을 생성
#   → 엔진이 진단하고, LLM이 처방하는 역할 분담
#
# [프롬프트 설계의 핵심]
#   1) 난이도 엔진의 측정 결과를 구조화하여 전달 (LLM이 맥락을 이해하도록)
#   2) 수정 원칙 명시 (고난이도 어휘→쉬운 어휘, 긴 문장→짧게, 전문용어→쉬운 말)
#   3) 출력 형식을 JSON으로 강제 (파싱 용이)
#   4) 원래 의미 유지 제약 (쉽게 쓰되 내용이 바뀌면 안 됨)

def build_llm_prompt(block):
    """
    난이도 엔진의 측정 수치를 포함한 LLM 프롬프트를 구성.

    [프롬프트 구조]
      역할 설정: "당신은 웹 접근성 전문가입니다"
      원문 제시: 수정 대상 텍스트
      분석 결과: 난이도 엔진이 측정한 수치들 (문장 길이, 어휘 난이도 등)
      탐지된 문제: flags 배열의 내용
      수정 지시: 수정 원칙 + JSON 출력 형식 강제

    [grade_detail 활용]
      difficulty_engine이 grade_detail에 C/D등급 명사를 저장해 두므로
      프롬프트에 "주요 어려운 어휘: 제반, 이행, 의거" 형태로 포함.
      LLM이 정확히 어떤 단어를 바꿔야 하는지 알 수 있음.

    Args:
      block: difficulty_engine.py가 출력한 분석 결과 블록
    Returns:
      LLM에게 전달할 프롬프트 문자열
    """
    text = block.get('text', '')
    category = block.get('category', '')
    metrics = block.get('metrics', {})
    flags = block.get('flags', [])
    score = block.get('difficulty_score')

    # ── 난이도 수치를 사람이 읽기 좋은 형태로 줄 단위 정리 ──
    # LLM에게 "이 문장이 왜 어려운지"를 수치로 설명하는 섹션
    # LLM이 수치 없이 원문만 받으면 어느 부분에 집중해야 할지 모름
    metric_lines = []
    if metrics.get('avg_sentence_length') is not None:
        metric_lines.append(f'- 평균 문장 길이: {metrics["avg_sentence_length"]}어절')
    if metrics.get('easy_word_ratio') is not None:
        metric_lines.append(f'- 쉬운 단어 비율: {metrics["easy_word_ratio"]*100:.1f}%')

    # ── grade_detail에서 어려운 어휘 추출 (C/D등급, 최대 6개) ──
    # C등급: 고등학교 수준 어휘 (예: '이행', '제반', '의거')
    # D등급: 국립국어원 목록에 없는 단어 (전문 용어, 행정 용어 등)
    # LLM 프롬프트에 포함하면 LLM이 정확히 어떤 단어를 교체해야 하는지 알 수 있음
    grade_detail = metrics.get('grade_detail', {})
    hard_nouns = grade_detail.get('C', [])[:4] + grade_detail.get('D', [])[:4]
    hard_nouns = hard_nouns[:6]
    if hard_nouns:
        metric_lines.append(f'- 주요 어려운 어휘 (C/D등급): {", ".join(hard_nouns)}')

    # 종합 난이도 점수도 포함 (0~100, 높을수록 어려움)
    if score is not None:
        metric_lines.append(f'- 종합 난이도 점수: {score}/100 (높을수록 어려움)')

    # 수치 정보가 없을 경우 대비 fallback 문자열
    metric_str = '\n'.join(metric_lines) if metric_lines else '(지표 없음)'

    # 플래그 목록을 줄 단위로 포맷 (LLM이 어떤 위반이 있는지 파악하도록)
    flag_str = '\n'.join(f'- {f}' for f in flags) if flags else '(없음)'

    # ── 프롬프트 본문 ──
    # 핵심 제약 조건:
    #   1) 일반 성인(노인 포함)이 한 번 읽고 이해할 수 있는 수준으로
    #   2) 어려운 어휘는 쉬운 단어로
    #   3) 긴 문장은 나누기
    #   4) 원래 의미 유지 (내용 왜곡 금지)
    #   5) JSON 형식으로만 응답 (파이썬에서 파싱해야 하므로 필수)
    prompt = f"""당신은 웹 접근성 전문가입니다. 아래 웹페이지 텍스트는 한국어 인지 난이도 분석 결과 문제가 있습니다.

[원문]
{text}

[텍스트 유형]
{category}

[난이도 엔진 분석 결과]
{metric_str}

[탐지된 문제]
{flag_str}

위 분석 결과를 참고하여, 다음 형식으로 수정 제안을 해주세요:

1. **수정문**: 일반 성인(노인 포함)이 한 번 읽고 이해할 수 있도록 원문을 쉽게 다시 작성해주세요.
   - 어려운 어휘(C/D등급)는 쉬운 단어로 바꾸세요
   - 긴 문장은 짧게 나누세요
   - 전문용어는 쉬운 말로 풀어쓰세요
   - 원래 의미는 유지하세요

2. **수정 이유**: 어떤 부분을 왜 바꿨는지 한 줄로 설명해주세요.

JSON 형식으로만 응답해주세요:
{{"revised_text": "수정된 문장", "reason": "수정 이유 한 줄 설명"}}"""

    return prompt


def call_openai_api(prompt):
    """
    OpenAI GPT API를 호출하여 수정 제안을 받음.

    [API 호출 방식]
      requests 라이브러리로 OpenAI /v1/chat/completions 엔드포인트에 POST 요청
      temperature=0.3: 일관성 있는 출력을 위해 낮게 설정
      max_tokens=500: 수정문 + 이유 정도면 충분한 길이

    [에러 처리]
      429 (Rate Limit): 대기 후 재시도 (LLM_RETRY_DELAY × 시도 횟수)
      JSON 파싱 실패: LLM이 지시대로 JSON을 안 줄 수 있음 → None 반환
      네트워크 오류: 재시도 후에도 실패하면 None 반환
      → None 반환 시 규칙 기반 템플릿 제안만 사용됨 (전체 파이프라인은 중단 안 됨)

    Args:
      prompt: build_llm_prompt()이 생성한 프롬프트 문자열
    Returns:
      {'revised_text': '수정된 문장', 'reason': '수정 이유'} 또는 None (실패 시)
    """
    try:
        import requests
    except ImportError:
        print('  [경고] requests 패키지 없음. pip install requests 필요')
        return None

    url = 'https://api.openai.com/v1/chat/completions'
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {OPENAI_API_KEY}',
    }
    body = {
        'model': LLM_MODEL,
        'messages': [
            {'role': 'user', 'content': prompt}
        ],
        # temperature=0.3: 창의적 변형보다 정확한 수정에 집중
        # 0.0에 가까울수록 결정적(deterministic), 1.0에 가까울수록 다양한 응답
        'temperature': 0.3,
        # max_tokens=500: 수정문(~200토큰) + reason(~50토큰) 기준으로 여유 있게 설정
        'max_tokens': 500,
    }

    # LLM_RETRY_COUNT만큼 재시도 (기본 2회)
    # attempt 0: 첫 번째 시도 / attempt 1, 2: 재시도
    for attempt in range(LLM_RETRY_COUNT + 1):
        try:
            resp = requests.post(url, json=body, headers=headers, timeout=30)

            # 429: Rate Limit 초과 — 잠시 대기 후 재시도
            # 시도 횟수가 늘어날수록 대기 시간을 점점 늘림 (2초, 4초)
            if resp.status_code == 429:
                wait = LLM_RETRY_DELAY * (attempt + 1)
                print(f'  [Rate limit] {wait}초 대기 후 재시도...')
                time.sleep(wait)
                continue

            # 200이 아닌 다른 에러 (401 인증 실패, 500 서버 오류 등)
            if resp.status_code != 200:
                print(f'  [API 에러] status={resp.status_code}: {resp.text[:200]}')
                return None

            # 정상 응답에서 텍스트 내용만 추출
            # choices[0].message.content: LLM이 실제로 응답한 텍스트
            data = resp.json()
            content = data['choices'][0]['message']['content']

            # ── JSON 파싱 전처리 ──
            # LLM이 프롬프트 지시를 지키면 {"revised_text": ..., "reason": ...} 형태로 응답하지만
            # 간혹 ```json ... ``` 형태로 마크다운 코드블록으로 감싸서 응답하는 경우가 있음
            # 이 경우 코드블록 마커(```)를 제거하고 순수 JSON만 추출
            content = content.strip()
            if content.startswith('```'):
                # 첫 줄(```json 또는 ```)을 제거하고 나머지만 유지
                content = content.split('\n', 1)[1] if '\n' in content else content[3:]
            if content.endswith('```'):
                # 마지막 ``` 제거
                content = content[:-3]
            content = content.strip()

            # JSON 파싱: {'revised_text': ..., 'reason': ...} dict로 변환
            result = json.loads(content)
            return result

        except json.JSONDecodeError:
            # LLM이 JSON 형식을 안 지킨 경우 (자연어로 응답하거나 형식 오류)
            # 재시도하지 않고 None 반환 → 규칙 기반 제안만 사용
            print(f'  [파싱 실패] LLM 응답이 JSON이 아님: {content[:100]}')
            return None
        except Exception as e:
            # 네트워크 오류, 타임아웃 등 기타 예외
            # 재시도 횟수 내라면 대기 후 재시도, 초과하면 None 반환
            if attempt < LLM_RETRY_COUNT:
                time.sleep(LLM_RETRY_DELAY)
                continue
            print(f'  [API 에러] {e}')
            return None

    return None


# ─────────────────────────────────────────
# 3. 규칙 기반 위반에 대한 코드 수정 가이드
# ─────────────────────────────────────────
# [이 섹션의 목적]
#   axe-core 규칙 기반 모듈(run.js)이 발견한 HTML 코드 위반에 대해
#   "코드를 이렇게 고치세요"라는 구체적 수정 예시를 제공합니다.
#   이건 텍스트 난이도와는 다른 영역 — HTML 코드 수준의 수정 가이드.
#
# [현재 상태]
#   함수와 데이터만 준비해 둔 상태이며,
#   통합 단계(Phase 4)에서 axe-core 위반 결과와 연결할 예정.

# axe-core 규칙 ID → 코드 수정 가이드 매핑 테이블
# axe-core가 위반을 발견하면 'image-alt', 'color-contrast' 같은 rule ID를 돌려줌
# 이 테이블에서 해당 ID를 찾아 사용자에게 보여줄 수정 예시를 반환함
#
# 각 항목 구조:
#   guide         : 한 줄 수정 방향 설명
#   code_before   : 위반 상태의 HTML 코드 예시 (before)
#   code_after    : 수정된 HTML 코드 예시 (after)
#   color_suggestion: (color-contrast 전용) 추천 색상 조합
#   kwcag_ref     : 대응하는 KWCAG 항목 번호 + 이름
RULE_BASED_GUIDES = {
    'image-alt': {
        'guide': '이미지에 대체 텍스트(alt 속성)를 추가하세요.',
        'code_before': '<img src="photo.jpg">',
        'code_after': '<img src="photo.jpg" alt="시청 전경 사진">',
        'kwcag_ref': '1.1.1 적절한 대체 텍스트 제공',
    },
    'color-contrast': {
        'guide': '텍스트와 배경의 명암비를 4.5:1 이상으로 조정하세요.',
        # 명암비 위반은 "어떤 색으로 바꾸세요"라는 색상 조합 추천이 더 실용적
        # code_before/after 대신 color_suggestion 필드로 제공
        'color_suggestion': '밝은 배경(#FFFFFF)에는 #595959 이상의 어두운 글자색을 사용하세요.',
        'kwcag_ref': '1.4.3 명도 대비',
    },
    'heading-order': {
        'guide': '제목 태그(h1~h6)를 순서대로 사용하세요. h1 다음에 h3가 오면 안 됩니다.',
        'code_before': '<h1>제목</h1>\n<h3>소제목</h3>',
        'code_after': '<h1>제목</h1>\n<h2>소제목</h2>',
        'kwcag_ref': '1.3.1 정보와 관계',
    },
    'label': {
        'guide': '입력 필드에 연결된 label을 추가하세요.',
        'code_before': '<input type="text" id="name">',
        'code_after': '<label for="name">이름</label>\n<input type="text" id="name">',
        'kwcag_ref': '1.3.1 정보와 관계',
    },
    'button-name': {
        'guide': '버튼에 접근 가능한 이름을 추가하세요.',
        # 이미지만 있는 버튼은 스크린리더가 읽을 텍스트가 없음
        # → aria-label로 버튼의 목적을 명시해야 함
        'code_before': '<button><img src="search.png"></button>',
        'code_after': '<button aria-label="검색"><img src="search.png"></button>',
        'kwcag_ref': '4.1.2 이름, 역할, 값',
    },
    'link-name': {
        'guide': '링크에 명확한 텍스트를 제공하세요.',
        # "여기"나 "클릭"은 스크린리더 사용자가 링크 목록에서 맥락 없이 들을 때 이해 불가
        'code_before': '<a href="/apply">여기</a>를 클릭하세요',
        'code_after': '<a href="/apply">민원 신청 페이지로 이동</a>',
        'kwcag_ref': '2.4.4 링크 목적 식별',
    },
    'html-has-lang': {
        'guide': 'HTML 태그에 언어 속성을 추가하세요.',
        # lang 속성이 없으면 스크린리더가 잘못된 언어로 읽을 수 있음
        # 한국어 공공 사이트는 lang="ko" 필수
        'code_before': '<html>',
        'code_after': '<html lang="ko">',
        'kwcag_ref': '3.1.1 페이지 언어 표시',
    },
}


def get_rule_based_guide(axe_rule_id):
    """
    axe-core 규칙 ID로 코드 수정 가이드를 반환.
    통합 단계(Phase 4)에서 axe-core 위반 결과와 연결할 때 사용.

    [사용 예시 — Phase 4 통합 후]
      axe_violation = {'id': 'image-alt', 'nodes': [...]}
      guide = get_rule_based_guide(axe_violation['id'])
      # guide = {'guide': '이미지에 대체 텍스트...', 'code_before': ..., ...}

    Args:
      axe_rule_id: axe-core 규칙 ID (예: 'image-alt', 'color-contrast')
    Returns:
      수정 가이드 dict 또는 None (해당 규칙의 가이드가 없는 경우)
    """
    return RULE_BASED_GUIDES.get(axe_rule_id)


# ─────────────────────────────────────────
# 4. 메인: 수정 제안 생성 실행
# ─────────────────────────────────────────

def generate_suggestions(input_path, output_path=None):
    """
    difficulty_engine.py의 출력을 읽어서 수정 제안을 추가한 JSON을 생성.

    [처리 흐름]
      1) 전체 블록에서 needs_suggestion == true인 블록만 처리 대상
      2) 모든 대상 블록에 규칙 기반 템플릿 제안 생성 (항상 동작)
      3) LLM 호출 대상 판별:
         - paragraph: 난이도 점수 50 이상인 경우만
         - link/form_guide: 텍스트 40글자 이상인 경우만
         - 최대 20건까지 (MAX_LLM_CALLS)
      4) LLM 호출 성공 시: llm_revision에 수정문과 수정 이유 저장
         LLM 호출 실패 시: 규칙 기반 템플릿 제안만 유지 (파이프라인 중단 안 됨)
      5) 결과를 원본 JSON에 합쳐서 저장

    [출력 JSON 구조 (각 블록에 추가되는 필드)]
      {
        ...기존 difficulty_engine 출력 필드...,
        "suggestions": [
          { "type": "hard_vocab_ratio",
            "issue": "쉬운 단어 비율이 33.3%로...",
            "guide": "고급 어휘나 전문 용어를 쉬운 단어로...",
            "kwcag_ref": "3.1.1 ...",
            "priority": "medium" }
        ],
        "llm_revision": {
          "revised_text": "쉽게 다시 쓴 문장",
          "reason": "수정 이유 한 줄",
          "model": "gpt-4o-mini"
        }
      }

    Args:
      input_path: 입력 JSON 파일 경로 (difficulty_engine.py 출력)
      output_path: 출력 JSON 파일 경로 (None이면 자동 생성)
    Returns:
      출력 JSON 데이터 (dict)
    """
    # ── 입력 파일 로드 ──
    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # results: difficulty_engine.py가 분석한 텍스트 블록 목록
    # 각 블록에는 text, category, flags, metrics, difficulty_score, needs_suggestion 등이 있음
    results = data.get('results', [])
    llm_call_count = 0     # LLM 호출 횟수 추적 (MAX_LLM_CALLS 상한 체크용)
    suggestion_total = 0   # 생성된 규칙 기반 제안 총 개수 (통계용)

    # 오프라인 모드 안내 출력 (API 키 없이 실행하는 경우)
    if OFFLINE_MODE:
        print('[오프라인 모드] OPENAI_API_KEY가 설정되지 않아 LLM 호출을 건너뜁니다.')
        print('  → 규칙 기반 템플릿 제안만 생성합니다.')
        print(f'  → API 키 설정: set OPENAI_API_KEY=sk-xxxx (Windows)')
        print()

    for i, block in enumerate(results):
        # needs_suggestion: difficulty_engine.py에서 "이 블록은 수정 제안이 필요하다"고 표시한 것
        # False인 블록은 기준 이하로 무난한 텍스트 → 빈 값만 세팅하고 건너뜀
        if not block.get('needs_suggestion', False):
            block['suggestions'] = []
            block['llm_revision'] = None
            continue

        # ── Step 1: 규칙 기반 템플릿 제안 (항상 생성) ──
        # API 키나 네트워크 상태와 무관하게 항상 동작하는 기본 가이드
        # 플래그 유형별로 수정 방향을 담은 제안 dict 리스트를 반환
        rule_suggestions = generate_rule_based_suggestion(block)
        block['suggestions'] = rule_suggestions
        suggestion_total += len(rule_suggestions)

        # ── Step 2: LLM 수정 제안 (조건부 호출) ──
        # LLM이 원문을 실제로 쉽게 다시 써주는 단계
        # 비용 관리를 위해 모든 블록에 호출하지 않고, 아래 조건을 충족하는 경우만 호출
        block['llm_revision'] = None  # 기본값: LLM 호출 안 함

        if not OFFLINE_MODE and llm_call_count < MAX_LLM_CALLS:
            # ── LLM 호출 대상 판별 ──
            # paragraph: 정말 어려운 문장(난이도 점수 50+)만 → 비용 대비 효과가 큰 경우만
            # link/form_guide: 사용자에게 직접 보이는 긴 텍스트(40글자+) → UX 영향이 큼
            # 그 외(heading, button 등): LLM 없이 규칙 기반 가이드만으로 충분
            should_call_llm = False

            if block.get('category') == 'paragraph':
                # paragraph는 난이도 점수가 50 이상인 것만 LLM 호출
                # (50 미만은 규칙 기반 가이드로 충분한 수준)
                score = block.get('difficulty_score')
                if score is not None and score >= 50:
                    should_call_llm = True
            elif block.get('category') in ('link', 'form_guide'):
                # link와 form_guide는 텍스트가 40글자 이상인 경우만 LLM 호출
                # (짧은 링크/안내문구는 규칙 기반 가이드로 수정 방향이 명확함)
                if len(block.get('text', '')) > 40:
                    should_call_llm = True

            if should_call_llm:
                print(f'  [{i}] LLM 호출 중... (카테고리: {block["category"]})')
                # 난이도 수치가 담긴 프롬프트 구성 후 API 호출
                prompt = build_llm_prompt(block)
                llm_result = call_openai_api(prompt)

                if llm_result:
                    # LLM 응답 성공: 수정문 + 이유 + 사용 모델 정보를 블록에 저장
                    block['llm_revision'] = {
                        'revised_text': llm_result.get('revised_text', ''),
                        'reason': llm_result.get('reason', ''),
                        'model': LLM_MODEL,   # 어떤 모델이 생성했는지 기록
                    }
                    llm_call_count += 1
                    # 수정문 앞 60글자만 미리보기로 출력 (전체 출력하면 너무 길어짐)
                    print(f'    → 수정문: {llm_result.get("revised_text", "")[:60]}...')
                else:
                    # LLM 호출 실패해도 파이프라인은 계속 진행
                    # (규칙 기반 제안은 이미 저장되어 있으므로 사용자는 가이드를 받을 수 있음)
                    print(f'    → LLM 응답 실패, 템플릿 제안만 사용')

    # ── 메타데이터 업데이트 ──
    # 최종 JSON의 meta 필드에 이번 실행의 통계 정보를 기록
    # 이후 성능 평가 스프레드시트 작성 시 활용 가능
    data['meta']['suggestion_stats'] = {
        'total_suggestions': suggestion_total,   # 생성된 규칙 기반 제안 총 수
        'llm_calls': llm_call_count,             # 실제 LLM 호출 횟수 (비용 추적)
        'llm_model': LLM_MODEL if not OFFLINE_MODE else None,
        'mode': 'offline' if OFFLINE_MODE else 'online',
    }

    # ── 저장 ──
    # output_path가 없으면 입력 파일명에서 자동으로 출력 파일명 생성
    # 예: result_text_difficulty.json → result_text_suggestions.json
    if output_path is None:
        output_path = input_path.replace('_difficulty.json', '_suggestions.json')
        if output_path == input_path:  # replace가 안 된 경우 (파일명 형식이 다른 경우)
            output_path = input_path.replace('.json', '_suggestions.json')

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # ── 실행 완료 요약 출력 ──
    print()
    print(f'수정 제안 생성 완료')
    print(f'  대상 블록: {sum(1 for r in results if r.get("needs_suggestion"))}개')
    print(f'  규칙 기반 제안: {suggestion_total}개')
    print(f'  LLM 호출: {llm_call_count}회')
    print(f'  결과 저장: {output_path}')

    return data


# ─────────────────────────────────────────
# 5. CLI 실행
# ─────────────────────────────────────────
# 실행 예시:
#   python suggestion_generator.py result_text_difficulty.json
#
# 전체 파이프라인 순서:
#   1) node src/run.js https://www.gov.kr result.json
#   2) python text_extractor.py result.html
#   3) python difficulty_engine.py result_text.json
#   4) python suggestion_generator.py result_text_difficulty.json

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('사용법: python suggestion_generator.py <result_text_difficulty.json> [output.json]')
        print()
        print('환경변수:')
        print('  OPENAI_API_KEY  - OpenAI API 키 (없으면 오프라인 모드)')
        print()
        print('예시:')
        print('  python suggestion_generator.py result_text_difficulty.json')
        print('  python suggestion_generator.py result_text_difficulty.json result_final.json')
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None
    generate_suggestions(input_path, output_path)
