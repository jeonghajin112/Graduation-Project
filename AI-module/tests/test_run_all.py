import io
import json
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import Mock, call, patch


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


def valid_capture_metadata(target_url="https://example.test"):
    return {
        "requestedUrl": target_url,
        "finalUrl": target_url,
        "capturedAt": "2026-08-11T09:00:00.000",
        "viewportWidthCssPx": 1280,
        "viewportHeightCssPx": 720,
        "deviceScaleFactor": 1,
        "pageWidthCssPx": 1280,
        "pageHeightCssPx": 1440,
    }


def write_valid_rule_outputs(output_dir, target_url, score=88):
    rule_result = {
        "metadata": {"url": target_url},
        "score": {"score": score},
        "violations": [],
    }
    (output_dir / "result.json").write_text("{}", encoding="utf-8")
    (output_dir / "result_api.json").write_text(
        json.dumps(rule_result),
        encoding="utf-8",
    )
    (output_dir / "result.html").write_text(
        "<!doctype html><html><body>fixture</body></html>",
        encoding="utf-8",
    )
    (output_dir / "result_artifact.json").write_text(
        json.dumps(valid_capture_metadata(target_url)),
        encoding="utf-8",
    )
    return rule_result


class RunAllPipelineTests(unittest.TestCase):
    def test_total_score_excludes_non_scoring_and_malformed_module_json(self):
        invalid_results = [
            (
                {"metadata": {"url": "https://example.test"}},
                {"meta": {}},
                {"summary": {}},
            ),
            (
                {"score": {"score": True}},
                {"meta": {"page_score": float("nan")}},
                {"summary": {"pass_rate": "100"}},
            ),
            (
                [],
                {"meta": []},
                {"summary": {"pass_rate": float("inf")}},
            ),
        ]

        for rule_result, difficulty_result, cv_result in invalid_results:
            with self.subTest(
                rule_result=rule_result,
                difficulty_result=difficulty_result,
                cv_result=cv_result,
            ):
                total = run_all.calculate_total_score(
                    rule_result,
                    difficulty_result,
                    cv_result,
                )
                self.assertEqual(total["total_score"], 0)
                self.assertEqual(total["module_scores"], {})
                self.assertEqual(total["weights_applied"], {})

        legitimate_zero = run_all.calculate_total_score(
            {"score": {"score": 0}},
            None,
            None,
        )
        self.assertEqual(legitimate_zero["module_scores"], {"rule_based": 0.0})
        self.assertEqual(legitimate_zero["weights_applied"], {"rule_based": 100.0})

    def test_run_command_forwards_default_and_step_specific_timeouts(self):
        default_process = Mock(pid=101, returncode=0)
        default_process.communicate.return_value = (b"", b"")
        rule_process = Mock(pid=102, returncode=0)
        rule_process.communicate.return_value = (b"", b"")

        with patch.object(
            run_all.subprocess,
            "Popen",
            side_effect=[default_process, rule_process],
        ) as popen:
            self.assertTrue(run_all.run_command(["noop"], description="default"))
            default_process.communicate.assert_called_once_with(
                timeout=run_all.DEFAULT_STEP_TIMEOUT_SECONDS
            )

            self.assertTrue(
                run_all.run_command(
                    ["noop"],
                    description="rule scan",
                    timeout_seconds=run_all.RULE_BASED_STEP_TIMEOUT_SECONDS,
                )
            )
            rule_process.communicate.assert_called_once_with(
                timeout=run_all.RULE_BASED_STEP_TIMEOUT_SECONDS
            )
            expected_group_options = run_all.process_group_options()
            for popen_call in popen.call_args_list:
                for name, value in expected_group_options.items():
                    self.assertEqual(popen_call.kwargs[name], value)

    def test_run_command_terminates_process_tree_on_timeout(self):
        process = Mock(pid=31415, returncode=None)
        process.communicate.side_effect = [
            run_all.subprocess.TimeoutExpired(
                cmd=["node", "run.js"],
                timeout=1,
                output=b"partial output",
            ),
            (b"partial output", b""),
        ]

        with (
            patch.object(run_all.subprocess, "Popen", return_value=process),
            patch.object(run_all, "terminate_process_tree") as terminate_tree,
        ):
            self.assertFalse(
                run_all.run_command(
                    ["node", "run.js"],
                    description="rule scan",
                    timeout_seconds=1,
                )
            )

        terminate_tree.assert_called_once_with(process)
        self.assertEqual(process.communicate.call_count, 2)

    def test_run_command_stops_a_real_child_process_tree_on_timeout(self):
        child_code = (
            "import pathlib,sys,time; "
            "marker=pathlib.Path(sys.argv[1]); "
            "[(marker.write_text(str(counter), encoding='utf-8'), time.sleep(0.05)) "
            "for counter in range(160)]"
        )
        parent_code = (
            "import subprocess,sys,time; "
            "subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]]); "
            "time.sleep(8)"
        )

        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / "child-heartbeat.txt"
            with redirect_stdout(io.StringIO()):
                completed = run_all.run_command(
                    [
                        sys.executable,
                        "-c",
                        parent_code,
                        child_code,
                        str(heartbeat),
                    ],
                    description="process tree fixture",
                    timeout_seconds=2,
                )
            self.assertFalse(completed)
            self.assertTrue(heartbeat.exists())
            stopped_value = heartbeat.read_text(encoding="utf-8")
            time.sleep(0.3)
            self.assertEqual(
                heartbeat.read_text(encoding="utf-8"),
                stopped_value,
            )

    def test_process_tree_termination_uses_platform_specific_group_kill(self):
        windows_process = Mock(pid=2001)
        windows_process.wait.return_value = 0
        with patch.object(run_all.subprocess, "run") as taskkill:
            taskkill.return_value.returncode = 0
            run_all.terminate_process_tree(windows_process, platform_name="nt")
        self.assertEqual(
            taskkill.call_args.args[0],
            ["taskkill.exe", "/PID", "2001", "/T", "/F"],
        )

        posix_process = Mock(pid=2002)
        posix_process.wait.side_effect = run_all.subprocess.TimeoutExpired(
            cmd=["node"],
            timeout=run_all.PROCESS_TERMINATION_WAIT_SECONDS,
        )
        with patch.object(run_all.os, "killpg", create=True) as kill_group:
            run_all.terminate_process_tree(posix_process, platform_name="posix")
        self.assertEqual(
            kill_group.call_args_list,
            [
                call(2002, run_all.POSIX_SIGTERM),
                call(2002, run_all.POSIX_SIGKILL),
            ],
        )

    def test_pipeline_does_not_ingest_when_all_scoring_modules_fail(self):
        target_url = "http://127.0.0.1:8765/unavailable"

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            capture_path = output_dir / "private-cv-input.png"

            with (
                patch.object(run_all, "OUTPUT_DIR", output_dir),
                patch.object(
                    run_all,
                    "create_ephemeral_cv_capture_path",
                    return_value=capture_path,
                ),
                patch.object(run_all, "run_command", return_value=False),
                patch.object(run_all, "send_to_backend") as send_to_backend,
                patch.object(run_all.atexit, "register"),
                patch.object(sys, "argv", ["run_all.py", target_url, "34"]),
            ):
                console = io.StringIO()
                with redirect_stdout(console):
                    with self.assertRaises(SystemExit) as raised:
                        run_all.main()

            final_result = json.loads(
                (output_dir / "result_final.json").read_text(encoding="utf-8")
            )

        self.assertEqual(raised.exception.code, run_all.NO_SCORABLE_RESULT_EXIT_CODE)
        self.assertIn("현재 실행의 유효한 규칙 기반 결과가 없습니다", console.getvalue())
        self.assertEqual(final_result["request_id"], 34)
        self.assertEqual(final_result["total_score"], 0)
        self.assertEqual(final_result["score_breakdown"]["module_scores"], {})
        self.assertEqual(final_result["score_breakdown"]["weights_applied"], {})
        self.assertIsNone(final_result["capture_metadata"])
        send_to_backend.assert_not_called()

    def test_failed_rule_step_cannot_promote_intermediate_optional_results(self):
        target_url = "http://127.0.0.1:8765/partial-rule"

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            capture_path = output_dir / "private-cv-input.png"
            commands = []

            def fake_run_command(command, **kwargs):
                commands.append(command)
                if command[0] == "node":
                    # Simulate run.js writing every intermediate output before
                    # failing. None may authorize optional-module ingestion.
                    write_valid_rule_outputs(output_dir, target_url)
                    capture_path.write_bytes(b"\x89PNG\r\n\x1a\npartial")
                    (output_dir / "result_text_difficulty.json").write_text(
                        '{"meta":{"page_score":97}}',
                        encoding="utf-8",
                    )
                    (output_dir / "result_cv.json").write_text(
                        '{"summary":{"pass_rate":96}}',
                        encoding="utf-8",
                    )
                    return False
                return True

            with (
                patch.object(run_all, "OUTPUT_DIR", output_dir),
                patch.object(
                    run_all,
                    "create_ephemeral_cv_capture_path",
                    return_value=capture_path,
                ),
                patch.object(run_all, "run_command", side_effect=fake_run_command),
                patch.object(run_all, "send_to_backend") as send_to_backend,
                patch.object(run_all.atexit, "register"),
                patch.object(sys, "argv", ["run_all.py", target_url, "35"]),
            ):
                with redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        run_all.main()

            final_result = json.loads(
                (output_dir / "result_final.json").read_text(encoding="utf-8")
            )

        self.assertEqual(raised.exception.code, run_all.NO_SCORABLE_RESULT_EXIT_CODE)
        self.assertEqual([command[0] for command in commands], ["node"])
        self.assertEqual(final_result["score_breakdown"]["module_scores"], {})
        self.assertFalse(capture_path.exists())
        send_to_backend.assert_not_called()

    def test_rule_step_requires_valid_result_and_fresh_capture_metadata(self):
        target_url = "http://127.0.0.1:8765/invalid-rule-output"

        for failure_mode in ("missing_score", "stale_capture_metadata"):
            with self.subTest(failure_mode=failure_mode):
                with tempfile.TemporaryDirectory() as directory:
                    output_dir = Path(directory)
                    capture_path = output_dir / "private-cv-input.png"
                    commands = []

                    def fake_run_command(command, **kwargs):
                        commands.append(command)
                        if command[0] != "node":
                            return True
                        write_valid_rule_outputs(output_dir, target_url)
                        capture_path.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
                        if failure_mode == "missing_score":
                            (output_dir / "result_api.json").write_text(
                                json.dumps({"metadata": {"url": target_url}}),
                                encoding="utf-8",
                            )
                        else:
                            old_time = time.time() - 3600
                            run_all.os.utime(
                                output_dir / "result_artifact.json",
                                (old_time, old_time),
                            )
                        return True

                    with (
                        patch.object(run_all, "OUTPUT_DIR", output_dir),
                        patch.object(
                            run_all,
                            "create_ephemeral_cv_capture_path",
                            return_value=capture_path,
                        ),
                        patch.object(run_all, "run_command", side_effect=fake_run_command),
                        patch.object(run_all, "send_to_backend") as send_to_backend,
                        patch.object(run_all.atexit, "register"),
                        patch.object(sys, "argv", ["run_all.py", target_url, "36"]),
                    ):
                        with redirect_stdout(io.StringIO()):
                            with self.assertRaises(SystemExit) as raised:
                                run_all.main()

                self.assertEqual(
                    raised.exception.code,
                    run_all.NO_SCORABLE_RESULT_EXIT_CODE,
                )
                self.assertEqual([command[0] for command in commands], ["node"])
                send_to_backend.assert_not_called()

    def test_pipeline_uses_current_python_and_completes_with_rule_only_result(self):
        target_url = "https://example.test/fixture"

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            capture_path = output_dir / "private-cv-input.png"
            commands = []
            command_timeouts = []

            def fake_run_command(command, **kwargs):
                commands.append(command)
                command_timeouts.append((command[0], kwargs.get("timeout_seconds")))
                if command[0] == "node":
                    write_valid_rule_outputs(output_dir, target_url)
                    capture_path.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
                    return True

                script_name = Path(command[1]).name
                if script_name == "text_extractor.py":
                    (output_dir / "result_text.json").write_text(
                        '{"meta": {}, "results": []}', encoding="utf-8"
                    )
                    return True

                # Missing MeCab data and Vision credentials are optional-module
                # failures. The rule-based result must still be ingested.
                if script_name in {"difficulty_engine.py", "cv_runner.py"}:
                    return False

                self.fail(f"unexpected command: {command}")

            with (
                patch.object(run_all, "OUTPUT_DIR", output_dir),
                patch.object(
                    run_all,
                    "create_ephemeral_cv_capture_path",
                    return_value=capture_path,
                ),
                patch.object(run_all, "run_command", side_effect=fake_run_command),
                patch.object(run_all, "send_to_backend", return_value=True) as send_to_backend,
                patch.object(run_all.atexit, "register"),
                patch.object(sys, "argv", ["run_all.py", target_url, "31"]),
            ):
                run_all.main()

            final_result = json.loads(
                (output_dir / "result_final.json").read_text(encoding="utf-8")
            )
            capture_was_removed = not capture_path.exists()

        python_commands = [command for command in commands if command[0] != "node"]
        self.assertTrue(python_commands)
        self.assertTrue(all(command[0] == sys.executable for command in python_commands))
        self.assertEqual(
            command_timeouts[0],
            ("node", run_all.RULE_BASED_STEP_TIMEOUT_SECONDS),
        )
        self.assertTrue(all(timeout is None for _, timeout in command_timeouts[1:]))
        self.assertEqual(final_result["request_id"], 31)
        self.assertEqual(final_result["capture_metadata"]["requestedUrl"], target_url)
        self.assertEqual(final_result["capture_metadata"]["viewportWidthCssPx"], 1280)
        self.assertEqual(final_result["total_score"], 88.0)
        self.assertEqual(
            final_result["score_breakdown"]["weights_applied"],
            {"rule_based": 100.0},
        )
        self.assertEqual(final_result["modules"]["text_difficulty"]["status"], "failed")
        self.assertEqual(final_result["modules"]["cv_visual"]["status"], "failed")
        self.assertTrue(capture_was_removed)
        send_to_backend.assert_called_once_with(final_result)

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

                with (
                    patch.dict(
                        run_all.os.environ,
                        {"GOOGLE_APPLICATION_CREDENTIALS": ""},
                    ),
                    patch.object(run_all, "run_command", side_effect=fake_run_command),
                ):
                    self.assertEqual(
                        run_all.run_cv_from_ephemeral_capture(capture_path),
                        command_succeeds,
                    )

                self.assertTrue(observed["exists_during_cv"])
                self.assertTrue(observed["bytes_during_cv"].startswith(b"\x89PNG"))
                self.assertIn(str(capture_path), observed["command"])
                self.assertFalse(capture_path.exists())

    def test_cv_prefers_configured_google_credentials(self):
        capture_path = run_all.create_ephemeral_cv_capture_path()
        capture_path.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        configured_path = str(Path("C:/local-only/vision-service-account.json"))
        observed_command = None

        def fake_run_command(command, **kwargs):
            nonlocal observed_command
            observed_command = command
            return False

        with (
            patch.dict(
                run_all.os.environ,
                {"GOOGLE_APPLICATION_CREDENTIALS": configured_path},
            ),
            patch.object(run_all, "run_command", side_effect=fake_run_command),
        ):
            self.assertFalse(run_all.run_cv_from_ephemeral_capture(capture_path))

        credentials_index = observed_command.index("--credentials")
        self.assertEqual(observed_command[credentials_index + 1], configured_path)
        self.assertFalse(capture_path.exists())

    def test_capture_metadata_validation_matches_ingestion_contract(self):
        requested_url = "http://example.test/start"
        metadata = valid_capture_metadata(requested_url)
        metadata["finalUrl"] = "https://example.test/final/?mode=a"
        analyzed_url = "https://example.test:443/final?mode=a"
        self.assertTrue(
            run_all.validate_capture_metadata(
                requested_url,
                metadata,
                analyzed_url,
            )
        )
        self.assertTrue(
            run_all.validate_capture_metadata(
                requested_url,
                metadata,
                "https://EXAMPLE.test:443/final?mode=a#results",
            )
        )

        # Generator-only fields do not participate in or leak into ingestion.
        metadata_with_mode = {**metadata, "captureMode": "SCREENSHOT"}
        self.assertTrue(
            run_all.validate_capture_metadata(
                requested_url,
                metadata_with_mode,
                analyzed_url,
            )
        )
        self.assertNotIn(
            "captureMode",
            run_all.capture_metadata_payload(metadata_with_mode),
        )

        boundary_url_prefix = "https://example.test/"
        boundary_url = boundary_url_prefix + "x" * (
            run_all.MAX_CAPTURE_URL_LENGTH - len(boundary_url_prefix)
        )
        boundary_metadata = {**metadata, "finalUrl": boundary_url}
        self.assertTrue(
            run_all.validate_capture_metadata(
                requested_url,
                boundary_metadata,
                boundary_url,
            )
        )

        invalid_cases = [
            ("wrong requested host", {"requestedUrl": "https://wrong.example"}, analyzed_url),
            ("different requested path", {"requestedUrl": "http://example.test/other"}, analyzed_url),
            ("different requested query", {"requestedUrl": "http://example.test/start?mode=b"}, analyzed_url),
            ("relative final URL", {"finalUrl": "/final"}, analyzed_url),
            ("HTTP live URL", {"finalUrl": "http://example.test/final?mode=a"}, analyzed_url),
            ("credentialed live URL", {"finalUrl": "https://user@example.test/final"}, analyzed_url),
            ("fragmented live URL", {"finalUrl": "https://example.test/final#results"}, analyzed_url),
            ("non-default live port", {"finalUrl": "https://example.test:8443/final"}, analyzed_url),
            ("URL over backend limit", {"finalUrl": "https://example.test/" + "x" * 2048}, analyzed_url),
            ("malformed URI escape", {"finalUrl": "https://example.test/%ZZ"}, analyzed_url),
            ("raw URI brackets", {"finalUrl": "https://example.test/[section]"}, "https://example.test/[section]"),
            ("invalid captured time", {"capturedAt": "yesterday"}, analyzed_url),
            ("numeric captured time", {"capturedAt": 20260811}, analyzed_url),
            ("date-only captured time", {"capturedAt": "2026-08-11"}, analyzed_url),
            ("space-separated captured time", {"capturedAt": "2026-08-11 09:00:00"}, analyzed_url),
            ("zoned captured time", {"capturedAt": "2026-08-11T09:00:00+09:00"}, analyzed_url),
            ("fractional dimension", {"viewportWidthCssPx": 1280.5}, analyzed_url),
            ("dimension above Java int", {"viewportWidthCssPx": 2_147_483_648, "pageWidthCssPx": 2_147_483_648}, analyzed_url),
            ("page narrower than viewport", {"pageWidthCssPx": 1279}, analyzed_url),
            ("scale above backend limit", {"deviceScaleFactor": 10.1}, analyzed_url),
            ("different analyzed path", {}, "https://example.test/other?mode=a"),
            ("different analyzed query", {}, "https://example.test/final?mode=b"),
            ("different analyzed www origin", {}, "https://www.example.test/final?mode=a"),
            ("credentialed analyzed URL", {}, "https://user@example.test/final?mode=a"),
            ("missing analyzed URL", {}, ""),
        ]
        for label, change, observed_url in invalid_cases:
            with self.subTest(label=label):
                invalid = {**metadata, **change}
                self.assertFalse(
                    run_all.validate_capture_metadata(
                        requested_url,
                        invalid,
                        observed_url,
                    )
                )

    def test_final_result_embeds_capture_metadata_without_html(self):
        metadata = valid_capture_metadata()
        metadata["captureMode"] = "DOM_REPLAY"
        metadata["generatorDiagnostic"] = "not part of ingestion"
        final_result = run_all.build_final_result(
            url="https://example.test",
            rule_result={"score": {"score": 88}},
            difficulty_result=None,
            suggestion_result=None,
            cv_result=None,
            capture_metadata=metadata,
            total_score={
                "total_score": 88,
                "grade": "B+",
                "module_scores": {"rule_based": 88},
                "weights_applied": {"rule_based": 100},
            },
            elapsed=1.5,
            request_id=87,
        )

        self.assertEqual(
            set(final_result["capture_metadata"]),
            set(run_all.CAPTURE_METADATA_FIELDS),
        )
        self.assertNotIn("captureMode", final_result["capture_metadata"])
        self.assertNotIn("generatorDiagnostic", final_result["capture_metadata"])
        serialized = json.dumps(final_result)
        self.assertNotIn("<!doctype html>", serialized)
        self.assertNotIn('"document"', serialized)

    def test_final_result_marks_malformed_optional_modules_failed(self):
        final_result = run_all.build_final_result(
            url="https://example.test",
            rule_result={"score": {"score": 88}},
            difficulty_result={"meta": [], "unexpected": "nonempty"},
            suggestion_result={"meta": {"page_score": 88}, "results": []},
            cv_result={"summary": [], "unexpected": "nonempty"},
            capture_metadata=valid_capture_metadata(),
            total_score={
                "total_score": 88,
                "grade": "B+",
                "module_scores": {"rule_based": 88},
                "weights_applied": {"rule_based": 100},
            },
            elapsed=1.5,
            request_id=87,
        )

        self.assertEqual(final_result["modules"]["text_difficulty"]["status"], "failed")
        self.assertEqual(final_result["modules"]["text_suggestions"]["status"], "failed")
        self.assertEqual(final_result["modules"]["cv_visual"]["status"], "failed")

    def test_ingestion_posts_capture_metadata_once_as_json(self):
        final_result = {
            "url": "https://example.test",
            "request_id": 87,
            "capture_metadata": valid_capture_metadata(),
        }
        captured_requests = []

        def fake_urlopen(request, timeout):
            captured_requests.append((request, timeout))
            return FakeResponse(201)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            self.assertTrue(run_all.send_to_backend(final_result))

        self.assertEqual(len(captured_requests), 1)
        request, timeout = captured_requests[0]
        self.assertEqual(request.full_url, f"{run_all.API_BASE_URL}/evaluations")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(timeout, 10)
        self.assertEqual(json.loads(request.data.decode("utf-8")), final_result)
        self.assertNotIn(b"multipart/form-data", request.data)

    def test_api_response_failure_is_reported(self):
        body = b'{"success":false,"data":null,"message":"rejected"}'
        with patch("urllib.request.urlopen", return_value=FakeResponse(200, body)):
            self.assertFalse(
                run_all.send_to_backend(
                    {"url": "https://example.test", "request_id": 87}
                )
            )

    def test_http_error_reports_status_and_response_body_separately(self):
        error = HTTPError(
            f"{run_all.API_BASE_URL}/evaluations",
            422,
            "Unprocessable Entity",
            {},
            io.BytesIO(
                b'{"success":false,"message":"capture_metadata rejected"}'
            ),
        )
        console = io.StringIO()
        with (
            patch("urllib.request.urlopen", side_effect=error),
            redirect_stdout(console),
        ):
            self.assertFalse(
                run_all.send_to_backend(
                    {"url": "https://example.test", "request_id": 87}
                )
            )

        output = console.getvalue()
        self.assertIn("HTTP 422", output)
        self.assertIn("capture_metadata rejected", output)
        self.assertNotIn("서버 연결 불가", output)


if __name__ == "__main__":
    unittest.main()
