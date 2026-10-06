import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import requests

import suggestion_generator


def eligible_block():
    return {
        "text": "가" * 60,
        "category": "paragraph",
        "flags": ["문장 길이 과다: 30어절"],
        "metrics": {},
        "difficulty_score": 80,
        "needs_suggestion": True,
    }


def run_generator(block_count):
    payload = {"meta": {}, "results": [eligible_block() for _ in range(block_count)]}
    with tempfile.TemporaryDirectory() as directory:
        input_path = Path(directory) / "result_text_difficulty.json"
        output_path = Path(directory) / "result_text_suggestions.json"
        input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        result = suggestion_generator.generate_suggestions(str(input_path), str(output_path))
        written = json.loads(output_path.read_text(encoding="utf-8"))
    return result, written


class OnlineModeTestCase(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(suggestion_generator, "OFFLINE_MODE", False)
        patcher.start()
        self.addCleanup(patcher.stop)


class LlmCallLimitTest(OnlineModeTestCase):
    def test_failed_calls_count_toward_the_call_limit(self):
        with mock.patch.object(suggestion_generator, "call_openai_api", return_value=None) as call:
            result, written = run_generator(50)

        self.assertEqual(suggestion_generator.MAX_LLM_CALLS, call.call_count)
        stats = written["meta"]["suggestion_stats"]
        self.assertEqual(suggestion_generator.MAX_LLM_CALLS, stats["llm_calls"])
        self.assertEqual(0, stats["llm_succeeded"])
        # Rule-based template suggestions are saved even when every LLM call fails.
        self.assertTrue(all(block["suggestions"] for block in result["results"]))

    def test_calls_run_concurrently(self):
        # Two calls can pass the barrier only when they are in flight together.
        barrier = threading.Barrier(2, timeout=5)

        def call(prompt, deadline):
            barrier.wait()
            return {"revised_text": "쉬운 문장", "reason": "짧게"}

        with mock.patch.object(suggestion_generator, "call_openai_api", side_effect=call):
            _, written = run_generator(2)

        self.assertEqual(2, written["meta"]["suggestion_stats"]["llm_succeeded"])


class CallOpenAiApiTest(OnlineModeTestCase):
    def test_non_json_success_response_is_a_failed_call(self):
        response = mock.Mock(status_code=200, text="<html>proxy error</html>")
        response.json.side_effect = requests.exceptions.JSONDecodeError("Expecting value", "<html>", 0)

        with mock.patch("requests.post", return_value=response):
            self.assertIsNone(suggestion_generator.call_openai_api("prompt"))

    def test_non_object_json_content_is_a_failed_call(self):
        response = mock.Mock(status_code=200, text="")
        response.json.return_value = {"choices": [{"message": {"content": "[1, 2]"}}]}

        with mock.patch("requests.post", return_value=response):
            self.assertIsNone(suggestion_generator.call_openai_api("prompt"))

    def test_expired_deadline_sends_no_request(self):
        with mock.patch("requests.post") as post:
            self.assertIsNone(suggestion_generator.call_openai_api("prompt", time.monotonic()))
        post.assert_not_called()

    def test_retries_stop_at_the_deadline(self):
        with mock.patch("requests.post", side_effect=requests.exceptions.Timeout("slow")) as post, \
                mock.patch.object(suggestion_generator.time, "sleep") as sleep:
            self.assertIsNone(suggestion_generator.call_openai_api("prompt", time.monotonic() + 2))

        # A 2 second retry delay no longer fits, so the call gives up after one try.
        self.assertEqual(1, post.call_count)
        sleep.assert_not_called()
        self.assertLessEqual(post.call_args.kwargs["timeout"], 2)


if __name__ == "__main__":
    unittest.main()
