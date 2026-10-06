import unittest

from bs4 import BeautifulSoup

from text_extractor import build_selector, extract_texts


class TextLocatorTest(unittest.TestCase):
    def test_hidden_siblings_do_not_shift_article_or_ancestor_paths(self):
        html = '''<section id="news"><div style="display:none">숨긴 영역</div>
          <div><ul><li aria-hidden="true"><a>숨긴 기사</a></li>
          <li><a>몽골 해외봉사단 소식</a></li><li><a>디자인 학부 수상 소식</a></li>
          </ul></div></section>'''
        original = BeautifulSoup(html, 'html.parser')
        blocks = extract_texts(html)['blocks']
        links = [block for block in blocks if block['category'] == 'link']
        self.assertEqual(2, len(links))
        for block in links:
            matches = original.select(block['selector'])
            self.assertEqual(1, len(matches))
            self.assertEqual(block['text'], matches[0].get_text())
        self.assertFalse(any('숨긴' in block['text'] for block in blocks))

    def test_ad_and_dynamic_regions_marked_by_the_rule_analyzer_are_not_analyzed(self):
        html = """<main><p>고정된 서비스 안내 문장입니다. 이 문장은 분석합니다.</p>
          <section data-ua-excluded-region="DYNAMIC"><ul><li><a>오늘의 뉴스 헤드라인 제목입니다</a></li></ul></section>
          <div data-ua-excluded-region="AD"><p>지금 가입하면 사은품을 드리는 광고 문구입니다.</p></div>
          <p>또 다른 고정 안내 문장입니다. 이 문장도 분석합니다.</p></main>"""
        original = BeautifulSoup(html, 'html.parser')
        blocks = extract_texts(html)['blocks']
        texts = [block['text'] for block in blocks]
        self.assertTrue(any('고정된 서비스 안내' in text for text in texts))
        self.assertFalse(any('헤드라인' in text or '광고 문구' in text for text in texts))
        # Removing the regions must not shift the selectors of the kept blocks.
        for block in blocks:
            self.assertEqual(1, len(original.select(block['selector'])))

    def test_follows_rendered_hidden_marks_and_reads_screen_reader_only_text(self):
        html = """<main><div class="pc-hide" data-ua-hidden="true"><ul><li><a>모바일 전용 공지 제목입니다</a></li></ul></div>
          <ul><li><a>화면에 보이는 공지 제목입니다</a></li></ul>
          <a class="skip-nav" href="#main">본문 바로가기</a>
          <p>검색 결과 안내 문장입니다.<span class="sr-only">스크린리더가 읽는 보충 설명입니다.</span></p></main>"""
        original = BeautifulSoup(html, 'html.parser')
        blocks = extract_texts(html)['blocks']
        texts = [block['text'] for block in blocks]
        # Content not rendered at the analysis viewport reaches no user there.
        self.assertFalse(any('모바일 전용' in text for text in texts))
        self.assertTrue(any('화면에 보이는 공지' in text for text in texts))
        # Screen-reader-only text is read aloud, so it is analyzed.
        self.assertTrue(any('본문 바로가기' in text for text in texts))
        self.assertTrue(any('보충 설명' in text for text in texts))
        for block in blocks:
            self.assertEqual(1, len(original.select(block['selector'])))

    def test_attribute_guides_keep_original_positions(self):
        html = '''<main><div class="modal"><input placeholder="숨긴 안내"></div>
          <div><input style="display:none" placeholder="숨긴 입력">
          <input placeholder="검색어를 입력하세요" aria-label="사이트 검색" title="검색 안내">
          </div></main>'''
        original = BeautifulSoup(html, 'html.parser')
        guides = [block for block in extract_texts(html)['blocks']
                  if block['category'] == 'form_guide']
        self.assertEqual(3, len(guides))
        for guide in guides:
            matches = original.select(guide['selector'])
            self.assertEqual(1, len(matches))
            self.assertEqual(guide['text'], matches[0][guide['attributes']['source']])

    def test_identical_siblings_have_distinct_selectors(self):
        soup = BeautifulSoup('<main><div><a>동일한 링크</a></div><div><a>동일한 링크</a></div></main>', 'html.parser')
        for link in soup.find_all('a'):
            self.assertIs(link, soup.select_one(build_selector(link)))


if __name__ == '__main__':
    unittest.main()
