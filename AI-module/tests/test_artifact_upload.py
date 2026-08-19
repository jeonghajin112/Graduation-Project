import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError


AI_MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_MODULE_DIR))

import run_all  # noqa: E402


class FakeResponse:
    def __init__(self, status=201, body=b'{"success":true}'):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False


class ArtifactUploadTests(unittest.TestCase):
    def test_cv_uses_ephemeral_png_and_always_cleans_it_up(self):
        for command_succeeds in (True, False):
            with self.subTest(command_succeeds=command_succeeds):
                capture_path = run_all.create_ephemeral_cv_capture_path()
                self.assertFalse(capture_path.exists())
                capture_path.write_bytes(b"\x89PNG\r\n\x1a\nfixture")

                observed = {}

                def fake_run_command(command, **kwargs):
                    observed["command"] = command
                    observed["exists_during_cv"] = capture_path.exists()
                    observed["bytes_during_cv"] = capture_path.read_bytes()
                    return command_succeeds

                with patch.object(run_all, "run_command", side_effect=fake_run_command):
                    self.assertEqual(
                        run_all.run_cv_from_ephemeral_capture(capture_path),
                        command_succeeds,
                    )

                self.assertTrue(observed["exists_during_cv"])
                self.assertTrue(observed["bytes_during_cv"].startswith(b"\x89PNG"))
                self.assertIn(str(capture_path), observed["command"])
                self.assertFalse(capture_path.exists())

    def test_extracts_request_id_from_direct_and_api_response_json(self):
        self.assertEqual(
            run_all.extract_evaluation_request_id('{"evaluation_request_id":41}'),
            41,
        )
        self.assertEqual(
            run_all.extract_evaluation_request_id(
                '{"success":true,"data":{"evaluation_request_id":42}}'
            ),
            42,
        )
        self.assertEqual(run_all.extract_evaluation_request_id('not-json', 43), 43)

    def test_builds_exact_metadata_and_document_multipart_parts(self):
        document = "<!doctype html><html lang=\"ko\"><body>재현</body></html>".encode(
            "utf-8"
        )
        body = run_all.build_artifact_multipart(
            {"requestedUrl": "https://example.test"},
            document,
            "BOUNDARY",
        )
        self.assertIn(
            b'Content-Disposition: form-data; name="metadata"\r\n'
            b'Content-Type: application/json\r\n\r\n',
            body,
        )
        self.assertIn(
            b'Content-Disposition: form-data; name="document"; filename="page.html"\r\n'
            b'Content-Type: text/html; charset=utf-8\r\n\r\n' + document,
            body,
        )
        self.assertNotIn(b'name="image"', body)
        self.assertNotIn(b"image/png", body)
        self.assertTrue(body.endswith(b"--BOUNDARY--\r\n"))

    def test_ingestion_returns_saved_request_id_for_followup_upload(self):
        body = b'{"success":true,"data":{"evaluation_request_id":88}}'
        with patch("urllib.request.urlopen", return_value=FakeResponse(201, body)):
            saved, request_id = run_all.send_to_backend(
                {"url": "https://example.test", "request_id": 87}
            )
        self.assertTrue(saved)
        self.assertEqual(request_id, 88)

    def test_api_response_failure_does_not_start_artifact_followup(self):
        body = b'{"success":false,"data":null,"message":"rejected"}'
        with patch("urllib.request.urlopen", return_value=FakeResponse(200, body)):
            saved, request_id = run_all.send_to_backend(
                {"url": "https://example.test", "request_id": 87}
            )
        self.assertFalse(saved)
        self.assertIsNone(request_id)

    def test_uploads_artifact_to_request_scoped_endpoint(self):
        metadata = {
            "requestedUrl": "https://example.test",
            "finalUrl": "https://example.test/",
            "capturedAt": "2026-08-11T09:00:00.000",
            "viewportWidthCssPx": 1280,
            "viewportHeightCssPx": 720,
            "deviceScaleFactor": 1,
            "pageWidthCssPx": 1280,
            "pageHeightCssPx": 720,
            "captureMode": "DOM_REPLAY",
        }
        captured_request = {}

        def fake_urlopen(request, timeout):
            captured_request["request"] = request
            captured_request["timeout"] = timeout
            return FakeResponse()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata_path = root / "result_artifact.json"
            document_path = root / "result.html"
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            document_path.write_text(
                "<!doctype html><html><body>재현</body></html>",
                encoding="utf-8",
            )

            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                self.assertTrue(
                    run_all.upload_artifact(77, metadata_path, document_path)
                )

        request = captured_request["request"]
        self.assertEqual(
            request.full_url,
            f"{run_all.API_BASE_URL}/evaluations/77/artifact",
        )
        self.assertIn("multipart/form-data; boundary=", request.get_header("Content-type"))
        self.assertIn(b'name="metadata"', request.data)
        self.assertIn(b'name="document"', request.data)
        self.assertIn("재현".encode("utf-8"), request.data)
        self.assertNotIn(b'name="image"', request.data)

    def test_artifact_transport_failure_is_reported_without_raising(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata_path = root / "result_artifact.json"
            document_path = root / "result.html"
            metadata_path.write_text("{}", encoding="utf-8")
            document_path.write_text("<html></html>", encoding="utf-8")

            with patch("urllib.request.urlopen", side_effect=URLError("offline")):
                self.assertFalse(
                    run_all.upload_artifact(77, metadata_path, document_path)
                )


if __name__ == "__main__":
    unittest.main()
