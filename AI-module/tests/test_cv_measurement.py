import base64
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

AI_MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_MODULE_DIR))
sys.path.insert(0, str(AI_MODULE_DIR / "cv-analyzer"))

import cv_runner
import run_all
from contrast_analyzer import ContrastAnalyzer, contrast_ratio, displayed_ratio, measure_text_colors
from PIL import Image, ImageDraw


def text_image(background, foreground, size=(120, 60), box=(30, 20, 60, 20)):
    """배경 위 상자 안에 글자 획처럼 가는 세로줄을 그린 이미지."""
    image = Image.new("RGB", size, background)
    draw = ImageDraw.Draw(image)
    x, y, width, height = box
    for stroke in range(x + 2, x + width - 2, 6):
        draw.rectangle((stroke, y + 3, stroke + 2, y + height - 4), fill=foreground)
    return image


class CvMeasurementTests(unittest.TestCase):
    def final_result(self, cv):
        rule = {"score": {"score": 100}}
        difficulty = {"meta": {"page_score": 100}, "results": []}
        total = run_all.calculate_total_score(rule, difficulty, cv)
        return run_all.build_final_result(
            "https://example.test/", rule, difficulty, None, cv, None, total, 0, 1
        )

    def test_empty_ocr_is_valid_unmeasured_output_without_a_score_or_penalty(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "blank.png"
            image.write_bytes(base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII="
            ))
            output = Path(directory) / "cv.json"
            # Only the external OCR call is stubbed; use the production empty
            # output, validation, aggregation and final-result serialization.
            with patch.object(cv_runner, "run_ocr", return_value={"backend": "fixture", "texts": []}), redirect_stdout(io.StringIO()):
                result = cv_runner.CVRunner().analyze(str(image), str(output))
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), result)

        self.assertTrue(run_all.valid_cv_result(result))
        self.assertIsNone(result["summary"]["pass_rate"])
        final = self.final_result(result)
        self.assertEqual(final["total_score"], 100)
        self.assertNotIn("cv", final["score_breakdown"]["module_scores"])
        self.assertEqual(final["score_breakdown"]["weights_applied"], {"rule_based": 62.5, "difficulty": 37.5})
        self.assertEqual(final["modules"]["cv_visual"]["status"], "not_measured")
        self.assertEqual(final["modules"]["cv_visual"]["reason"], "NO_TEXT_DETECTED")

    def test_measured_zero_and_positive_scores_keep_the_existing_weight(self):
        for score, expected in ((0, 80), (50, 90), (100, 100)):
            with self.subTest(score=score):
                cv = {"summary": {"total_texts_analyzed": 2, "pass_rate": score}, "violations": []}
                self.assertTrue(run_all.valid_cv_result(cv))
                final = self.final_result(cv)
                self.assertEqual(final["total_score"], expected)
                self.assertEqual(final["score_breakdown"]["module_scores"]["cv"], score)
                self.assertEqual(final["score_breakdown"]["weights_applied"]["cv"], 20)
                self.assertEqual(final["modules"]["cv_visual"]["status"], "success")

    def test_legacy_empty_result_is_normalized_without_reinterpreting_unknown_sample_counts(self):
        empty = {"summary": {"total_texts_analyzed": 0, "pass_rate": 0}, "violations": []}
        final = self.final_result(empty)
        self.assertEqual(final["total_score"], 100)
        self.assertEqual(final["modules"]["cv_visual"]["status"], "not_measured")
        self.assertIsNone(final["modules"]["cv_visual"]["summary"]["pass_rate"])
        # Older external measured results sometimes omit the sample count.
        legacy = {"summary": {"pass_rate": 0}, "violations": []}
        self.assertEqual(self.final_result(legacy)["total_score"], 80)

    def test_failed_and_malformed_results_are_not_reported_as_empty_measurements(self):
        for cv in (
            None,
            {"status": "failed", "summary": {"total_texts_analyzed": 0, "pass_rate": 0}, "violations": []},
            {"summary": {"total_texts_analyzed": True, "pass_rate": 0}, "violations": []},
            {"summary": {"total_texts_analyzed": -1, "pass_rate": 0}, "violations": []},
            {"summary": {"total_texts_analyzed": 1, "pass_rate": None}, "violations": []},
            {"summary": {"total_texts_analyzed": 0, "pass_rate": 0}, "violations": [{}]},
            {"status": "not_measured", "summary": {"total_texts_analyzed": 2, "pass_rate": 0}, "violations": []},
        ):
            with self.subTest(cv=cv):
                self.assertFalse(run_all.valid_cv_result(cv))
                final = self.final_result(cv)
                self.assertEqual(final["total_score"], 100)
                self.assertEqual(final["modules"]["cv_visual"]["status"], "failed")
                self.assertNotIn("cv", final["score_breakdown"]["module_scores"])


    def test_colors_are_measured_for_light_text_on_dark_backgrounds(self):
        image = text_image((0, 0, 0), (255, 255, 255))
        foreground, background = measure_text_colors(image, (30, 20, 60, 20))
        self.assertEqual((foreground, background), ((255, 255, 255), (0, 0, 0)))
        self.assertEqual(ContrastAnalyzer().calculate_ratio(foreground, background)["ratio"], 21.0)

    def test_colors_keep_the_actual_text_color_instead_of_the_quantized_bin(self):
        image = text_image((255, 255, 255), (119, 119, 119))
        foreground, background = measure_text_colors(image, (30, 20, 60, 20))
        self.assertEqual((foreground, background), ((119, 119, 119), (255, 255, 255)))
        # #777 on white is the classic 4.48:1 failure; quantizing to #707070 would pass.
        self.assertFalse(ContrastAnalyzer().calculate_ratio(foreground, background)["kwcag_pass"])

    def test_text_on_a_colored_button_is_measured_against_the_button(self):
        # A green button on a white page: the page outside the text box is not the text's background.
        image = Image.new("RGB", (160, 60), (255, 255, 255))
        ImageDraw.Draw(image).rectangle((20, 15, 139, 44), fill=(3, 199, 90))
        image.paste(text_image((3, 199, 90), (255, 255, 255), size=(60, 20), box=(0, 0, 60, 20)), (50, 20))
        foreground, background = measure_text_colors(image, (50, 20, 60, 20))
        self.assertEqual((foreground, background), ((255, 255, 255), (3, 199, 90)))

    def test_contrast_just_below_the_threshold_fails_and_is_not_displayed_as_passing(self):
        text, background = (110, 121, 120), (255, 255, 255)
        self.assertLess(contrast_ratio(text, background), 4.5)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "page.png"
            text_image(background, text).save(path)
            result = ContrastAnalyzer().analyze_screenshot(
                str(path), [{"text": "Sample", "bbox": {"x": 30, "y": 20, "width": 60, "height": 20}}]
            )
        self.assertEqual(result["passes"], [])
        violation = result["violations"][0]
        self.assertEqual((violation["ratio"], violation["ratio_display"]), (4.49, "4.49:1"))
        self.assertFalse(violation["kwcag_pass"])
        # Display values never exceed the measured ratio, including float edge cases.
        self.assertEqual(displayed_ratio(4.56), 4.56)
        self.assertEqual(displayed_ratio(21.0), 21.0)
        self.assertEqual(displayed_ratio(4.5), 4.5)

    def test_boxes_without_a_distinct_text_color_are_not_measured(self):
        uniform = Image.new("RGB", (120, 60), (0, 128, 0))
        self.assertIsNone(measure_text_colors(uniform, (30, 20, 60, 20)))
        self.assertIsNone(measure_text_colors(uniform, (200, 200, 10, 10)), "a box outside the image")

    def test_symbols_are_judged_and_unmeasurable_text_is_excluded_from_the_pass_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "page.png"
            image = text_image((0, 0, 0), (255, 255, 255), size=(240, 60))
            ImageDraw.Draw(image).rectangle((150, 0, 239, 59), fill=(255, 255, 255))
            image.save(path)
            box = lambda x: {"x": x, "y": 20, "width": 60, "height": 20}
            result = ContrastAnalyzer().analyze_screenshot(str(path), [
                {"text": "다운로드", "bbox": box(30)},
                {"text": "|", "bbox": box(30)},
                {"text": " ▼ ", "bbox": box(30)},
                {"text": "빈칸", "bbox": box(165)},
            ])
        # Symbol-only OCR results are measured like any other text.
        self.assertEqual(result["summary"]["total"], 3)
        self.assertEqual(result["summary"]["pass_count"], 3)
        self.assertEqual(result["summary"]["skipped_unmeasured"], 1)
        self.assertEqual(result["violations"], [])

    def test_ocr_without_measurable_text_is_a_distinct_unmeasured_result(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "page.png"
            Image.new("RGB", (120, 60), (255, 255, 255)).save(image)
            output = Path(directory) / "cv.json"
            texts = [{"text": "빈칸", "bbox": {"x": 10, "y": 10, "width": 20, "height": 20}}]
            with patch.object(cv_runner, "run_ocr", return_value={"backend": "fixture", "texts": texts}), redirect_stdout(io.StringIO()):
                result = cv_runner.CVRunner().analyze(str(image), str(output))
        self.assertEqual(result["reason"], "NO_MEASURABLE_TEXT")
        self.assertEqual(result["summary"]["skipped_unmeasured"], 1)
        final = self.final_result(result)
        self.assertEqual(final["modules"]["cv_visual"]["status"], "not_measured")
        self.assertEqual(final["modules"]["cv_visual"]["reason"], "NO_MEASURABLE_TEXT")
        self.assertNotIn("cv", final["score_breakdown"]["module_scores"])


class CvExcludedRegionTests(unittest.TestCase):
    def test_text_in_ad_or_dynamic_regions_is_reported_separately_and_not_scored(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "page.png"
            page = Image.new("RGB", (300, 60), (255, 255, 255))
            page.paste(text_image((255, 255, 255), (0, 0, 0), size=(60, 20), box=(0, 0, 60, 20)), (20, 20))
            page.paste(text_image((255, 255, 255), (170, 170, 170), size=(60, 20), box=(0, 0, 60, 20)), (200, 20))
            page.save(image)
            texts = [
                {"text": "고정 안내", "bbox": {"x": 20, "y": 20, "width": 60, "height": 20}},
                {"text": "광고 가격", "bbox": {"x": 200, "y": 20, "width": 60, "height": 20}},
            ]
            regions = [{"reason": "AD", "x": 180, "y": 0, "width": 120, "height": 60}]
            output = Path(directory) / "cv.json"
            with patch.object(cv_runner, "run_ocr", return_value={"backend": "fixture", "texts": texts}), redirect_stdout(io.StringIO()):
                result = cv_runner.CVRunner().analyze(str(image), str(output), excluded_regions=regions)
        self.assertEqual(result["summary"]["total_texts_analyzed"], 1)
        self.assertEqual(result["summary"]["pass_rate"], 100)
        self.assertEqual(result["violations"], [])
        self.assertEqual([(v["text"], v["reason"]) for v in result["excluded_violations"]], [("광고 가격", "AD")])

    def test_regions_are_scaled_to_screenshot_pixels_and_malformed_ones_dropped(self):
        rule = {"metadata": {"excluded_regions": [
            {"reason": "DYNAMIC", "x": 10, "y": 20, "width": 30, "height": 40},
            {"reason": "OTHER", "x": 0, "y": 0, "width": 9, "height": 9},
            {"reason": "AD", "x": 0, "y": 0, "width": 0, "height": 9},
            {"reason": "AD", "x": "1", "y": 0, "width": 9, "height": 9},
        ]}}
        self.assertEqual(run_all.cv_excluded_regions(rule, {"deviceScaleFactor": 2}),
                         [{"reason": "DYNAMIC", "x": 20.0, "y": 40.0, "width": 60.0, "height": 80.0}])
        self.assertEqual(run_all.cv_excluded_regions(None, None), [])
        self.assertEqual(cv_runner.load_excluded_regions(None), [])


class CvRuleDeduplicationTests(unittest.TestCase):
    @staticmethod
    def rule_result(*boxes):
        nodes = [{"locator": {"coordinateSpace": "DOCUMENT_CSS_PX", "x": x, "y": y, "width": w, "height": h}}
                 for x, y, w, h in boxes]
        return {"violations": [{"kwcag_id": "5.4.3", "rules": [
            {"axe_rule_id": "color-contrast", "nodes": nodes},
            {"axe_rule_id": "link-name", "nodes": [{"locator": {"coordinateSpace": "DOCUMENT_CSS_PX",
                                                                 "x": 0, "y": 0, "width": 999, "height": 999}}]}
        ]}]}

    @staticmethod
    def cv_result(*locations):
        return {
            "summary": {"total_texts_analyzed": 5, "pass_rate": 40, "fail_count": len(locations)},
            "violations": [{"text": str(index), "location": location} for index, location in enumerate(locations)],
        }

    def test_cv_findings_on_rule_contrast_elements_are_dropped_without_changing_the_score(self):
        cv = self.cv_result(
            {"x": 100, "y": 50, "width": 40, "height": 10},   # inside the rule element
            {"x": 190, "y": 50, "width": 40, "height": 10},   # 25% overlap only
            {"x": 400, "y": 400, "width": 20, "height": 10},  # elsewhere
        )
        deduplicated = run_all.drop_cv_violations_covered_by_rules(cv, self.rule_result((90, 45, 110, 20)), None)
        self.assertEqual([violation["text"] for violation in deduplicated["violations"]], ["1", "2"])
        self.assertEqual(deduplicated["summary"]["duplicate_rule_violations"], 1)
        self.assertEqual(deduplicated["summary"]["pass_rate"], 40)
        self.assertEqual(len(cv["violations"]), 3, "the loaded CV result is not mutated")

    def test_screenshot_pixels_are_scaled_to_css_pixels(self):
        cv = self.cv_result({"x": 200, "y": 100, "width": 80, "height": 20})
        rule = self.rule_result((100, 50, 40, 10))
        self.assertEqual(run_all.drop_cv_violations_covered_by_rules(cv, rule, {"deviceScaleFactor": 2})["violations"], [])
        self.assertIs(run_all.drop_cv_violations_covered_by_rules(cv, rule, {"deviceScaleFactor": 1}), cv)

    def test_results_without_comparable_rule_boxes_are_unchanged(self):
        cv = self.cv_result({"x": 100, "y": 50, "width": 40, "height": 10})
        for rule in (None, {"violations": []}, self.rule_result((0, 0, 0, 10))):
            with self.subTest(rule=rule):
                self.assertIs(run_all.drop_cv_violations_covered_by_rules(cv, rule, None), cv)
        empty = {"summary": {"total_texts_analyzed": 0, "pass_rate": 0}, "violations": []}
        self.assertIs(run_all.drop_cv_violations_covered_by_rules(empty, self.rule_result((0, 0, 9, 9)), None), empty)


class CvAnchorLocatorTests(unittest.TestCase):
    ANCHORS = [
        {"x": 0, "y": 0, "width": 1000, "height": 500, "selector": "#feed", "text": "추천관심사", "image": None,
         "htmlSnippet": '<div id="feed"></div>'},
        {"x": 100, "y": 100, "width": 200, "height": 120, "selector": "#feed > div > a", "text": "기사제목",
         "image": None, "htmlSnippet": "<a>기사제목</a>"},
        {"x": 110, "y": 110, "width": 80, "height": 60, "selector": "#feed > div > a > img", "text": "",
         "image": "/thumb/1.jpg?type=f", "htmlSnippet": '<img src="https://s.example/thumb/1.jpg?type=f">'},
        {"x": 0, "y": 0, "width": 0, "height": 0, "selector": "#hidden", "text": "", "image": None},
    ]

    @staticmethod
    def cv_result(*locations, excluded=()):
        return {
            "summary": {"total_texts_analyzed": 5, "pass_rate": 40, "fail_count": len(locations)},
            "violations": [{"text": str(i), "location": location} for i, location in enumerate(locations)],
            "excluded_violations": [{"text": "x", "reason": "DYNAMIC", "location": location} for location in excluded],
        }

    def test_each_finding_follows_the_smallest_element_under_its_box(self):
        cv = self.cv_result(
            {"x": 140, "y": 130, "width": 20, "height": 10},   # text burnt into the thumbnail
            {"x": 200, "y": 190, "width": 60, "height": 20},   # headline outside the image
            {"x": 2000, "y": 2000, "width": 10, "height": 10},  # nothing there
            excluded=({"x": 600, "y": 400, "width": 20, "height": 10},),
        )
        attached = run_all.attach_cv_locators(cv, self.ANCHORS, {"deviceScaleFactor": 1})
        thumbnail, headline, orphan = attached["violations"]
        self.assertEqual(thumbnail["locator"]["pathSteps"], [{"context": "DOCUMENT", "selector": "#feed > div > a > img"}])
        self.assertEqual(thumbnail["locator"]["content"], {"text": "", "image": "/thumb/1.jpg?type=f"})
        self.assertEqual(thumbnail["locator"]["coordinateSpace"], "DOCUMENT_CSS_PX")
        self.assertEqual((thumbnail["locator"]["x"], thumbnail["locator"]["y"]), (140, 130))
        self.assertEqual(headline["locator"]["pathSteps"][0]["selector"], "#feed > div > a")
        self.assertEqual(headline["locator"]["content"], {"text": "기사제목", "image": None})
        self.assertNotIn("locator", orphan, "a box over no element keeps only its coordinates")
        self.assertEqual(attached["excluded_violations"][0]["locator"]["pathSteps"][0]["selector"], "#feed")
        self.assertEqual(attached["summary"], cv["summary"], "the score sample is unchanged")
        self.assertNotIn("locator", cv["violations"][0], "the loaded CV result is not mutated")

    def test_screenshot_pixels_are_scaled_before_matching(self):
        cv = self.cv_result({"x": 280, "y": 260, "width": 40, "height": 20})
        attached = run_all.attach_cv_locators(cv, self.ANCHORS, {"deviceScaleFactor": 2})
        self.assertEqual(attached["violations"][0]["locator"]["pathSteps"][0]["selector"], "#feed > div > a > img")
        self.assertEqual(attached["violations"][0]["locator"]["width"], 20)

    def test_missing_anchors_leave_the_result_unchanged(self):
        cv = self.cv_result({"x": 140, "y": 130, "width": 20, "height": 10})
        for anchors in (None, [], {"not": "a list"}):
            with self.subTest(anchors=anchors):
                self.assertIs(run_all.attach_cv_locators(cv, anchors, None), cv)


if __name__ == "__main__":
    unittest.main()
