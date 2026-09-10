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


if __name__ == "__main__":
    unittest.main()
