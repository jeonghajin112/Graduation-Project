import json
import tempfile
import unittest
from pathlib import Path

import suggestion_generator


class SuggestionGeneratorStandardsTest(unittest.TestCase):
    def test_output_carries_canonical_standard_metadata(self):
        suggestion_generator.OFFLINE_MODE = True
        payload = {
            "meta": {},
            "results": [{
                "text": "위의 복잡한 안내를 확인하세요",
                "category": "paragraph",
                "flags": ["어려운 어휘 과다", "위치 참조"],
                "metrics": {"easy_word_ratio": 0.2, "grade_detail": {}},
                "difficulty_score": 50,
                "needs_suggestion": True,
            }],
        }

        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "result_text_difficulty.json"
            output_path = Path(directory) / "result_text_suggestions.json"
            input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            result = suggestion_generator.generate_suggestions(str(input_path), str(output_path))

        block = result["results"][0]
        self.assertEqual(
            ["WCAG 3.1.5", "KWCAG 5.3.3"],
            [
                (
                    f"KWCAG {item['kwcag_items'][0]['id']}"
                    if item["kwcag_items"]
                    else f"WCAG {item['wcag']['id']}"
                )
                for item in block["standard_issues"]
            ],
        )
        self.assertEqual({"id": "3.1.5", "name": "읽기 수준", "standard": "WCAG", "version": "2.2"},
                         block["suggestions"][0]["wcag_ref"])
        self.assertEqual("5.3.3", block["suggestions"][1]["kwcag_items"][0]["id"])


if __name__ == "__main__":
    unittest.main()
