import unittest

from text_standard_mapper import classify_text_flag
from standard_mapping import kwcag_items_for_wcag


class TextStandardMapperTest(unittest.TestCase):
    def test_location_dependency_maps_through_kwcag_table(self):
        finding = classify_text_flag('위치 참조: "위" 사용', 'paragraph')

        self.assertEqual('1.3.3', finding['wcag']['id'])
        self.assertEqual(['5.3.3'], [item['id'] for item in finding['kwcag_items']])
        self.assertEqual('명확한 지시사항 제공', finding['kwcag_items'][0]['name'])

    def test_link_length_maps_to_appropriate_link_text(self):
        finding = classify_text_flag('link 텍스트 길이 과다: 40글자', 'link')

        self.assertEqual('2.4.4', finding['wcag']['id'])
        self.assertEqual(['6.4.3'], [item['id'] for item in finding['kwcag_items']])

    def test_reading_level_remains_wcag_when_kwcag_has_no_equivalent(self):
        finding = classify_text_flag('어려운 어휘 과다', 'paragraph')

        self.assertEqual('3.1.5', finding['wcag']['id'])
        self.assertEqual([], finding['kwcag_items'])

    def test_cv_contrast_uses_the_same_mapping_source(self):
        self.assertEqual(
            [('5.4.3', '텍스트 콘텐츠의 명도 대비')],
            [(item['id'], item['name']) for item in kwcag_items_for_wcag('1.4.3')],
        )


if __name__ == '__main__':
    unittest.main()
