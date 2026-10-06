"""레이어 팝업(POPUP): 텍스트·CV 결과를 점수 밖 제외 항목으로 붙이는 run_all 동작."""

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
sys.path.insert(0, str(AI_MODULE_DIR / "text-level-analyzer"))

import cv_runner  # noqa: E402
import run_all  # noqa: E402
import text_extractor  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402


LAYER = {"index": 0, "id": "layerPopup", "x": 200, "y": 60, "width": 800, "height": 500}


class PopupTextTests(unittest.TestCase):
    def test_popup_blocks_are_tagged_and_lose_page_selectors(self):
        blocks = run_all.tag_popup_text_blocks([
            {"text": "아래 버튼을 누르세요", "selector": "section > p", "locator": {"x": 1}, "flags": ["위치 참조"]},
            "not a block",
        ])
        self.assertEqual(blocks, [{"text": "아래 버튼을 누르세요", "flags": ["위치 참조"], "exclusion_reason": "POPUP"}])

    def test_popup_blocks_are_appended_without_changing_the_page_score(self):
        difficulty = {"meta": {"page_score": 88, "flagged_count": 1}, "results": [{"text": "본문"}]}
        suggestions = {"results": [{"text": "본문", "suggestions": []}]}
        popup = [{"text": "팝업", "exclusion_reason": "POPUP"}]
        merged_difficulty, merged_suggestions = run_all.merge_popup_text_blocks(difficulty, suggestions, popup)
        self.assertEqual(merged_difficulty["meta"], difficulty["meta"])
        self.assertEqual([b["text"] for b in merged_difficulty["results"]], ["본문", "팝업"])
        self.assertEqual([b["text"] for b in merged_suggestions["results"]], ["본문", "팝업"])
        self.assertEqual(len(difficulty["results"]), 1, "inputs are not mutated")
        # A failed suggestion step keeps its own shape.
        failed = {"status": "failed"}
        self.assertIs(run_all.merge_popup_text_blocks(difficulty, failed, popup)[1], failed)

    def test_text_extractor_reads_popup_text_only_in_popup_mode(self):
        html = """<html><body><section data-ua-popup-content="0">
          <div id="popupContent" class="popup" role="dialog"><p>추석 연휴 민원실 운영 안내입니다. 아래 버튼을 눌러 확인하세요.</p></div>
          <p style="display:none">숨은 문구</p></section></body></html>"""
        page_mode = [b["text"] for b in text_extractor.extract_texts(html)["blocks"]]
        popup_mode = [b["text"] for b in text_extractor.extract_texts(html, popup_layer=True)["blocks"]]
        self.assertFalse(any("추석" in text for text in page_mode))
        self.assertTrue(any("추석" in text for text in popup_mode))
        self.assertFalse(any("숨은" in text for text in popup_mode), "display:none is still removed")


class PopupCvTests(unittest.TestCase):
    def test_popup_violations_move_to_document_coordinates_with_reason(self):
        violations = [{"text": "안내", "location": {"x": 10, "y": 20, "width": 30, "height": 10}, "reason": "POPUP"}]
        moved = run_all.popup_cv_violations(LAYER, violations, scale=2.0)
        self.assertEqual(moved[0]["location"], {"x": 420.0, "y": 160.0, "width": 60.0, "height": 20.0})
        self.assertEqual(moved[0]["reason"], "POPUP")

    def test_popup_violations_covered_by_rule_contrast_are_dropped(self):
        layer = {**LAYER, "color_contrast_boxes": [{"x": 205, "y": 75, "width": 50, "height": 20}]}
        violations = [
            {"text": "HTML 글자", "location": {"x": 10, "y": 20, "width": 30, "height": 10}},
            {"text": "이미지 글자", "location": {"x": 300, "y": 300, "width": 30, "height": 10}},
        ]
        self.assertEqual([v["text"] for v in run_all.popup_cv_violations(layer, violations, 1.0)], ["이미지 글자"])

    def test_popup_cv_violations_are_added_to_excluded_violations_only(self):
        cv = {"summary": {"pass_rate": 90}, "violations": [{"text": "본문"}],
              "excluded_violations": [{"text": "광고", "reason": "AD"}]}
        merged = run_all.merge_popup_cv_violations(cv, [{"text": "팝업", "reason": "POPUP"}])
        self.assertEqual(merged["summary"], cv["summary"])
        self.assertEqual(merged["violations"], cv["violations"])
        self.assertEqual([v["reason"] for v in merged["excluded_violations"]], ["AD", "POPUP"])

    def test_cv_runner_reports_all_popup_image_text_as_excluded(self):
        regions = [{"reason": "POPUP", "x": 0, "y": 0, "width": 10 ** 6, "height": 10 ** 6}]
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "popup.png"
            picture = Image.new("RGB", (160, 60), (255, 255, 255))
            draw = ImageDraw.Draw(picture)
            for stroke in range(32, 88, 6):  # light gray strokes: low contrast text
                draw.rectangle((stroke, 23, stroke + 2, 36), fill=(200, 200, 200))
            picture.save(image)
            region_file = Path(directory) / "regions.json"
            region_file.write_text(json.dumps(regions), encoding="utf-8")
            texts = [{"text": "연휴 안내", "bbox": {"x": 30, "y": 20, "width": 60, "height": 20}}]
            with patch.object(cv_runner, "run_ocr", return_value={"backend": "fixture", "texts": texts}), \
                    redirect_stdout(io.StringIO()):
                result = cv_runner.CVRunner().analyze(
                    str(image), str(Path(directory) / "cv.json"),
                    excluded_regions=cv_runner.load_excluded_regions(str(region_file)))
        self.assertEqual([(v["text"], v["reason"]) for v in result["excluded_violations"]], [("연휴 안내", "POPUP")])
        self.assertEqual(result["violations"], [])

    def test_popup_images_are_analyzed_in_isolation_and_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = Path(directory) / "uniaccess-cv-run.png"
            image = run_all.popup_cv_capture_path(capture, 0)
            image.write_bytes(b"png")
            seen = {}

            def fake_run_command(command, cwd=None, description=""):
                seen["command"] = command
                output = Path(command[command.index("--output") + 1])
                regions = json.loads(Path(command[command.index("--excluded-regions") + 1]).read_text(encoding="utf-8"))
                seen["regions"] = regions
                seen["cwd"] = cwd
                output.write_text(json.dumps({"excluded_violations": [
                    {"text": "연휴 안내", "reason": "POPUP", "location": {"x": 1, "y": 2, "width": 3, "height": 4}},
                ]}), encoding="utf-8")
                return True

            with patch.object(run_all, "run_command", side_effect=fake_run_command):
                violations = run_all.analyze_popup_cv([LAYER], capture, {"deviceScaleFactor": 1})
            self.assertEqual([r["reason"] for r in seen["regions"]], ["POPUP"])
            self.assertNotEqual(Path(seen["cwd"]), run_all.OUTPUT_DIR, "OCR side files stay out of output/")
            self.assertEqual(violations[0]["location"], {"x": 201.0, "y": 62.0, "width": 3.0, "height": 4.0})
            self.assertFalse(image.exists(), "the popup image is deleted after analysis")

    def test_popup_layers_and_capture_paths(self):
        rule = {"metadata": {"popup_layers": [LAYER, {"index": True, "x": 0, "y": 0, "width": 1, "height": 1},
                                              {"index": 1, "x": "bad"}]}}
        self.assertEqual(run_all.popup_layers_of(rule), [LAYER])
        self.assertEqual(run_all.popup_layers_of(None), [])
        capture = Path(tempfile.gettempdir()) / "uniaccess-cv-abc.png"
        # Same naming rule as popupCvCapturePath() in popup-layers.js.
        self.assertEqual(run_all.popup_cv_capture_path(capture, 2).name, "uniaccess-cv-abc-popup-2.png")


if __name__ == "__main__":
    unittest.main()
