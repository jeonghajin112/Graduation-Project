"""
통합 실행기 - run_all.py

[역할]
  URL 하나를 입력하면 현재 활성화된 분석 모듈을 순서대로 실행하고,
  각 모듈의 결과를 하나의 통합 JSON(result_final.json)으로 합쳐서
  총점과 등급을 계산

[이 파일의 역할 한 줄 요약]
  "전체 파이프라인의 지휘자. URL → 규칙 기반 → 난이도 분석 → CV 분석 → 총점 계산 → 백엔드 전송"

[실행 파이프라인 — 7단계]
  Step 1: [Node.js] 규칙 기반 평가 (axe-core + KWCAG 매핑 + 100점 감점 방식)
  Step 2: [Python]  HTML에서 분석 대상 텍스트 추출 + 카테고리 분류
  Step 3: [Python]  한국어 인지 난이도 분석 (MeCab 형태소 분석 기반)
  Step 4: [Python]  난이도 높은 문장에 대한 LLM 수정 제안 생성 (GPT-4o-mini)
  Step 5: [Python]  CV 분석 (Step 1의 전용 임시 PNG를 입력으로 사용 후 즉시 삭제)
  Step 6: 위 결과들을 합쳐서 총점 계산 → result_final.json 생성
  Step 7: capture metadata를 포함한 result_final.json을 백엔드에 한 번 전송

[총점 계산 공식]
  총점 = (규칙 기반 점수 × 50%) + (난이도 page_score × 30%) + (CV 통과율 × 20%)
  
  난이도의 page_score는 difficulty_engine.py에서 이미
  "100 - 감점" 방식으로 계산된 값이므로 (높을수록 좋음),
  별도의 반전 없이 그대로 사용함.

[등급 기준]
  A+(95↑), A(90↑), B+(85↑), B(80↑), C(70↑), D(60↑), F(60 미만)

[모듈 부분 실패 처리]
  현재 실행의 유효한 규칙 기반 결과는 완료 저장의 필수 조건
  난이도 또는 CV가 실패하면 해당 모듈을 제외하고 가중치를 재분배
  예: CV 모듈만 실패 → 규칙 기반(50/80=62.5%)과 난이도(30/80=37.5%)로 재계산

[실행 방법]
  python run_all.py <URL>
  예: python run_all.py https://www.gov.kr

[출력]
  output/ 폴더에 모든 결과 파일이 저장됨:
    result.json                 ← axe-core 원본 + KWCAG 매핑 결과
    result_api.json             ← 규칙 기반 결과 (API 스펙 형태)
    result.html                 ← 현재 실행의 텍스트 추출 내부 입력
    result_artifact.json        ← 현재 실행의 URL/뷰포트/문서 크기 메타데이터
    result_text.json            ← 추출된 텍스트 블록 (카테고리별 분류)
    result_text_difficulty.json ← 블록별 난이도 점수
    result_text_suggestions.json ← 블록별 수정 제안
    result_cv.json              ← 임시 PNG를 분석한 CV 결과(입력 경로 미포함)
    ★result_final.json          ← 최종 통합 결과 (백엔드가 받는 파일)
"""

import json
import ipaddress
import math
import re
import sys
import os
import atexit
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional, Tuple
from urllib.parse import urlparse


# ── 설정 ─────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).parent.resolve()

# 각 모듈의 소스 코드 경로
RULE_BASED_DIR = PROJECT_ROOT / "rule-based-analyzer"    # 모듈 1: 규칙 기반 (Node.js)
TEXT_LEVEL_DIR = PROJECT_ROOT / "text-level-analyzer"    # 모듈 2: 난이도 분석 (Python)
CV_ANALYZER_DIR = PROJECT_ROOT / "cv-analyzer"           # 모듈 3: CV 시각 분석 (Python)

# 결과 파일 출력 디렉토리 — 모든 모듈의 결과가 이 폴더에 모임
OUTPUT_DIR = PROJECT_ROOT / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

RUN_OUTPUT_FILES = [
    "result.json",
    "result_api.json",
    "result.html",
    "result_text.json",
    "result_text_difficulty.json",
    "result_text_suggestions.json",
    "result_cv.json",
    "result_ocr.json",
    "result_final.json",
    "result_artifact.json",
]

# Remove the obsolete persistent screenshot from older runs. The current
# pipeline only creates an OS-temp PNG as private CV input and never stores it
# under output/ or sends it to the backend.
LEGACY_OUTPUT_FILES = ["result.png"]


def clear_previous_outputs() -> bool:
    """Remove stale per-run outputs and report whether the workspace is clean."""
    cleanup_ok = True
    for filename in RUN_OUTPUT_FILES + LEGACY_OUTPUT_FILES:
        path = OUTPUT_DIR / filename
        try:
            if path.exists():
                path.unlink()
        except OSError as e:
            print(f"  [warning] could not remove stale output {filename}: {e}")
            cleanup_ok = False
    return cleanup_ok


def is_fresh_nonempty_file(path: Path, not_before_ns: int) -> bool:
    """Accept only a non-empty output written after the current step started."""
    try:
        stat = path.stat()
    except OSError:
        return False
    return path.is_file() and stat.st_size > 0 and stat.st_mtime_ns >= not_before_ns


def output_fingerprint(path: Path) -> Optional[Tuple[int, int]]:
    """Return the immutable fields used to detect mid-pipeline replacement."""
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_size, stat.st_mtime_ns


def create_ephemeral_cv_capture_path() -> Path:
    """Reserve a unique OS-temp path without leaving an empty placeholder."""
    descriptor, raw_path = tempfile.mkstemp(prefix="uniaccess-cv-", suffix=".png")
    os.close(descriptor)
    path = Path(raw_path)
    path.unlink()
    return path


def cleanup_ephemeral_cv_capture(path: Path) -> None:
    """Best-effort cleanup limited to the exact temp file created for this run."""
    try:
        path.unlink(missing_ok=True)
    except OSError as error:
        print(f"  [CV] 임시 이미지 정리 실패: {error}")

# Google Vision API 서비스 계정 키의 기존 로컬 fallback 경로.
# GOOGLE_APPLICATION_CREDENTIALS가 있으면 환경 변수를 우선하고, 둘 다
# 없으면 자격증명 인자 없이 실행해 CV 모듈만 부분 실패로 처리한다.
VISION_CREDENTIALS = CV_ANALYZER_DIR / "uniaccess-495010-08a5c6701cd7.json"

# 백엔드 서버 주소 (Spring Boot 서버)
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:9090/api/v1").rstrip("/")

# 총점 가중치
# 규칙 기반 50%: KWCAG 33개 항목 대부분을 커버하므로 가장 높은 비중
# 난이도 30%: 기존 도구에 없는 독창적 기능이므로 의미 있는 비중
# CV 20%: KWCAG 5.3.3 한 항목만 검사하므로 상대적으로 낮은 비중
WEIGHT_RULE_BASED = 0.50
WEIGHT_DIFFICULTY = 0.30
WEIGHT_CV = 0.20

# The backend treats any non-zero process status as a failed evaluation request.
# Keep this distinct from the navigation-blocked status (2) so runtime logs show
# that the pipeline ran but produced no score-bearing module result.
NO_SCORABLE_RESULT_EXIT_CODE = 3

# Most local analyzers finish quickly, while the browser-based rule scan may
# need extra time for a slow public page, static fallback, and axe traversal.
DEFAULT_STEP_TIMEOUT_SECONDS = 120
RULE_BASED_STEP_TIMEOUT_SECONDS = 240
PROCESS_TERMINATION_WAIT_SECONDS = 5
WINDOWS_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
POSIX_SIGTERM = getattr(signal, "SIGTERM", 15)
POSIX_SIGKILL = getattr(signal, "SIGKILL", 9)


# ── Step 실행 함수들 ─────────────────────────────────────────────────────────


def run_step(step_num: int, total: int, description: str):
    """각 Step의 시작을 콘솔에 출력하는 헬퍼 함수."""
    print(f"\n[Step {step_num}/{total}] {description}")
    print("-" * 50)


def process_group_options(platform_name: Optional[str] = None) -> Dict[str, Any]:
    """Start each analyzer in a group that can be terminated as one unit."""
    platform_name = os.name if platform_name is None else platform_name
    if platform_name == "nt":
        return {"creationflags": WINDOWS_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def terminate_process_tree(
    process: subprocess.Popen,
    platform_name: Optional[str] = None,
) -> None:
    """Best-effort termination limited to the analyzer process group/tree."""
    platform_name = os.name if platform_name is None else platform_name
    if platform_name == "nt":
        tree_killed = False
        try:
            taskkill_result = subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=PROCESS_TERMINATION_WAIT_SECONDS,
            )
            tree_killed = taskkill_result.returncode == 0
            if not tree_killed:
                process.kill()
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            try:
                process.kill()
            except OSError:
                pass
        try:
            process.wait(timeout=PROCESS_TERMINATION_WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except OSError:
                pass
        return

    process_group_id = process.pid  # start_new_session=True makes pid == pgid.
    try:
        os.killpg(process_group_id, POSIX_SIGTERM)
    except ProcessLookupError:
        return
    except OSError:
        try:
            process.kill()
        except OSError:
            pass
        return

    try:
        process.wait(timeout=PROCESS_TERMINATION_WAIT_SECONDS)
    except subprocess.TimeoutExpired:
        pass

    # The parent may have exited while a browser child remains in the group.
    # A final group kill is harmless when the group has already disappeared.
    try:
        os.killpg(process_group_id, POSIX_SIGKILL)
    except ProcessLookupError:
        pass


def decode_process_output(output: Any) -> str:
    if isinstance(output, bytes):
        return output.decode("utf-8", errors="replace").strip()
    return str(output or "").strip()


def run_command(
    cmd: list,
    cwd: str = None,
    description: str = "",
    timeout_seconds: int = DEFAULT_STEP_TIMEOUT_SECONDS,
) -> bool:
    """
    외부 명령어(Node.js, Python 스크립트 등)를 subprocess로 실행
    
    [반환값]
    True: 정상 종료 (종료 코드 0)
    False: 실패 (비정상 종료, 타임아웃, 파일 없음 등)
    
    [타임아웃]
    기본 제한 시간은 2분(120초)이며, 브라우저 기반 규칙 검사는 호출부에서
    4분(240초)을 지정한다. 공공 웹사이트 로딩과 정적 fallback까지 고려한 값이다.
    
    [인코딩 처리]
    한국어 출력이 깨지지 않도록 PYTHONIOENCODING=utf-8 환경변수를 설정하고,
    stdout/stderr를 UTF-8로 디코딩
    """
    process = None
    try:
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"

        process = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            **process_group_options(),
        )
        try:
            stdout_bytes, stderr_bytes = process.communicate(timeout=timeout_seconds)
        except subprocess.TimeoutExpired as error:
            terminate_process_tree(process)
            try:
                stdout_bytes, stderr_bytes = process.communicate(
                    timeout=PROCESS_TERMINATION_WAIT_SECONDS,
                )
            except (subprocess.TimeoutExpired, ValueError):
                stdout_bytes = error.output or b""
                stderr_bytes = error.stderr or b""

            stdout = decode_process_output(stdout_bytes)
            stderr = decode_process_output(stderr_bytes)
            if stdout:
                print(stdout)
            if stderr:
                print(stderr)
            print(f"  [시간초과] {description} - {timeout_seconds}초 초과")
            return False

        stdout = decode_process_output(stdout_bytes)
        stderr = decode_process_output(stderr_bytes)

        if stdout:
            print(stdout)

        if stderr:
            print(stderr)

        if process.returncode != 0:
            print(f"  [실패] {description} (종료 코드: {process.returncode})")
            return False

        return True

    except FileNotFoundError as e:
        print(f"  [실행불가] {e}")
        return False
    except Exception as e:
        print(f"  [오류] {description}: {e}")
        return False


def load_json(filepath: Path) -> Optional[Dict]:
    """JSON 파일을 읽어서 딕셔너리로 반환. 파일이 없으면 None을 반환."""
    if not filepath.exists():
        print(f"  [경고] 파일 없음: {filepath.name}")
        return None

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as error:
        print(f"  [경고] JSON 읽기 실패 ({filepath.name}): {error}")
        return None


MAX_CAPTURE_URL_LENGTH = 2048
MAX_BACKEND_INTEGER = 2_147_483_647
CAPTURE_METADATA_FIELDS = (
    "requestedUrl",
    "finalUrl",
    "capturedAt",
    "viewportWidthCssPx",
    "viewportHeightCssPx",
    "deviceScaleFactor",
    "pageWidthCssPx",
    "pageHeightCssPx",
)
_INVALID_URI_CHARACTER = re.compile(r'[\x00-\x20\x7f<>"{}|\\^`]')
_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_DNS_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_LOCAL_DATE_TIME = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?"
)


def valid_uri_host(host: str) -> bool:
    """Approximate java.net.URI#getHost rather than urlparse's permissive host parsing."""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass

    try:
        ascii_host = host.encode("ascii").decode("ascii").rstrip(".")
    except UnicodeError:
        return False
    if not ascii_host or len(ascii_host) > 253:
        return False
    return all(
        _DNS_LABEL.fullmatch(label) is not None
        for label in ascii_host.split(".")
    )


def parse_backend_http_url(value: Any):
    """Return a parsed URL only when Spring's capture-metadata URI contract accepts it."""
    try:
        # Java String#length counts UTF-16 code units rather than Unicode code
        # points. Match the backend's 2048-character guard for astral text too.
        java_length = len(value.encode("utf-16-le")) // 2 if isinstance(value, str) else 0
    except UnicodeEncodeError:
        return None
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or java_length > MAX_CAPTURE_URL_LENGTH
        or _INVALID_URI_CHARACTER.search(value)
        or _INVALID_PERCENT_ESCAPE.search(value)
    ):
        return None
    try:
        parsed = urlparse(value)
        host = parsed.hostname
        # Accessing port makes urllib reject malformed/non-numeric ports too.
        parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.netloc
        or not host
        or not valid_uri_host(host)
    ):
        return None
    # java.net.URI accepts brackets only as the delimiters of an IPv6 host.
    # urllib is more permissive and otherwise accepts them in path/query/userinfo.
    bracket_sensitive_parts = (
        parsed.path,
        parsed.params,
        parsed.query,
        parsed.fragment,
        parsed.username or "",
        parsed.password or "",
    )
    if any("[" in part or "]" in part for part in bracket_sensitive_parts):
        return None
    return parsed


def normalized_host(value: str) -> str:
    parsed = parse_backend_http_url(value)
    if parsed is None:
        return ""
    host = (parsed.hostname or "").lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def get_rule_result_url(rule_result: Optional[Dict]) -> str:
    if not rule_result:
        return ""
    metadata = rule_result.get("metadata", {})
    if isinstance(metadata, dict):
        value = metadata.get("url")
        return value if isinstance(value, str) else ""
    return ""


def validate_target_navigation(requested_url: str, rule_result: Optional[Dict]) -> bool:
    analyzed_url = get_rule_result_url(rule_result)
    if not analyzed_url:
        print("  [blocked] 규칙 기반 결과에 분석 URL이 없습니다.")
        return False

    requested_host = normalized_host(requested_url)
    analyzed_host = normalized_host(analyzed_url)
    blocked_or_error = analyzed_url.startswith("chrome-error://") or "botmanager" in analyzed_host

    if blocked_or_error or not analyzed_host or requested_host != analyzed_host:
        print("  [blocked] requested page was not analyzed.")
        print(f"  requested_url={requested_url}")
        print(f"  analyzed_url={analyzed_url}")
        return False

    return True


def is_live_report_url(value: Any) -> bool:
    """Validate the structural part of LiveReportUrlSafetyValidator's policy.

    Public-address DNS validation remains authoritative in the backend because
    resolving here would neither pin the later connection nor prevent rebinding.
    """
    parsed = parse_backend_http_url(value)
    if parsed is None:
        return False
    try:
        return bool(
            parsed.scheme.lower() == "https"
            and parsed.username is None
            and parsed.password is None
            and "#" not in value
            and parsed.port in (None, 443)
        )
    except ValueError:
        return False


def canonical_navigation_url(value: Any):
    """Canonical form used for strict request/result URL comparisons."""
    parsed = parse_backend_http_url(value)
    if parsed is None:
        return None
    host = (parsed.hostname or "").lower()
    port = parsed.port
    if port is None:
        port = 443 if parsed.scheme.lower() == "https" else 80
    path = parsed.path or "/"
    if parsed.params:
        path = f"{path};{parsed.params}"
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    without_fragment = value.split("#", 1)[0]
    raw_fragment = value.split("#", 1)[1] if "#" in value else None
    raw_query = parsed.query if "?" in without_fragment else None
    raw_user_info = parsed.netloc.rsplit("@", 1)[0] if "@" in parsed.netloc else None
    return (
        parsed.scheme.lower(),
        host,
        port,
        path,
        raw_query,
        raw_user_info,
        raw_fragment,
    )


def canonical_navigation_observation(value: Any):
    """Canonical form for final browser URL versus analyzer observation.

    The live gateway deliberately drops fragments. Keep host, scheme, port,
    path, query, and user-info exact so this remains an origin-sensitive
    navigation identity check rather than a loose same-site comparison.
    """
    canonical = canonical_navigation_url(value)
    if canonical is None:
        return None
    scheme, host, port, path, query, user_info, _fragment = canonical
    return (scheme, host, port, path, query, user_info, None)


def valid_local_date_time(value: Any) -> bool:
    if not isinstance(value, str) or _LOCAL_DATE_TIME.fullmatch(value) is None:
        return False
    try:
        # datetime only supports microseconds, so validate the nanosecond-capable
        # fractional suffix with the regex and use the fixed portion for ranges.
        datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
        return True
    except ValueError:
        return False


def positive_integer(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 < value <= MAX_BACKEND_INTEGER
    )


def validate_capture_metadata(
        requested_url: str,
        capture_metadata: Any,
        analyzed_url: str,
) -> bool:
    """Validate metadata before embedding it in the evaluation ingestion JSON."""
    if not isinstance(capture_metadata, dict):
        return False

    metadata_requested_url = capture_metadata.get("requestedUrl")
    final_url = capture_metadata.get("finalUrl")
    captured_at = capture_metadata.get("capturedAt")

    viewport_width = capture_metadata.get("viewportWidthCssPx")
    viewport_height = capture_metadata.get("viewportHeightCssPx")
    page_width = capture_metadata.get("pageWidthCssPx")
    page_height = capture_metadata.get("pageHeightCssPx")
    dimensions = (viewport_width, viewport_height, page_width, page_height)
    device_scale_factor = capture_metadata.get("deviceScaleFactor")
    valid_device_scale_factor = (
        not isinstance(device_scale_factor, bool)
        and isinstance(device_scale_factor, (int, float))
        and math.isfinite(float(device_scale_factor))
        and 0.1 <= float(device_scale_factor) <= 10.0
    )

    return bool(
        parse_backend_http_url(metadata_requested_url) is not None
        and is_live_report_url(final_url)
        and canonical_navigation_url(metadata_requested_url)
        == canonical_navigation_url(requested_url)
        and canonical_navigation_observation(final_url)
        == canonical_navigation_observation(analyzed_url)
        and valid_local_date_time(captured_at)
        and all(positive_integer(value) for value in dimensions)
        and page_width >= viewport_width
        and page_height >= viewport_height
        and valid_device_scale_factor
    )


def capture_metadata_payload(capture_metadata: Any) -> Optional[Dict[str, Any]]:
    """Keep the ingestion contract independent of generator-only metadata."""
    if not isinstance(capture_metadata, dict):
        return None
    return {
        field: capture_metadata[field]
        for field in CAPTURE_METADATA_FIELDS
        if field in capture_metadata
    }


# ── 총점 계산 ────────────────────────────────────────────────────────────────


def finite_numeric_score(value: Any) -> Optional[float]:
    """Return a JSON numeric score only when it is real and finite."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    numeric_value = float(value)
    return numeric_value if math.isfinite(numeric_value) else None


def valid_rule_result(rule_result: Any) -> bool:
    """A rule result is scorable only when its documented score is valid."""
    if not isinstance(rule_result, dict):
        return False
    score_value = rule_result.get("score")
    if isinstance(score_value, dict):
        score_value = score_value.get("score")
    return finite_numeric_score(score_value) is not None


def valid_difficulty_result(result: Any) -> bool:
    if not isinstance(result, dict) or not isinstance(result.get("results"), list):
        return False
    meta = result.get("meta")
    return (
        isinstance(meta, dict)
        and finite_numeric_score(meta.get("page_score")) is not None
    )


def valid_suggestion_result(result: Any) -> bool:
    if not valid_difficulty_result(result):
        return False
    return isinstance(result["meta"].get("suggestion_stats"), dict)


def valid_cv_result(result: Any) -> bool:
    if not isinstance(result, dict) or not isinstance(result.get("violations"), list):
        return False
    summary = result.get("summary")
    return (
        isinstance(summary, dict)
        and finite_numeric_score(summary.get("pass_rate")) is not None
    )


def calculate_total_score(rule_score: Optional[Dict],
                          difficulty_score: Optional[Dict],
                          cv_score: Optional[Dict]) -> Dict[str, Any]:
    """
    3개 모듈의 개별 점수를 가중 합산하여 총점과 등급을 계산
    
    [총점 공식]
    총점 = (규칙 기반 점수 × 50%) + (난이도 page_score × 30%) + (CV 통과율 × 20%)
    
    [각 모듈 점수의 의미]
    - 규칙 기반: scorer.js가 계산한 100점 감점 방식 점수 (높을수록 좋음)
    - 난이도: difficulty_engine.py의 meta.page_score
             (이미 100 - 감점 방식으로 계산됨, 높을수록 좋음 → 반전 불필요)
    - CV: contrast_analyzer.py의 pass_rate (명암비 통과율 %, 높을수록 좋음)
    
    [모듈 부분 실패 시 가중치 재분배]
    특정 모듈이 실패하면 해당 모듈의 가중치를 제외하고,
    나머지 모듈의 가중치를 합이 100%가 되도록 재분배함.
    예: CV 실패 → 규칙 기반 50/(50+30)=62.5%, 난이도 30/(50+30)=37.5%
    단, 완료 결과 전송에는 현재 실행의 유효한 규칙 기반 결과가 반드시 필요함.
    """
    scores = {}
    weights = {}

    # 규칙 기반 점수 추출
    if isinstance(rule_score, dict):
        score_val = rule_score.get("score", {})
        if isinstance(score_val, dict):
            score_val = score_val.get("score")
        numeric_score = finite_numeric_score(score_val)
        if numeric_score is not None:
            scores["rule_based"] = numeric_score
            weights["rule_based"] = WEIGHT_RULE_BASED

    # 난이도 점수 추출
    # page_score는 difficulty_engine.py에서 이미 "100 - 감점"으로 계산됨
    # (높을수록 좋음) → 반전 없이 그대로 사용
    if isinstance(difficulty_score, dict):
        meta = difficulty_score.get("meta", {})
        page_score = meta.get("page_score") if isinstance(meta, dict) else None
        numeric_score = finite_numeric_score(page_score)
        if numeric_score is not None:
            scores["difficulty"] = numeric_score
            weights["difficulty"] = WEIGHT_DIFFICULTY

    # CV 점수 추출 — 명암비 통과율(%)을 그대로 사용
    if isinstance(cv_score, dict):
        summary = cv_score.get("summary", {})
        pass_rate = summary.get("pass_rate") if isinstance(summary, dict) else None
        numeric_score = finite_numeric_score(pass_rate)
        if numeric_score is not None:
            scores["cv"] = numeric_score
            weights["cv"] = WEIGHT_CV

    # 모든 모듈이 실패한 경우
    total_weight = sum(weights.values())
    if total_weight == 0:
        return {
            "total_score": 0,
            "grade": "F",
            "module_scores": {},
            "weights_applied": {},
        }

    # 가중 합산 — 실패한 모듈을 제외하고 나머지 가중치를 재분배함
    weighted_sum = 0
    weights_applied = {}
    for module, score in scores.items():
        normalized_weight = weights[module] / total_weight  # 재분배된 가중치
        weighted_sum += score * normalized_weight
        weights_applied[module] = round(normalized_weight * 100, 1)

    total_score = round(weighted_sum, 1)

    # 등급 판정
    if total_score >= 95:
        grade = "A+"
    elif total_score >= 90:
        grade = "A"
    elif total_score >= 85:
        grade = "B+"
    elif total_score >= 80:
        grade = "B"
    elif total_score >= 70:
        grade = "C"
    elif total_score >= 60:
        grade = "D"
    else:
        grade = "F"

    return {
        "total_score": total_score,
        "grade": grade,
        "module_scores": {k: round(v, 1) for k, v in scores.items()},
        "weights_applied": weights_applied,
    }


# ── 통합 결과 JSON 생성 ─────────────────────────────────────────────────────


def build_final_result(url, rule_result, difficulty_result,
                       suggestion_result, cv_result, capture_metadata,
                       total_score, elapsed, request_id=None):
    """
    모든 모듈의 결과 + 총점을 하나의 JSON으로 합침.
    이 JSON(result_final.json)이 백엔드가 받아서 DB에 저장하는 최종 결과물임
    
    [구조]
    - 상단: URL, 총점, 등급, 소요 시간 등 요약 정보
    - score_breakdown: 모듈별 점수 + 적용된 가중치
    - capture_metadata: 라이브 화면 정렬에 필요한 분석 당시 화면 정보
    - modules: 각 모듈의 상세 결과 전체 (위반 항목, 수정 가이드 등)
    
    프론트엔드 대시보드는 이 JSON 하나로
    총점/등급, 모듈별 점수, 위반 항목 목록, 수정 가이드를 모두 렌더링
    """
    return {
        "url": url,
        "analyzed_at": datetime.now().isoformat(),
        "elapsed_seconds": elapsed,
        "platform_version": "1.0.0",
        "request_id": request_id,
        "capture_metadata": capture_metadata_payload(capture_metadata),

        "total_score": total_score["total_score"],
        "grade": total_score["grade"],
        "score_breakdown": {
            "module_scores": total_score["module_scores"],
            "weights_applied": total_score["weights_applied"],
        },

        # 각 모듈의 상세 결과를 그대로 포함함.
        # 모듈이 실패한 경우 status: "failed" 객체로 대체됨.
        "modules": {
            "rule_based": rule_result or {
                "status": "failed", "message": "규칙 기반 평가 실패"
            },
            "text_difficulty": difficulty_result if valid_difficulty_result(difficulty_result) else {
                "status": "failed", "message": "난이도 분석 실패"
            },
            "text_suggestions": suggestion_result if valid_suggestion_result(suggestion_result) else {
                "status": "failed", "message": "수정 제안 생성 실패"
            },
            "cv_visual": cv_result if valid_cv_result(cv_result) else {
                "status": "failed", "message": "CV 분석 실패"
            },
        },
    }


# ── 백엔드 전송 ──────────────────────────────────────────────────────────────


def send_to_backend(final_result: Dict) -> bool:
    """
    result_final.json을 백엔드 서버에 HTTP POST로 전송함.
    
    백엔드 서버가 꺼져 있거나 연결할 수 없는 경우에도
    로컬 JSON 파일(result_final.json)은 이미 저장되어 있으므로
    나중에 수동으로 전송하거나 파일을 직접 확인할 수 있음.
    
    [엔드포인트]
    POST http://localhost:8080/api/v1/evaluations
    Body: result_final.json 전체
    """
    import urllib.request
    import urllib.error

    url = f"{API_BASE_URL}/evaluations"

    try:
        data = json.dumps(final_result, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(
            url, data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=10) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            if response.status in (200, 201):
                try:
                    response_json = json.loads(response_body) if response_body else {}
                    if isinstance(response_json, dict) and response_json.get("success") is False:
                        print(f"  백엔드 전송 실패: {response_json.get('message')}")
                        return False
                except json.JSONDecodeError:
                    pass
                print(f"  백엔드 전송 성공 (HTTP {response.status})")
                return True
            else:
                print(f"  백엔드 전송 실패 (HTTP {response.status})")
                return False

    except urllib.error.HTTPError as error:
        try:
            response_body = error.read().decode("utf-8", errors="replace").strip()
        except Exception:
            response_body = ""
        print(f"  백엔드 전송 실패 (HTTP {error.code})")
        if response_body:
            try:
                response_json = json.loads(response_body)
                detail = (
                    response_json.get("message")
                    if isinstance(response_json, dict)
                    else response_body
                )
            except json.JSONDecodeError:
                detail = response_body
            print(f"  -> 응답: {str(detail)[:500]}")
        return False
    except urllib.error.URLError as error:
        print(f"  백엔드 서버 연결 불가 ({API_BASE_URL}): {error.reason}")
        print(f"  -> 로컬 JSON 파일로만 저장됩니다.")
        return False
    except Exception as e:
        print(f"  백엔드 전송 오류: {e}")
        print(f"  -> 로컬 JSON 파일로만 저장됩니다.")
        return False


def run_cv_from_ephemeral_capture(capture_path: Path) -> bool:
    """Run the existing CV analyzer, then always delete its private PNG input."""
    try:
        if not capture_path.exists() or capture_path.stat().st_size == 0:
            print("  [건너뜀] CV 전용 임시 이미지가 생성되지 않았습니다.")
            return False

        command = [
            sys.executable,
            str(CV_ANALYZER_DIR / "cv_runner.py"),
            str(capture_path),
        ]
        configured_credentials = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
        if configured_credentials:
            command.extend(["--credentials", configured_credentials])
        elif VISION_CREDENTIALS.is_file():
            command.extend(["--credentials", str(VISION_CREDENTIALS)])
        command.extend(["--output", str(OUTPUT_DIR / "result_cv.json")])

        return run_command(
            command,
            cwd=str(OUTPUT_DIR),
            description="CV 분석",
        )
    finally:
        cleanup_ephemeral_cv_capture(capture_path)


# ── 메인 실행 ────────────────────────────────────────────────────────────────


def main():
    """
    전체 파이프라인을 순서대로 실행하는 메인 함수.
    
    [실행 순서와 의존 관계]
    Step 1 (규칙 기반) → result.json, result.html, result_artifact.json 생성
    Step 2 (텍스트 추출) → Step 1의 result.html을 입력으로 사용
    Step 3 (난이도 분석) → Step 2의 result_text.json을 입력으로 사용
    Step 4 (수정 제안)  → Step 3의 result_text_difficulty.json을 입력으로 사용
    Step 5 (CV 분석)   → Step 1의 전용 임시 PNG를 입력으로 사용 후 즉시 삭제
    Step 6 (통합)      → 위 모든 결과 파일을 읽어서 총점 계산
    Step 7 (전송)      → Step 6의 result_final.json을 백엔드로 POST
    
    각 Step은 이전 Step이 성공하고 현재 실행의 출력 파일이 생성됐는지 확인한다.
    규칙 기반 Step이 실패하면 모든 후속 분석과 백엔드 전송을 중단한다.
    
    [결과 파일 로딩 시 step 성공 여부 반영]
    각 모듈의 JSON 결과를 로딩할 때 해당 step의 성공 여부를 확인함.
    step이 실패했으면 이전 실행에서 남아있는 결과 파일을 읽지 않고
    None으로 처리하여, 실패한 모듈의 가중치가 재분배됨.
    """
    if len(sys.argv) < 2:
        print("사용법: python run_all.py <URL>")
        print("예시:   python run_all.py https://www.gov.kr")
        sys.exit(1)

    url = sys.argv[1]
    request_id = None
    if len(sys.argv) >= 3:
        try:
            request_id = int(sys.argv[2])
        except ValueError:
            print(f"Invalid request_id ignored: {sys.argv[2]}")
    start_time = time.time()

    print("=" * 60)
    print("  공공 디지털 서비스 접근성 통합 평가")
    print("=" * 60)
    print(f"  대상 URL: {url}")
    print(f"  시작 시간: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  가중치: 규칙 {int(WEIGHT_RULE_BASED*100)}% / "
          f"난이도 {int(WEIGHT_DIFFICULTY*100)}% / "
          f"CV {int(WEIGHT_CV*100)}%")
    print("=" * 60)

    if not clear_previous_outputs():
        print("  [분석 실패] 이전 실행 결과를 안전하게 정리하지 못했습니다.")
        sys.exit(NO_SCORABLE_RESULT_EXIT_CODE)

    # The screenshot is private input for the existing CV analyzer. It is
    # deliberately outside output/ and is never part of the ingestion
    # contract. Step 5 deletes it in finally; atexit is a backstop for an
    # unexpected exception or early sys.exit before Step 5.
    cv_capture_path = create_ephemeral_cv_capture_path()
    atexit.register(cleanup_ephemeral_cv_capture, cv_capture_path)

    total_steps = 7

    # ── Step 1: 규칙 기반 평가 ──
    # run.js를 실행하여 Playwright로 페이지를 열고 axe-core 검사를 수행함.
    # 결과: result.json(axe-core 결과), result.html(내부 텍스트 분석 입력),
    #       result_artifact.json(라이브 화면 정렬용 캡처 메타데이터)
    run_step(1, total_steps, "규칙 기반 접근성 평가 (axe-core + KWCAG)")

    result_json = OUTPUT_DIR / "result.json"
    result_api = OUTPUT_DIR / "result_api.json"
    result_html = OUTPUT_DIR / "result.html"
    result_artifact = OUTPUT_DIR / "result_artifact.json"
    rule_output_paths = (result_json, result_api, result_html, result_artifact)
    step1_started_ns = time.time_ns()
    step1_process_ok = run_command(
        ["node", "run.js", url, str(result_json),
         "--cv-screenshot", str(cv_capture_path)],
        cwd=str(RULE_BASED_DIR),
        description="규칙 기반 평가",
        timeout_seconds=RULE_BASED_STEP_TIMEOUT_SECONDS,
    )

    step1_outputs_fresh = step1_process_ok and all(
        is_fresh_nonempty_file(path, step1_started_ns)
        for path in rule_output_paths
    )
    rule_result = load_json(result_api) if step1_outputs_fresh else None
    capture_metadata = load_json(result_artifact) if step1_outputs_fresh else None
    rule_result_valid = valid_rule_result(rule_result)
    analyzed_url = get_rule_result_url(rule_result)
    capture_metadata_valid = validate_capture_metadata(
        url,
        capture_metadata,
        analyzed_url,
    )
    navigation_valid = (
        validate_target_navigation(url, rule_result)
        if rule_result_valid
        else False
    )
    step1_ok = bool(
        step1_process_ok
        and step1_outputs_fresh
        and rule_result_valid
        and capture_metadata_valid
        and navigation_valid
    )
    rule_output_fingerprints = {
        path: output_fingerprint(path)
        for path in rule_output_paths
    } if step1_ok else {}

    if not step1_process_ok:
        print("  [분석 실패] 규칙 기반 평가 프로세스가 완료되지 않았습니다.")
    elif not step1_outputs_fresh:
        print("  [분석 실패] 현재 실행의 규칙 결과 또는 캡처 메타데이터가 완전하지 않습니다.")
    elif not rule_result_valid:
        print("  [분석 실패] 규칙 기반 결과에 유효한 점수가 없습니다.")
    elif not capture_metadata_valid:
        print("  [분석 실패] 현재 요청의 캡처 메타데이터가 유효하지 않습니다.")
    elif not navigation_valid:
        sys.exit(2)

    # ── Step 2: 텍스트 추출 ──
    # Step 1에서 저장한 result.html을 입력으로 받아서
    # 분석 대상 텍스트를 추출하고 10개 카테고리로 분류함.
    run_step(2, total_steps, "텍스트 추출 전처리")

    if step1_ok:
        step2_started_ns = time.time_ns()
        step2_process_ok = run_command(
            [sys.executable, str(TEXT_LEVEL_DIR / "text_extractor.py"),
             str(result_html)],
            cwd=str(OUTPUT_DIR),
            description="텍스트 추출",
        )
        step2_ok = step2_process_ok and is_fresh_nonempty_file(
            OUTPUT_DIR / "result_text.json",
            step2_started_ns,
        )
    else:
        print("  [건너뜀] 유효한 현재 규칙 결과가 없어 텍스트 추출을 실행하지 않습니다.")
        step2_ok = False

    # ── Step 3: 난이도 분석 ──
    # Step 2에서 생성한 result_text.json을 입력으로 받아서
    # MeCab 형태소 분석 → 난이도 점수 산출 (문장 길이, 어절 길이, 고난이도 어휘 비율)
    run_step(3, total_steps, "한국어 인지 난이도 분석")

    result_text = OUTPUT_DIR / "result_text.json"
    if step2_ok:
        step3_started_ns = time.time_ns()
        step3_process_ok = run_command(
            [sys.executable, str(TEXT_LEVEL_DIR / "difficulty_engine.py"),
             str(result_text)],
            cwd=str(OUTPUT_DIR),
            description="난이도 분석",
        )
        step3_ok = step3_process_ok and is_fresh_nonempty_file(
            OUTPUT_DIR / "result_text_difficulty.json",
            step3_started_ns,
        )
        if step3_ok and not valid_difficulty_result(
            load_json(OUTPUT_DIR / "result_text_difficulty.json")
        ):
            print("  [분석 실패] 난이도 분석 결과 구조가 유효하지 않습니다.")
            step3_ok = False
    else:
        print("  [건너뜀] 현재 실행의 텍스트 추출 결과가 없습니다.")
        step3_ok = False

    # ── Step 4: LLM 수정 제안 ──
    # Step 3에서 난이도가 높다고 판정된 문장에 대해
    # GPT-4o-mini에게 쉬운 표현으로의 수정안을 생성하도록 요청함.
    # (GPT는 측정이 아닌 수정 제안 생성에만 사용 — 측정은 자체 엔진이 담당)
    run_step(4, total_steps, "LLM 수정 제안 생성")

    result_difficulty = OUTPUT_DIR / "result_text_difficulty.json"
    if step3_ok:
        step4_started_ns = time.time_ns()
        step4_process_ok = run_command(
            [sys.executable, str(TEXT_LEVEL_DIR / "suggestion_generator.py"),
             str(result_difficulty)],
            cwd=str(OUTPUT_DIR),
            description="수정 제안 생성",
        )
        step4_ok = step4_process_ok and is_fresh_nonempty_file(
            OUTPUT_DIR / "result_text_suggestions.json",
            step4_started_ns,
        )
        if step4_ok and not valid_suggestion_result(
            load_json(OUTPUT_DIR / "result_text_suggestions.json")
        ):
            print("  [분석 실패] 수정 제안 결과 구조가 유효하지 않습니다.")
            step4_ok = False
    else:
        print("  [건너뜀] 현재 실행의 난이도 분석 결과가 없습니다.")
        step4_ok = False

    # ── Step 5: CV 시각 분석 ──
    # result.html과 CV 입력은 서로 독립적이다. Step 1이 OS 임시
    # 디렉터리에만 만든 PNG를 기존 CV 분석기에 전달하고, 성공/실패와 무관하게
    # run_cv_from_ephemeral_capture()의 finally에서 즉시 삭제한다.
    run_step(5, total_steps, "CV 시각 접근성 분석")
    if step1_ok:
        step5_started_ns = time.time_ns()
        step5_process_ok = run_cv_from_ephemeral_capture(cv_capture_path)
        step5_ok = step5_process_ok and is_fresh_nonempty_file(
            OUTPUT_DIR / "result_cv.json",
            step5_started_ns,
        )
        if step5_ok and not valid_cv_result(load_json(OUTPUT_DIR / "result_cv.json")):
            print("  [분석 실패] CV 분석 결과 구조가 유효하지 않습니다.")
            step5_ok = False
    else:
        print("  [건너뜀] 유효한 현재 규칙 결과가 없어 CV 분석을 실행하지 않습니다.")
        cleanup_ephemeral_cv_capture(cv_capture_path)
        step5_ok = False

    # ── Step 6: 결과 통합 + 총점 계산 ──
    # 각 모듈이 생성한 JSON 파일을 읽어서 총점을 계산하고,
    # 모든 결과를 하나의 result_final.json으로 합침.
    # 각 step의 성공 여부를 확인하여, 실패한 모듈의 이전 결과 파일이
    # 남아있더라도 읽지 않음 (이전 실행 결과가 현재 결과에 혼입되는 것을 방지)
    run_step(6, total_steps, "결과 통합 및 총점 계산")

    difficulty_result = load_json(OUTPUT_DIR / "result_text_difficulty.json") if step3_ok else None
    suggestion_result = load_json(OUTPUT_DIR / "result_text_suggestions.json") if step4_ok else None
    cv_result = load_json(OUTPUT_DIR / "result_cv.json") if step5_ok else None

    total_score = calculate_total_score(rule_result, difficulty_result, cv_result)

    elapsed = round(time.time() - start_time, 2)

    final_result = build_final_result(
        url=url,
        rule_result=rule_result,
        difficulty_result=difficulty_result,
        suggestion_result=suggestion_result,
        cv_result=cv_result,
        capture_metadata=capture_metadata if step1_ok else None,
        total_score=total_score,
        elapsed=elapsed,
        request_id=request_id,
    )

    # 최종 통합 결과를 JSON 파일로 저장함
    final_path = OUTPUT_DIR / "result_final.json"
    with open(final_path, 'w', encoding='utf-8') as f:
        json.dump(final_result, f, ensure_ascii=False, indent=2)

    print(f"  통합 결과 저장: {final_path}")

    # A zero score can be a valid finding, so do not decide from total_score.
    # module_scores is empty only when none of rule/difficulty/CV produced a
    # score-bearing result. Preserve result_final.json for local diagnosis, but
    # never ingest it as a completed evaluation.
    rule_outputs_unchanged = step1_ok and all(
        output_fingerprint(path) == fingerprint
        for path, fingerprint in rule_output_fingerprints.items()
    )
    if (
        not step1_ok
        or not rule_outputs_unchanged
        or "rule_based" not in total_score["module_scores"]
    ):
        print("  [분석 실패] 현재 실행의 유효한 규칙 기반 결과가 없습니다.")
        print("  진단용 결과만 저장하고 백엔드 전송은 건너뜁니다.")
        sys.exit(NO_SCORABLE_RESULT_EXIT_CODE)

    # ── Step 7: 백엔드 전송 ──
    # 백엔드 서버가 실행 중이면 result_final.json을 POST로 전송함.
    # 서버가 꺼져 있어도 로컬 파일은 이미 저장되어 있으므로 문제없음.
    run_step(7, total_steps, "백엔드 서버 전송")

    ingestion_ok = send_to_backend(final_result)
    if not ingestion_ok:
        sys.exit(1)

    # ── 최종 요약 출력 ──
    print("\n" + "=" * 60)
    print("  평가 완료")
    print("=" * 60)
    print(f"  URL: {url}")
    print(f"  소요 시간: {elapsed}초")
    print()

    print(f"  ★ 총점: {total_score['total_score']}점 / 100점"
          f" (등급: {total_score['grade']})")
    print()

    module_names = {
        "rule_based": "규칙 기반",
        "difficulty": "난이도",
        "cv": "CV 시각 분석",
    }
    for module, score in total_score["module_scores"].items():
        weight = total_score["weights_applied"].get(module, 0)
        name = module_names.get(module, module)
        print(f"    {name}: {score}점 (가중치 {weight}%)")

    print()

    # 각 Step의 성공/실패 상태를 요약 출력함
    steps = [
        (step1_ok, "규칙 기반 평가"),
        (step2_ok, "텍스트 추출"),
        (step3_ok, "난이도 분석"),
        (step4_ok, "수정 제안 생성"),
        (step5_ok, "CV 시각 분석"),
    ]

    for ok, name in steps:
        status = "OK" if ok else "FAIL"
        print(f"    [{status}] {name}")

    print()
    print(f"  결과 폴더: {OUTPUT_DIR}")
    print("=" * 60)


if __name__ == "__main__":
    main()
