"""difficulty_engine.py의 위반 기준 테스트 (2026-10-02 기준 조정분).

MeCab과 mecab-ko-dic이 필요하다(엔진 실행 환경과 같음).
"""

import unittest

import difficulty_engine as de
from text_extractor import extract_texts


def block(text, category='paragraph', **attributes):
    return {'text': text, 'category': category, 'tag': '', 'selector': '', 'attributes': attributes}


def flags_of(text, category='paragraph', **attributes):
    return de.analyze_block(block(text, category, **attributes))['flags']


class LocationDependencyTest(unittest.TestCase):
    def test_rank_after_number_is_not_a_location(self):
        self.assertEqual([], de.detect_location_dependency('박스오피스 2위 하락'))
        self.assertEqual([], de.detect_location_dependency('만족도 조사 1위 기관'))

    def test_screen_position_is_still_detected(self):
        self.assertTrue(de.detect_location_dependency('위의 버튼을 누르세요'))
        self.assertTrue(de.detect_location_dependency('오른쪽 메뉴에서 선택하세요'))

    def test_every_category_checks_location_dependency(self):
        for category in ('paragraph', 'link', 'button', 'table', 'list', 'alert', 'other'):
            result = de.analyze_block(block('위의 표를 참고하세요', category))
            self.assertTrue(any('위치 참조' in f for f in result['flags']), category)
            self.assertTrue(result['needs_suggestion'], category)


class ShortTextVocabularyTest(unittest.TestCase):
    def test_ui_text_gets_no_vocabulary_violation(self):
        # UI 문구 어휘 검사는 오탐이 많아 넣지 않았다. 개수만 기록한다.
        result = de.analyze_block(block('보험료 납부 확인서 발급', 'link'))
        self.assertGreaterEqual(result['metrics']['hard_noun_count'], 2)
        self.assertFalse(any('어려운 어휘' in f for f in result['flags']))
        self.assertFalse(result['needs_suggestion'])

    def test_short_paragraph_vocab_flag_carries_standard_metadata(self):
        from text_standard_mapper import classify_text_flag
        finding = classify_text_flag('어려운 어휘 포함(표본 부족): 명사 2개 중 어려운 단어 2개', 'paragraph')
        self.assertEqual(('short_text_hard_vocab', '3.1.5'), (finding['type'], finding['wcag']['id']))


class SentenceLengthTest(unittest.TestCase):
    NAME_LIST = ' '.join(['강남구', '강동구', '강북구', '강서구', '관악구', '광진구', '구로구',
                          '금천구', '노원구', '도봉구', '동대문구', '동작구', '마포구', '서대문구',
                          '서초구', '성동구', '성북구', '송파구', '양천구', '영등포구', '용산구',
                          '은평구', '종로구', '중구', '중랑구', '자치구'])
    LONG_SENTENCE = ('소득에 대하여 보험료 조정과 정산을 신청한 경우 다음 해 11월에 국세청 등에서 '
                     '확인한 소득으로 조정한 연도의 보험료를 다시 산정하여 그 차액을 부과하거나 '
                     '돌려주는 제도로서 신청한 사람에게만 적용되며 신청하지 않으면 적용되지 않습니다.')

    def test_list_of_names_without_punctuation_is_not_a_long_sentence(self):
        for category in ('list', 'paragraph'):
            flags = flags_of(self.NAME_LIST, category)
            self.assertFalse(any('문장 길이 과다' in f for f in flags), category)

    def test_real_long_sentence_is_flagged(self):
        self.assertGreaterEqual(len(self.LONG_SENTENCE.split()), de.THRESHOLD_SENTENCE_LENGTH)
        for category in ('list', 'paragraph'):
            flags = flags_of(self.LONG_SENTENCE, category)
            self.assertTrue(any('문장 길이 과다' in f for f in flags), category)

    def test_decimal_point_alone_is_not_a_sentence_end(self):
        self.assertFalse(de.has_sentence_terminator('수수료 3.5% 2026.06.22'))
        self.assertTrue(de.has_sentence_terminator('수수료는 3.5%입니다.'))


class VocabularyTest(unittest.TestCase):
    def test_proper_nouns_are_not_counted(self):
        self.assertNotIn('서울', de.extract_common_nouns('서울 시민을 위한 안내'))
        _, _, nouns, _ = de.calc_easy_word_ratio('서울 시민을 위한 안내')
        self.assertNotIn('서울', nouns)

    def test_one_hard_word_in_short_text_is_not_flagged(self):
        flags = flags_of('검색')
        self.assertFalse(any('표본 부족' in f for f in flags))

    def test_two_hard_words_in_short_text_are_flagged(self):
        result = de.analyze_block(block('보험료 납부 확인'))
        self.assertTrue(any('표본 부족' in f for f in result['flags']))
        self.assertTrue(result['needs_suggestion'])

    def test_difficulty_threshold_is_lower_secondary_level(self):
        # WCAG 3.1.5: 중학교 수준(초등 입학 후 9년)을 넘는 글
        self.assertEqual(9.0, de.THRESHOLD_GL)
        self.assertAlmostEqual(72.7, de.THRESHOLD_DIFFICULTY_SCORE)
        self.assertEqual(de.THRESHOLD_DIFFICULTY_SCORE, de.gl_to_difficulty_score(de.THRESHOLD_GL))

    def test_vocab_ratio_alone_does_not_make_an_easy_paragraph_a_violation(self):
        # 쉬운 단어 비율은 60% 미만이지만 난이도 점수는 기준 아래인 글
        result = de.analyze_block(block('학교 급식 식단과 영양 정보를 안내합니다. 가정 통신문을 확인하세요.'))
        self.assertLess(result['metrics']['easy_word_ratio'], de.EASY_WORD_RATIO_MIN)
        self.assertLess(result['difficulty_score'], de.THRESHOLD_DIFFICULTY_SCORE)
        self.assertFalse(any('어려운 어휘 과다' in f for f in result['flags']))
        self.assertFalse(result['needs_suggestion'])

    def test_vocab_ratio_explains_a_paragraph_over_the_threshold(self):
        result = de.analyze_block(block('어려운 행정 용어와 법령 조항 해석에 관한 질의 회신 사례집 발간 및 '
                                        '배포 계획 공고 안내 통지 처분 집행'))
        self.assertGreaterEqual(result['difficulty_score'], de.THRESHOLD_DIFFICULTY_SCORE)
        self.assertTrue(any('어려운 어휘 과다' in f for f in result['flags']))
        self.assertTrue(result['needs_suggestion'])

    def test_paragraph_over_the_threshold_always_has_a_flag(self):
        # 쉬운 단어 비율이 60% 이상이라 어휘 플래그가 없고, 평균 문장이 25어절 미만이라
        # 문장 길이 플래그도 없는데 점수는 기준을 넘는 글(10개 사이트 실측 사례)
        result = de.analyze_block(block('누각과 정자문화를 이해하고 체험할 수 있는 문화공간, '
                                        '사랑하는 사람들과 함께 아름다운 추억을 만들어보세요.'))
        self.assertGreaterEqual(result['difficulty_score'], de.THRESHOLD_DIFFICULTY_SCORE)
        self.assertGreaterEqual(result['metrics']['easy_word_ratio'], de.EASY_WORD_RATIO_MIN)
        self.assertTrue(any('읽기 수준 초과' in f for f in result['flags']))
        self.assertTrue(result['needs_suggestion'])
        self.assertEqual(['reading_level'], [i['type'] for i in result['standard_issues']])
        from suggestion_generator import generate_rule_based_suggestion
        self.assertEqual(['reading_level'],
                         [s['type'] for s in generate_rule_based_suggestion(result)])

    def test_reading_level_flag_is_not_added_when_a_cause_is_flagged(self):
        result = de.analyze_block(block('어려운 행정 용어와 법령 조항 해석에 관한 질의 회신 사례집 발간 및 '
                                        '배포 계획 공고 안내 통지 처분 집행'))
        self.assertFalse(any('읽기 수준 초과' in f for f in result['flags']))


class NounStackingTest(unittest.TestCase):
    def test_counts_noun_only_eojeols_in_a_row(self):
        # 쉬운 우리말 쓰기 캠페인 예시: "이전 통계 조사의 / 사후 평가 결과 반영"
        self.assertEqual(4, de.longest_noun_eojeol_run('이전 통계 조사의 사후 평가 결과 반영'))
        self.assertEqual(6, de.longest_noun_eojeol_run('소득 부과 건강보험료 조정 정산 제도'))

    def test_particles_and_predicates_break_the_run(self):
        self.assertLess(de.longest_noun_eojeol_run('소득에 따라 건강보험료를 조정하고 정산하는 제도입니다.'), 3)

    def test_comma_lists_dates_and_english_are_not_stacking(self):
        self.assertEqual(1, de.longest_noun_eojeol_run('사업, 근로, 이자, 배당, 연금, 기타소득'))
        self.assertLessEqual(de.longest_noun_eojeol_run('2026년 9월 16일 개최 안내'), 2)
        self.assertEqual(0, de.longest_noun_eojeol_run("I haven't heard from him in ages."))

    def test_compound_written_as_one_word_counts_once(self):
        self.assertEqual(1, de.longest_noun_eojeol_run('국민건강보험공단'))

    def test_flag_only_for_sentences(self):
        sentence = '소득 부과 건강보험료 조정 정산 제도를 안내합니다.'
        result = de.analyze_block(block(sentence))
        self.assertTrue(any('명사 나열' in f for f in result['flags']))
        self.assertTrue(result['needs_suggestion'])
        label = de.analyze_block(block('소득 부과 건강보험료 조정 정산 제도', 'link'))
        self.assertFalse(any('명사 나열' in f for f in label['flags']))

    def test_short_noun_phrase_is_not_flagged(self):
        result = de.analyze_block(block('건강보험 납부 확인서를 발급받을 수 있습니다.'))
        self.assertFalse(any('명사 나열' in f for f in result['flags']))

    def test_v2_is_the_unweighted_mean_of_two_subscores(self):
        self.assertEqual(0.0, de.noun_stacking_score(1))
        self.assertEqual(50.0, de.noun_stacking_score(de.NOUN_STACK_MIN_EOJEOLS))
        self.assertEqual(100.0, de.noun_stacking_score(de.NOUN_STACK_FULL_EOJEOLS + 3))
        self.assertEqual(65.0, de.calc_difficulty_score_v2(80.0, 4))
        self.assertIsNone(de.calc_difficulty_score_v2(None, 4))

    def test_paragraph_result_carries_v2_and_metrics(self):
        result = de.analyze_block(block('학교 급식 식단과 영양 정보를 안내합니다. 가정 통신문을 확인하세요.'))
        self.assertIsNotNone(result['difficulty_score_v2'])
        self.assertIn('noun_eojeol_run', result['metrics'])
        self.assertIn('hard_noun_count', result['metrics'])

    def test_flag_maps_to_reading_level_and_gets_a_template(self):
        from text_standard_mapper import classify_text_flag
        from suggestion_generator import generate_rule_based_suggestion
        flag = '명사 나열: 조사 없이 명사만으로 된 어절 6개 연속 (기준: 4개)'
        finding = classify_text_flag(flag, 'paragraph')
        self.assertEqual(('noun_stacking', '3.1.5'), (finding['type'], finding['wcag']['id']))
        suggestions = generate_rule_based_suggestion(
            {'text': '', 'category': 'paragraph', 'flags': [flag], 'metrics': {'noun_eojeol_run': 6}})
        self.assertEqual(['noun_stacking'], [s['type'] for s in suggestions])


class FormGuideDuplicateTest(unittest.TestCase):
    LONG = ('보건복지부 전문임기제 나급 공무원(첨단재생의료사무국) 경력경쟁채용시험 '
            '최종합격자 공고 게시물로 이동')

    def test_title_repeating_visible_text_is_not_length_checked(self):
        self.assertGreater(len(self.LONG), de.MAX_TEXT_LENGTH['form_guide'])
        flags = flags_of(self.LONG, 'form_guide', source='title', duplicates_visible_text=True)
        self.assertFalse(any('텍스트 길이 과다' in f for f in flags))

    def test_standalone_long_guide_is_still_length_checked(self):
        flags = flags_of(self.LONG, 'form_guide', source='placeholder')
        self.assertTrue(any('텍스트 길이 과다' in f for f in flags))

    def test_extractor_marks_title_that_repeats_visible_text(self):
        html = ('<html><body>'
                '<a href="/1" title="채용시험 최종합격자 공고 게시물로 이동">채용시험 최종합격자 공고</a>'
                '<a href="/2" title="새 창에서 열림">자세히 보기</a>'
                '<button aria-label="메뉴 열기"><img src="m.png" alt=""></button>'
                '<input placeholder="검색어를 입력하세요">'
                '</body></html>')
        guides = {b['text']: b['attributes'] for b in extract_texts(html)['blocks']
                  if b['category'] == 'form_guide'}
        self.assertTrue(guides['채용시험 최종합격자 공고 게시물로 이동'].get('duplicates_visible_text'))
        self.assertNotIn('duplicates_visible_text', guides['새 창에서 열림'])
        self.assertNotIn('duplicates_visible_text', guides['메뉴 열기'])
        self.assertNotIn('duplicates_visible_text', guides['검색어를 입력하세요'])


if __name__ == '__main__':
    unittest.main()
