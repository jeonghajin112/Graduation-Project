"""
============================================================
 텍스트 추출 전처리 모듈 (text_extractor.py)
 렌더링된 HTML → 분석 대상 텍스트 추출 + 종류별 분류
============================================================

[파일 목적]
  run.js가 Playwright로 저장한 렌더링 HTML 파일에서,
  AI 분석 모듈(난이도 엔진)이 분석할 텍스트만 깨끗하게 추출하고
  종류(카테고리)별로 분류하는 전처리 모듈.

[텍스트를 종류별로 분류하는 이유]
  다음 단계인 난이도 엔진(difficulty_engine.py)에서 카테고리마다
  다른 분석 기준을 적용하기 위함.
    - paragraph(본문): 문장 난이도 분석의 핵심 대상 (문장 길이, 추상어 비율 등)
    - button(버튼): 짧아야 정상이므로 문장 길이 기준 적용 안 함
    - form_guide(안내 문구): 위치 의존 표현 탐지 대상 ('위의 버튼을 클릭하세요' 등)
    - heading(제목): 명확성 검사 대상

[파이프라인 내 위치]
  run.js (렌더링된 HTML 저장)
    → [이 파일] text_extractor.py (텍스트 추출 + 분류)
    → difficulty_engine.py (한국어 난이도 점수 산출)
    → suggestion_generator.py (LLM 수정 제안 생성)

[처리 과정 요약]
  1단계: 불필요한 태그 제거 (script, style, svg 등)
  2단계: HTML 주석 제거
  2.5단계: 숨겨진 요소 제거 (display:none, aria-hidden, 모달/팝업 등)
  3단계: 남은 요소를 순회하며 텍스트 수집 + 카테고리 분류
  4단계: HTML 속성에 들어있는 안내 문구 별도 추출 (placeholder, aria-label 등)
  5단계: 메타 정보 생성 + JSON 저장

[사용법]
  python text_extractor.py result.html                  → result_text.json 저장
  python text_extractor.py result.html output.json      → output.json 저장         // 결과 파일명 지정하는 경우  

[입출력]
  입력: run.js가 저장한 렌더링 HTML 파일 (.html)
  출력: 종류별로 분류된 텍스트 JSON (.json)
        → difficulty_engine.py의 입력으로 사용됨

[분류 카테고리 10종]
  heading    : h1~h6 제목 텍스트
  paragraph  : p, article, section 등 본문 텍스트 (난이도 분석의 핵심 대상)
  button     : button, input[type=submit], role=button 텍스트
  link       : a 태그 텍스트
  label      : label, legend, fieldset 관련 텍스트
  form_guide : placeholder, title, aria-label 등 안내 문구
  table      : 표 안 텍스트 (th, td, caption)
  list       : li 항목 텍스트
  alert      : role=alert, role=status 등 알림 텍스트
  other      : 위에 해당하지 않는 나머지 텍스트

[사용 라이브러리]
  BeautifulSoup4: HTML 파싱 및 DOM 트리 순회
"""

import json
import re
import sys
import os
from dataclasses import dataclass, field, asdict
from typing import Optional
from bs4 import BeautifulSoup, NavigableString, Comment


# ────────────────────────────────────────────
# 1. 제거 대상 태그 / 속성 정의
# ────────────────────────────────────────────

# 통째로 제거할 태그 (콘텐츠 자체가 사용자에게 보이지 않음)
# 이 태그들은 안의 내용까지 포함하여 DOM에서 완전히 삭제됨 (decompose)
#   script   : JavaScript 코드 → 자연어 분석 대상 아님
#   style    : CSS 스타일 정의 → 자연어 분석 대상 아님
#   noscript : JS 비활성화 시 표시되는 대체 콘텐츠 → 렌더링된 HTML에서는 불필요
#   iframe   : 외부 페이지 임베드 → 별도 URL로 분석해야 함
#   svg      : 벡터 그래픽 → 텍스트가 아님
#   math     : 수학 수식 마크업 → 자연어 분석 대상 아님
#   template : HTML 템플릿 → 렌더링 전에는 화면에 표시되지 않음
#   code/pre : 코드 블록 → 프로그래밍 코드이므로 자연어 분석 대상 아님
REMOVE_TAGS = {
    'script', 'style', 'noscript', 'iframe', 'svg', 'math',
    'template', 'code', 'pre',
}

# 내용은 유지하되 "본문"으로 간주하지 않을 구조 태그
# 이 태그 안에 있는 텍스트는 수집하지 않음
#   nav    : 네비게이션 메뉴 (매 페이지마다 반복되는 메뉴 텍스트)
#   footer : 페이지 하단 (저작권 표시, 관련 링크 등 반복 텍스트)
#   header : 페이지 상단 (로고, 메뉴 등 반복 텍스트)
SKIP_SECTIONS = {
    'nav', 'footer', 'header',
}


# ────────────────────────────────────────────
# 2. 데이터 구조
# ────────────────────────────────────────────

@dataclass
class TextBlock:
    """
    추출된 텍스트 한 단위를 나타내는 데이터 클래스.

    하나의 TextBlock은 웹페이지에서 추출한 텍스트 조각 하나에 해당.
    예: <p>급한 생활비, 대출 연체...</p> → TextBlock 1개

    속성:
      text       : 정제된 텍스트 (공백/개행 정리 후)
      category   : 분류 카테고리 (heading, paragraph, button 등 10종)
      tag        : 원본 HTML 태그명 (p, h1, button 등)
      selector   : CSS 선택자 (위치 추적용, 프론트엔드에서 해당 요소 하이라이트 시 사용)
      attributes : id, class 등 참고 정보 (디버깅용)
      sentences  : 문장 분리 결과 리스트 (난이도 엔진에서 문장 단위 분석에 사용)
    """
    text: str
    category: str
    tag: str
    selector: str = ''
    attributes: dict = field(default_factory=dict)
    sentences: list = field(default_factory=list)


# ────────────────────────────────────────────
# 3. 카테고리 분류 로직
# ────────────────────────────────────────────

def classify_element(tag) -> Optional[str]:
    """
    BeautifulSoup 태그 객체를 받아서 10개 카테고리 중 하나로 분류.

    분류 우선순위:
      1) role 속성 (ARIA 역할) — HTML 태그명보다 의미적으로 정확
         예: <div role="button"> → 'button' (div이지만 실제로는 버튼)
      2) HTML 태그명 — 표준 태그의 고유 의미에 따라 분류
         예: <p> → 'paragraph', <h1> → 'heading'

    반환값:
      카테고리 문자열 (heading, paragraph, button 등)
      None 반환 시 → 해당 태그의 텍스트는 수집하지 않음 (분류 불가)

    Args:
      tag: BeautifulSoup 태그 객체
    Returns:
      카테고리 문자열 또는 None
    """
    name = tag.name
    if name is None:
        return None

    # ── role 속성 우선 체크 ──
    # ARIA role은 HTML 태그의 의미를 덮어쓰는 속성
    # 예: <div role="button">은 div이지만 버튼으로 동작하므로 'button'으로 분류
    role = (tag.get('role') or '').lower()
    if role == 'button':
        return 'button'
    if role in ('alert', 'status', 'log', 'marquee', 'timer'):
        return 'alert'
    if role == 'navigation':
        return None   # nav와 동일 취급 → 반복 메뉴이므로 제외
    if role == 'heading':
        return 'heading'

    # ── 태그명 기반 분류 ──

    # 제목 태그 (h1~h6)
    if name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
        return 'heading'

    # 본문 텍스트 — 난이도 분석의 핵심 대상
    if name == 'p':
        return 'paragraph'

    # 컨테이너 태그 — 자체적으로 텍스트를 포함할 수 있으므로 paragraph으로 분류
    # ※ 단, 자식에 블록 요소가 있으면 직접 텍스트만 수집 (중복 방지, 아래 extract_texts 참조)
    if name in ('article', 'section', 'main', 'div', 'span', 'blockquote'):
        return 'paragraph'

    # 버튼 — <button> 태그 또는 <input type="submit/button/reset">
    if name == 'button':
        return 'button'
    if name == 'input' and (tag.get('type') or '').lower() in ('submit', 'button', 'reset'):
        return 'button'

    # 링크 — <a> 태그
    if name == 'a':
        return 'link'

    # 폼 레이블 — <label>, <legend>
    if name in ('label', 'legend'):
        return 'label'

    # 표 관련 — <th>(헤더 셀), <td>(데이터 셀), <caption>(표 제목)
    if name in ('th', 'td', 'caption'):
        return 'table'

    # 목록 항목 — <li>(순서/비순서 목록), <dt>/<dd>(정의 목록)
    if name == 'li':
        return 'list'
    if name in ('dt', 'dd'):
        return 'list'

    # 나머지 인라인/서식 태그 — 기본 난이도만 적용
    if name in ('em', 'strong', 'b', 'i', 'u', 'mark', 'small', 'sub', 'sup',
                'abbr', 'cite', 'q', 'dfn', 'time', 'figcaption', 'summary',
                'details', 'address'):
        return 'other'

    # 위 어디에도 해당하지 않으면 수집 안 함
    return None


# ────────────────────────────────────────────
# 4. 텍스트 정제
# ────────────────────────────────────────────

def clean_text(text: str) -> str:
    """
    텍스트의 공백과 개행(줄바꿈)을 정리.

    HTML에서 추출한 텍스트에는 불필요한 공백, 탭, 개행이 많이 포함되어 있음.
    예: '  급한   생활비,\n    대출 연체  ' → '급한 생활비, 대출 연체'

    연속된 공백/탭/개행을 하나의 공백으로 치환하고, 앞뒤 공백을 제거.
    """
    text = re.sub(r'\s+', ' ', text)  # 연속 공백/탭/개행 → 공백 하나로
    text = text.strip()               # 앞뒤 공백 제거
    return text


def split_sentences(text: str) -> list:
    """
    텍스트를 문장 단위로 분리. (간이 버전)

    난이도 엔진에서 "평균 문장 길이"를 계산하려면 문장 단위로 쪼개야 함.
    마침표(.), 물음표(?), 느낌표(!) 뒤에 공백이 오는 지점에서 분리.

    예: '서비스를 이용합니다. 자세한 사항은 문의하세요.'
        → ['서비스를 이용합니다.', '자세한 사항은 문의하세요.']

    ※ 현재는 간이 규칙 기반이며, 향후 KoNLPy 연동으로 더 정교한 분리로 교체 가능
    """
    if not text:
        return []
    # 마침표/물음표/느낌표 + 공백 기준으로 분리
    parts = re.split(r'(?<=[.?!])\s+', text)
    # 빈 문자열 제거 + 앞뒤 공백 정리
    return [p.strip() for p in parts if p.strip()]


# ────────────────────────────────────────────
# 5. CSS 선택자 생성 (간이)
# ────────────────────────────────────────────

def build_selector(tag) -> str:
    """
    태그의 DOM 트리 내 위치를 나타내는 간이 CSS 선택자를 생성.

    이 선택자는 프론트엔드 대시보드에서 "이 텍스트가 웹페이지의 어디에 있는지"를
    시각적으로 표시(하이라이트)하거나, 수정 가이드에서 문제 위치를 특정할 때 사용.

    생성 규칙:
      - id가 있는 요소를 만나면 즉시 중단 (id는 페이지 내 유일하므로 위치 특정 가능)
      - 같은 태그명의 형제가 여러 개면 :nth-of-type(N)을 붙여서 구분

    예: 'html > body > main > section:nth-of-type(2) > p:nth-of-type(3)'
        'html > body > div#content > p'
    """
    parts = []
    current = tag
    while current and current.name:
        name = current.name
        if name == '[document]':
            break
        # id가 있으면 바로 특정 가능 → 여기서 중단
        tag_id = current.get('id')
        if tag_id:
            parts.append(f'{name}#{tag_id}')
            break
        # 같은 태그명의 형제 중 몇 번째인지 확인
        siblings = [s for s in (current.parent.children if current.parent else [])
                     if getattr(s, 'name', None) == name]
        if len(siblings) > 1:
            idx = siblings.index(current) + 1
            parts.append(f'{name}:nth-of-type({idx})')
        else:
            parts.append(name)
        current = current.parent
    parts.reverse()
    return ' > '.join(parts)


# ────────────────────────────────────────────
# 6. form_guide (안내 문구) 추출
# ────────────────────────────────────────────

def extract_form_guides(soup) -> list:
    """
    HTML 속성(attribute)에 들어있는 안내 문구를 별도로 추출.

    [왜 별도 추출이 필요한가]
      placeholder, aria-label, title 같은 안내 문구는 태그의 텍스트 노드가 아니라
      속성값에 들어 있음. 예를 들어:
        <input placeholder="이름을 입력하세요">
      이 경우 태그의 get_text()는 빈 문자열이지만, placeholder에 안내 문구가 있음.
      3단계(요소 순회)에서는 이런 속성값 텍스트가 수집되지 않으므로 별도 처리가 필요합니다.

    [추출 대상 속성]
      placeholder : 입력 필드의 힌트 텍스트 (예: '검색어를 입력하세요')
      aria-label  : 스크린리더용 접근 가능한 이름 (예: '메뉴 열기')
      title       : 마우스 오버 시 표시되는 툴팁 텍스트

    [난이도 분석에서의 활용]
      form_guide 카테고리는 difficulty_engine.py에서 위치 의존 표현 탐지의 대상이 됨
      예: placeholder="위의 버튼을 누르세요" → 위치 의존 표현으로 플래그됨

    Args:
      soup: BeautifulSoup 파싱 결과 객체
    Returns:
      TextBlock 리스트
    """
    guides = []

    # placeholder 속성 추출
    # 예: <input placeholder="주민등록번호 13자리"> → '주민등록번호 13자리'
    for el in soup.find_all(attrs={'placeholder': True}):
        text = clean_text(el['placeholder'])
        if text:
            guides.append(TextBlock(
                text=text,
                category='form_guide',
                tag=el.name,
                selector=build_selector(el),
                attributes={'source': 'placeholder'},
                sentences=split_sentences(text),
            ))

    # aria-label 속성 추출
    # 예: <button aria-label="검색 실행"> → '검색 실행'
    for el in soup.find_all(attrs={'aria-label': True}):
        text = clean_text(el['aria-label'])
        if text:
            guides.append(TextBlock(
                text=text,
                category='form_guide',
                tag=el.name,
                selector=build_selector(el),
                attributes={'source': 'aria-label'},
                sentences=split_sentences(text),
            ))

    # title 속성 추출
    # 예: <a title="홈페이지로 이동"> → '홈페이지로 이동'
    # ※ <html>, <head>, <title> 태그의 title은 페이지 제목이므로 제외
    for el in soup.find_all(attrs={'title': True}):
        if el.name in ('html', 'head', 'title'):
            continue  # 페이지 <title>은 form_guide가 아님
        text = clean_text(el['title'])
        if text:
            guides.append(TextBlock(
                text=text,
                category='form_guide',
                tag=el.name,
                selector=build_selector(el),
                attributes={'source': 'title'},
                sentences=split_sentences(text),
            ))

    return guides


# ────────────────────────────────────────────
# 7. 메인 추출 로직
# ────────────────────────────────────────────

def is_hidden_or_in_skip(tag) -> bool:
    """
    태그 자체 또는 그 조상이 제외 영역(nav, footer 등)에 속하는지 확인.

    DOM 트리를 위로 올라가며 부모들을 확인.
    예: <nav> 안에 있는 <a> → 네비게이션 메뉴의 링크이므로 제외

    ARIA role도 확인:
      navigation  → nav와 동일 (메뉴)
      banner      → header와 동일 (페이지 상단)
      contentinfo → footer와 동일 (페이지 하단)
    """
    for parent in tag.parents:
        if parent.name in SKIP_SECTIONS:
            return True
        role = (parent.get('role') or '').lower()
        if role in ('navigation', 'banner', 'contentinfo'):
            return True
    return False


def has_block_child(tag) -> bool:
    """
    직접 자식 중 블록 요소가 있는지 확인. (중복 수집 방지용)

    [왜 이 검사가 필요한가]
      <div> 안에 <p>가 있는 경우:
        <div>
          소개글입니다.              ← div의 직접 텍스트
          <p>서비스를 이용합니다.</p> ← p의 텍스트
        </div>

      div에서 get_text()를 하면 "소개글입니다. 서비스를 이용합니다."가 나오고,
      p에서도 "서비스를 이용합니다."가 나와서 같은 텍스트가 중복 수집됨.

      이를 방지하기 위해, 블록 자식이 있는 컨테이너는 "직접 텍스트"만 수집하고
      자식 블록의 텍스트는 자식이 순회될 때 수집되도록 함.
    """
    block_tags = {'p', 'div', 'section', 'article', 'h1', 'h2', 'h3',
                  'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote',
                  'main', 'aside', 'details', 'summary'}
    for child in tag.children:
        if getattr(child, 'name', None) in block_tags:
            return True
    return False


def get_direct_text(tag) -> str:
    """
    태그의 직접 텍스트만 가져옴. (자식 블록 태그 내 텍스트 제외)

    [동작 방식]
      태그의 자식(children)을 하나씩 보면서:
        - 텍스트 노드(NavigableString) → 포함
        - 인라인 태그(em, strong, span, a 등) → 텍스트 포함
          (인라인 태그는 부모 문장의 일부이므로 함께 수집)
        - 블록 태그(p, div 등) → 건너뜀
          (블록 태그는 별도 TextBlock으로 수집됨)

    예: <div>소개글 <strong>중요</strong>입니다.<p>본문</p></div>
        → '소개글 중요입니다.' (p 안의 '본문'은 제외)
    """
    parts = []
    for child in tag.children:
        if isinstance(child, NavigableString) and not isinstance(child, Comment):
            parts.append(str(child))
        elif getattr(child, 'name', None) in ('em', 'strong', 'b', 'i', 'u',
                                                'mark', 'small', 'sub', 'sup',
                                                'abbr', 'cite', 'q', 'span',
                                                'a', 'time', 'br'):
            # 인라인 태그는 부모의 일부로 취급하여 텍스트 포함
            parts.append(child.get_text())
    return clean_text(''.join(parts))


def extract_texts(html: str) -> dict:
    """
    HTML 문자열에서 텍스트를 추출하고 종류별로 분류하는 메인 함수.

    [처리 과정]
      1단계: 불필요한 태그 제거 (script, style, svg 등)
      2단계: HTML 주석 제거 (<!-- --> 형태의 개발자 메모)
      2.5단계: 숨겨진 요소 제거 (정부24 실제 테스트 후 추가된 단계)
               - display:none, aria-hidden="true", role="dialog"
               - modal, popup, loading, tracer 관련 class/id
      3단계: 남은 요소를 순회하며 텍스트 수집 + 카테고리 분류
      4단계: HTML 속성의 안내 문구 별도 추출 (placeholder, aria-label 등)
      5단계: 메타 정보 생성 (블록 수, 문장 수, 카테고리별 통계)

    Args:
      html: 렌더링된 HTML 문자열 (run.js의 page.content() 출력)

    Returns:
      {
        "meta": {
          "total_blocks": 413,     // 추출된 텍스트 블록 총 개수
          "total_sentences": 414,  // 문장 분리 후 총 문장 수
          "categories": {          // 카테고리별 블록 수
            "paragraph": 135,
            "form_guide": 134,
            "link": 85, ...
          }
        },
        "blocks": [                // 추출된 텍스트 블록 배열
          {
            "text": "급한 생활비, 대출 연체...",
            "category": "paragraph",
            "tag": "p",
            "selector": "html > body > main > section > p",
            "sentences": ["급한 생활비, 대출 연체..."]
          }, ...
        ]
      }
    """
    soup = BeautifulSoup(html, 'html.parser')

    # ── 1단계: 제거 대상 태그 삭제 ──
    # decompose()는 태그와 그 안의 모든 내용을 DOM에서 완전히 제거
    for tag_name in REMOVE_TAGS:
        for el in soup.find_all(tag_name):
            el.decompose()

    # ── 2단계: 주석 제거 ──
    # HTML 주석(<!-- -->)은 개발자가 남긴 메모이므로 분석 대상 아님
    for comment in soup.find_all(string=lambda t: isinstance(t, Comment)):
        comment.extract()

    # ── 2.5단계: 숨겨진 요소 / 모달 / 팝업 제거 ──
    # [추가 배경]
    #   처음 버전에서는 이 단계가 없었는데, 정부24를 실제로 돌려보니
    #   숨겨진 대기열 페이지(TRACER), 모달 팝업, 자동 로그아웃 안내 등이
    #   paragraph로 잡히는 문제가 발견되어 추가한 단계.
    #
    # [제거 조건]
    #   - 인라인 스타일에 display:none → 화면에 보이지 않는 요소
    #   - aria-hidden="true" → 스크린리더에게도 숨겨진 요소
    #   - role="dialog" → 모달/팝업 레이어
    #   - class에 modal, popup, loading 등 포함 → 숨김 UI 컴포넌트
    #   - id에 modal, popup, tracer, loading, wait 포함 → 숨김 UI 컴포넌트
    HIDDEN_CLASSES = {'modal', 'popup', 'loading', 'layer-loading', 'skip-nav',
                      'sr-only', 'screen-reader', 'visually-hidden'}

    to_remove = []
    for el in soup.find_all(True):
        if el.parent is None:
            continue  # 이미 제거된 요소 (부모가 없으면 DOM에서 분리된 상태)

        # display:none 체크 (인라인 스타일 기준)
        style = el.get('style', '') or ''
        if 'display:none' in style.replace(' ', '').lower() or 'display: none' in style.lower():
            to_remove.append(el)
            continue

        # aria-hidden="true" 체크
        if el.get('aria-hidden') == 'true':
            to_remove.append(el)
            continue

        # role="dialog" (모달/팝업)
        if (el.get('role') or '').lower() == 'dialog':
            to_remove.append(el)
            continue

        # 특정 class 패턴 체크
        el_classes = set(c.lower() for c in (el.get('class') or []))
        if el_classes & HIDDEN_CLASSES:  # 교집합이 있으면 (하나라도 매칭)
            to_remove.append(el)
            continue

        # id에 숨김 관련 키워드 포함 시 제거
        el_id = (el.get('id') or '').lower()
        if any(kw in el_id for kw in ('modal', 'popup', 'tracer', 'loading', 'wait')):
            to_remove.append(el)
            continue

    # 수집한 제거 대상을 일괄 삭제
    # ※ 순회 중에 바로 삭제하면 DOM 구조가 변해서 순회가 깨질 수 있으므로
    #    먼저 목록에 모아두고 마지막에 일괄 삭제
    for el in to_remove:
        try:
            el.decompose()
        except Exception:
            pass  # 이미 부모가 삭제되어 접근 불가한 경우 무시

    # ── 3단계: 요소 순회하며 텍스트 수집 ──
    blocks = []
    seen_texts = set()  # 중복 방지용 (같은 텍스트가 부모/자식에서 중복 수집되는 것 방지)

    for tag in soup.find_all(True):  # 모든 태그 순회
        # 제외 영역(nav, footer, header) 안에 있으면 건너뛰기
        if tag.name in SKIP_SECTIONS:
            continue
        if is_hidden_or_in_skip(tag):
            continue

        # 카테고리 결정 (분류 불가하면 None → 건너뛰기)
        category = classify_element(tag)
        if category is None:
            continue

        # ── 컨테이너 태그의 중복 수집 방지 ──
        # div, section 등은 자식에 블록 요소(p, h2 등)가 있으면
        # "직접 텍스트"만 수집하고, 자식 블록의 텍스트는 자식이 담당
        # (위의 has_block_child / get_direct_text 함수 참조)
        if tag.name in ('div', 'section', 'article', 'main', 'span', 'blockquote'):
            if has_block_child(tag):
                text = get_direct_text(tag)
            else:
                text = clean_text(tag.get_text())
        else:
            text = clean_text(tag.get_text())

        # 빈 텍스트 / 너무 짧은 텍스트(1글자) 건너뛰기
        if not text or len(text) < 2:
            continue

        # 중복 방지: 같은 카테고리에서 같은 텍스트가 이미 수집되었으면 건너뛰기
        # 키를 'category:text' 형식으로 만들어서, 같은 텍스트라도 다른 카테고리면 허용
        text_key = f'{category}:{text}'
        if text_key in seen_texts:
            continue
        seen_texts.add(text_key)

        # 문장 분리
        sentences = split_sentences(text)

        blocks.append(TextBlock(
            text=text,
            category=category,
            tag=tag.name,
            selector=build_selector(tag),
            attributes={
                k: v for k, v in {
                    'id': tag.get('id'),
                    'class': ' '.join(tag.get('class', [])) if tag.get('class') else None,
                }.items() if v
            },
            sentences=sentences,
        ))

    # ── 4단계: form_guide (속성 기반 안내 문구) 별도 추출 ──
    # 3단계에서는 태그의 텍스트 노드만 수집하므로,
    # placeholder, aria-label, title 속성에 들어있는 안내 문구는 여기서 별도 추출
    guides = extract_form_guides(soup)
    for g in guides:
        text_key = f'{g.category}:{g.text}'
        if text_key not in seen_texts:  # 중복 방지
            seen_texts.add(text_key)
            blocks.append(g)

    # ── 5단계: 메타 정보 생성 ──
    # 다음 단계(난이도 엔진)에서 전체 규모를 파악하고,
    # 카테고리별로 다른 분석 기준을 적용할 때 참조
    category_counts = {}
    total_sentences = 0
    for b in blocks:
        category_counts[b.category] = category_counts.get(b.category, 0) + 1
        total_sentences += len(b.sentences)

    result = {
        'meta': {
            'total_blocks': len(blocks),
            'total_sentences': total_sentences,
            'categories': category_counts,
        },
        'blocks': [asdict(b) for b in blocks],  # dataclass → dict 변환 (JSON 직렬화용)
    }

    return result


# ────────────────────────────────────────────
# 8. CLI 실행
# ────────────────────────────────────────────

def main():
    """
    커맨드 라인에서 직접 실행할 때의 진입점.

    사용법:
      python text_extractor.py result.html                → result_text.json 생성
      python text_extractor.py result.html output.json    → output.json 생성

    실행 후 콘솔에 추출 결과 요약을 출력.
    """
    if len(sys.argv) < 2:
        print('사용법: python text_extractor.py <HTML파일> [출력파일.json]')
        print('예시:   python text_extractor.py result.html')
        sys.exit(1)

    html_path = sys.argv[1]
    if not os.path.exists(html_path):
        print(f'오류: 파일을 찾을 수 없습니다: {html_path}')
        sys.exit(1)

    # 출력 파일명 결정: 지정하지 않으면 입력 파일명에서 확장자를 _text.json으로 변경
    # 예: result.html → result_text.json
    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        output_path = html_path.rsplit('.', 1)[0] + '_text.json'

    # HTML 읽기
    with open(html_path, 'r', encoding='utf-8') as f:
        html = f.read()

    # 추출 실행
    result = extract_texts(html)

    # JSON 저장 (ensure_ascii=False: 한국어가 유니코드 이스케이프 없이 저장됨)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # 콘솔에 요약 출력
    meta = result['meta']
    print(f'텍스트 추출 완료')
    print(f'  총 블록: {meta["total_blocks"]}개')
    print(f'  총 문장: {meta["total_sentences"]}개')
    print(f'  카테고리별:')
    for cat, count in sorted(meta['categories'].items()):
        print(f'    {cat}: {count}개')
    print(f'  저장: {output_path}')


if __name__ == '__main__':
    main()
