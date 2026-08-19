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
  Step 7: result_final.json 저장 성공 후 request-scoped DOM replay를 multipart 전송

[총점 계산 공식]
  총점 = (규칙 기반 점수 × 50%) + (난이도 page_score × 30%) + (CV 통과율 × 20%)
  
  난이도의 page_score는 difficulty_engine.py에서 이미
  "100 - 감점" 방식으로 계산된 값이므로 (높을수록 좋음),
  별도의 반전 없이 그대로 사용함.

[등급 기준]
  A+(95↑), A(90↑), B+(85↑), B(80↑), C(70↑), D(60↑), F(60 미만)

[모듈 부분 실패 처리]
  특정 모듈이 실패해도 나머지 모듈 결과는 정상적으로 반영
  실패한 모듈은 가중치 재분배 후 나머지 모듈만으로 총점을 계산
  예: CV 모듈만 실패 → 규칙 기반(50/80=62.5%)과 난이도(30/80=37.5%)로 재계산

[실행 방법]
  python run_all.py <URL>
  예: python run_all.py https://www.gov.kr

[출력]
  output/ 폴더에 모든 결과 파일이 저장됨:
    result.json                 ← axe-core 원본 + KWCAG 매핑 결과
    result_api.json             ← 규칙 기반 결과 (API 스펙 형태)
    result.html                 ← 정적 DOM replay (텍스트 추출 + 대시보드 렌더 입력)
    result_artifact.json        ← 뷰포트/문서 크기/DOM_REPLAY 메타데이터
    result_text.json            ← 추출된 텍스트 블록 (카테고리별 분류)
    result_text_difficulty.json ← 블록별 난이도 점수
    result_text_suggestions.json ← 블록별 수정 제안
    result_cv.json              ← 임시 PNG를 분석한 CV 결과(입력 경로 미포함)
    ★result_final.json          ← 최종 통합 결과 (백엔드가 받는 파일)
"""

import json
import sys
import os
import atexit
import subprocess
import tempfile
import time
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional, Tuple
from urllib.parse import urlparse
import uuid


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


def clear_previous_outputs():
    """Remove stale per-run outputs so failed steps cannot reuse old results."""
    for filename in RUN_OUTPUT_FILES + LEGACY_OUTPUT_FILES:
        path = OUTPUT_DIR / filename
        try:
            if path.exists():
                path.unlink()
        except OSError as e:
            print(f"  [warning] could not remove stale output {filename}: {e}")


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

# Google Vision API 서비스 계정 키 경로
# .gitignore에 포함되어 있으므로 각 개발자가 로컬에 설정해야 함
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


# ── Step 실행 함수들 ─────────────────────────────────────────────────────────


def run_step(step_num: int, total: int, description: str):
    """각 Step의 시작을 콘솔에 출력하는 헬퍼 함수."""
    print(f"\n[Step {step_num}/{total}] {description}")
    print("-" * 50)


def run_command(cmd: list, cwd: str = None, description: str = "") -> bool:
    """
    외부 명령어(Node.js, Python 스크립트 등)를 subprocess로 실행
    
    [반환값]
    True: 정상 종료 (종료 코드 0)
    False: 실패 (비정상 종료, 타임아웃, 파일 없음 등)
    
    [타임아웃]
    각 Step은 최대 2분(120초)까지 대기함.
    공공 웹사이트 중 로딩이 느린 경우가 있어 여유 있게 설정
    
    [인코딩 처리]
    한국어 출력이 깨지지 않도록 PYTHONIOENCODING=utf-8 환경변수를 설정하고,
    stdout/stderr를 UTF-8로 디코딩
    """
    try:
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"

        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=False,
            timeout=120,
            env=env,
        )

        stdout = result.stdout.decode('utf-8', errors='replace').strip()
        stderr = result.stderr.decode('utf-8', errors='replace').strip()

        if stdout:
            print(stdout)

        if stderr:
            print(stderr)

        if result.returncode != 0:
            print(f"  [실패] {description} (종료 코드: {result.returncode})")
            return False

        return True

    except subprocess.TimeoutExpired:
        print(f"  [시간초과] {description} - 2분 초과")
        return False
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

    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)


def normalized_host(value: str) -> str:
    host = (urlparse(value).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def get_rule_result_url(rule_result: Optional[Dict]) -> str:
    if not rule_result:
        return ""
    metadata = rule_result.get("metadata", {})
    if isinstance(metadata, dict):
        return str(metadata.get("url") or "")
    return ""


def validate_target_navigation(requested_url: str, rule_result: Optional[Dict]) -> bool:
    analyzed_url = get_rule_result_url(rule_result)
    if not analyzed_url:
        return True

    requested_host = normalized_host(requested_url)
    analyzed_host = normalized_host(analyzed_url)
    blocked_or_error = analyzed_url.startswith("chrome-error://") or "botmanager" in analyzed_host

    if blocked_or_error or not analyzed_host or requested_host != analyzed_host:
        print("  [blocked] requested page was not analyzed.")
        print(f"  requested_url={requested_url}")
        print(f"  analyzed_url={analyzed_url}")
        return False

    return True


# ── 총점 계산 ────────────────────────────────────────────────────────────────


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
    이렇게 하면 한 모듈이 실패해도 나머지만으로 의미 있는 총점을 계산할 수 있음.
    """
    scores = {}
    weights = {}

    # 규칙 기반 점수 추출
    if rule_score:
        score_val = rule_score.get("score", {})
        if isinstance(score_val, dict):
            scores["rule_based"] = score_val.get("score", 0)
        else:
            scores["rule_based"] = score_val
        weights["rule_based"] = WEIGHT_RULE_BASED

    # 난이도 점수 추출
    # page_score는 difficulty_engine.py에서 이미 "100 - 감점"으로 계산됨
    # (높을수록 좋음) → 반전 없이 그대로 사용
    if difficulty_score:
        scores["difficulty"] = difficulty_score.get("meta", {}).get("page_score", 0)
        weights["difficulty"] = WEIGHT_DIFFICULTY

    # CV 점수 추출 — 명암비 통과율(%)을 그대로 사용
    if cv_score:
        summary = cv_score.get("summary", {})
        scores["cv"] = summary.get("pass_rate", 0)
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
                       suggestion_result, cv_result, total_score, elapsed, request_id=None):
    """
    모든 모듈의 결과 + 총점을 하나의 JSON으로 합침.
    이 JSON(result_final.json)이 백엔드가 받아서 DB에 저장하는 최종 결과물임
    
    [구조]
    - 상단: URL, 총점, 등급, 소요 시간 등 요약 정보
    - score_breakdown: 모듈별 점수 + 적용된 가중치
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
            "text_difficulty": difficulty_result or {
                "status": "failed", "message": "난이도 분석 실패"
            },
            "text_suggestions": suggestion_result or {
                "status": "failed", "message": "수정 제안 생성 실패"
            },
            "cv_visual": cv_result or {
                "status": "failed", "message": "CV 분석 실패"
            },
        },
    }


# ── 백엔드 전송 ──────────────────────────────────────────────────────────────


def extract_evaluation_request_id(response_body: str,
                                  fallback_request_id: Optional[int] = None) -> Optional[int]:
    """Read the saved request ID from direct or ApiResponse-wrapped JSON."""
    try:
        response_json = json.loads(response_body) if response_body else {}
    except json.JSONDecodeError:
        return fallback_request_id

    candidates = [response_json]
    if isinstance(response_json, dict) and isinstance(response_json.get("data"), dict):
        candidates.insert(0, response_json["data"])

    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        value = candidate.get("evaluation_request_id")
        if value is None:
            value = candidate.get("requestId")
        try:
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            continue
    return fallback_request_id


def send_to_backend(final_result: Dict) -> Tuple[bool, Optional[int]]:
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
                        return False, None
                except json.JSONDecodeError:
                    pass
                print(f"  백엔드 전송 성공 (HTTP {response.status})")
                request_id = extract_evaluation_request_id(
                    response_body,
                    final_result.get("request_id"),
                )
                return True, request_id
            else:
                print(f"  백엔드 전송 실패 (HTTP {response.status})")
                return False, None

    except urllib.error.URLError:
        print(f"  백엔드 서버 연결 불가 ({API_BASE_URL})")
        print(f"  -> 로컬 JSON 파일로만 저장됩니다.")
        return False, None
    except Exception as e:
        print(f"  백엔드 전송 오류: {e}")
        print(f"  -> 로컬 JSON 파일로만 저장됩니다.")
        return False, None


def build_artifact_multipart(metadata: Dict[str, Any], document: bytes,
                             boundary: str) -> bytes:
    """Build metadata + UTF-8 HTML using the exact Spring multipart contract."""
    metadata_bytes = json.dumps(metadata, ensure_ascii=False).encode("utf-8")
    boundary_bytes = boundary.encode("ascii")
    parts = [
        b"--" + boundary_bytes + b"\r\n"
        b'Content-Disposition: form-data; name="metadata"\r\n'
        b"Content-Type: application/json\r\n\r\n"
        + metadata_bytes + b"\r\n",
        b"--" + boundary_bytes + b"\r\n"
        b'Content-Disposition: form-data; name="document"; filename="page.html"\r\n'
        b"Content-Type: text/html; charset=utf-8\r\n\r\n"
        + document + b"\r\n",
        b"--" + boundary_bytes + b"--\r\n",
    ]
    return b"".join(parts)


def upload_artifact(request_id: int, metadata_path: Path, document_path: Path) -> bool:
    """
    Upload the render artifact after evaluation JSON ingestion succeeds.

    Failure is intentionally isolated: the score/issues already committed by
    the ingestion endpoint remain valid even if this optional evidence upload
    is unavailable. The caller logs the failure but still exits successfully.
    """
    import urllib.error
    import urllib.request

    if not metadata_path.exists() or not document_path.exists():
        print("  [artifact] 업로드 건너뜀: metadata 또는 DOM replay HTML이 없습니다.")
        return False

    try:
        with metadata_path.open("r", encoding="utf-8") as metadata_file:
            metadata = json.load(metadata_file)
        document = document_path.read_text(encoding="utf-8").encode("utf-8")
        if not document.strip():
            print("  [artifact] 업로드 건너뜀: DOM replay HTML이 비어 있습니다.")
            return False
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f"  [artifact] 로컬 파일 읽기 실패: {error}")
        return False

    boundary = f"----AccessibilityArtifact{uuid.uuid4().hex}"
    body = build_artifact_multipart(metadata, document, boundary)
    url = f"{API_BASE_URL}/evaluations/{request_id}/artifact"
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            if response.status not in (200, 201):
                print(f"  [artifact] 업로드 실패 (HTTP {response.status})")
                return False
            try:
                api_response = json.loads(response_body) if response_body else {}
                if isinstance(api_response, dict) and api_response.get("success") is False:
                    print(f"  [artifact] 서버가 업로드를 거부했습니다: {api_response.get('message')}")
                    return False
            except json.JSONDecodeError:
                pass
            print(f"  [artifact] DOM replay HTML 업로드 성공 (HTTP {response.status})")
            return True
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"  [artifact] 업로드 실패 (HTTP {error.code}): {detail[:300]}")
        return False
    except urllib.error.URLError as error:
        print(f"  [artifact] 백엔드 연결 실패: {error.reason}")
        return False
    except Exception as error:
        print(f"  [artifact] 업로드 오류: {error}")
        return False


def run_cv_from_ephemeral_capture(capture_path: Path) -> bool:
    """Run the existing CV analyzer, then always delete its private PNG input."""
    try:
        if not capture_path.exists() or capture_path.stat().st_size == 0:
            print("  [건너뜀] CV 전용 임시 이미지가 생성되지 않았습니다.")
            return False
        return run_command(
            ["python", str(CV_ANALYZER_DIR / "cv_runner.py"),
             str(capture_path),
             "--credentials", str(VISION_CREDENTIALS),
             "--output", str(OUTPUT_DIR / "result_cv.json")],
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
    
    각 Step은 이전 Step의 출력 파일이 존재하는지 확인하고,
    없으면 해당 Step을 건너뜀 (부분 실패 허용).
    
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

    clear_previous_outputs()

    # The screenshot is private input for the existing CV analyzer. It is
    # deliberately outside output/ and is never part of the replay/upload
    # contract. Step 5 deletes it in finally; atexit is a backstop for an
    # unexpected exception or early sys.exit before Step 5.
    cv_capture_path = create_ephemeral_cv_capture_path()
    atexit.register(cleanup_ephemeral_cv_capture, cv_capture_path)

    total_steps = 7

    # ── Step 1: 규칙 기반 평가 ──
    # run.js를 실행하여 Playwright로 페이지를 열고 axe-core 검사를 수행함.
    # 결과: result.json(axe-core 결과), result.html(정적 DOM replay),
    #       result_artifact.json(DOM replay 메타데이터)
    run_step(1, total_steps, "규칙 기반 접근성 평가 (axe-core + KWCAG)")

    result_json_path = str(OUTPUT_DIR / "result.json")
    step1_ok = run_command(
        ["node", "run.js", url, result_json_path,
         "--cv-screenshot", str(cv_capture_path)],
        cwd=str(RULE_BASED_DIR),
        description="규칙 기반 평가",
    )

    # ── Step 2: 텍스트 추출 ──
    # Step 1에서 저장한 result.html을 입력으로 받아서
    # 분석 대상 텍스트를 추출하고 10개 카테고리로 분류함.
    run_step(2, total_steps, "텍스트 추출 전처리")

    result_html = OUTPUT_DIR / "result.html"
    if result_html.exists():
        step2_ok = run_command(
            ["python", str(TEXT_LEVEL_DIR / "text_extractor.py"),
             str(result_html)],
            cwd=str(OUTPUT_DIR),
            description="텍스트 추출",
        )
    else:
        print("  [건너뜀] result.html 파일이 없습니다.")
        step2_ok = False

    # ── Step 3: 난이도 분석 ──
    # Step 2에서 생성한 result_text.json을 입력으로 받아서
    # MeCab 형태소 분석 → 난이도 점수 산출 (문장 길이, 어절 길이, 고난이도 어휘 비율)
    run_step(3, total_steps, "한국어 인지 난이도 분석")

    result_text = OUTPUT_DIR / "result_text.json"
    if result_text.exists():
        step3_ok = run_command(
            ["python", str(TEXT_LEVEL_DIR / "difficulty_engine.py"),
             str(result_text)],
            cwd=str(OUTPUT_DIR),
            description="난이도 분석",
        )
    else:
        print("  [건너뜀] result_text.json 파일이 없습니다.")
        step3_ok = False

    # ── Step 4: LLM 수정 제안 ──
    # Step 3에서 난이도가 높다고 판정된 문장에 대해
    # GPT-4o-mini에게 쉬운 표현으로의 수정안을 생성하도록 요청함.
    # (GPT는 측정이 아닌 수정 제안 생성에만 사용 — 측정은 자체 엔진이 담당)
    run_step(4, total_steps, "LLM 수정 제안 생성")

    result_difficulty = OUTPUT_DIR / "result_text_difficulty.json"
    if result_difficulty.exists():
        step4_ok = run_command(
            ["python", str(TEXT_LEVEL_DIR / "suggestion_generator.py"),
             str(result_difficulty)],
            cwd=str(OUTPUT_DIR),
            description="수정 제안 생성",
        )
    else:
        print("  [건너뜀] result_text_difficulty.json 파일이 없습니다.")
        step4_ok = False

    # ── Step 5: CV 시각 분석 ──
    # DOM replay 업로드와 CV 입력은 서로 독립적이다. Step 1이 OS 임시
    # 디렉터리에만 만든 PNG를 기존 CV 분석기에 전달하고, 성공/실패와 무관하게
    # run_cv_from_ephemeral_capture()의 finally에서 즉시 삭제한다.
    run_step(5, total_steps, "CV 시각 접근성 분석")
    step5_ok = run_cv_from_ephemeral_capture(cv_capture_path)

    # ── Step 6: 결과 통합 + 총점 계산 ──
    # 각 모듈이 생성한 JSON 파일을 읽어서 총점을 계산하고,
    # 모든 결과를 하나의 result_final.json으로 합침.
    # 각 step의 성공 여부를 확인하여, 실패한 모듈의 이전 결과 파일이
    # 남아있더라도 읽지 않음 (이전 실행 결과가 현재 결과에 혼입되는 것을 방지)
    run_step(6, total_steps, "결과 통합 및 총점 계산")

    rule_result = load_json(OUTPUT_DIR / "result_api.json") if step1_ok else None
    difficulty_result = load_json(OUTPUT_DIR / "result_text_difficulty.json") if step3_ok else None
    suggestion_result = load_json(OUTPUT_DIR / "result_text_suggestions.json") if step4_ok else None
    cv_result = load_json(OUTPUT_DIR / "result_cv.json") if step5_ok else None

    if step1_ok and not validate_target_navigation(url, rule_result):
        sys.exit(2)

    total_score = calculate_total_score(rule_result, difficulty_result, cv_result)

    elapsed = round(time.time() - start_time, 2)

    final_result = build_final_result(
        url=url,
        rule_result=rule_result,
        difficulty_result=difficulty_result,
        suggestion_result=suggestion_result,
        cv_result=cv_result,
        total_score=total_score,
        elapsed=elapsed,
        request_id=request_id,
    )

    # 최종 통합 결과를 JSON 파일로 저장함
    final_path = OUTPUT_DIR / "result_final.json"
    with open(final_path, 'w', encoding='utf-8') as f:
        json.dump(final_result, f, ensure_ascii=False, indent=2)

    print(f"  통합 결과 저장: {final_path}")

    # ── Step 7: 백엔드 전송 ──
    # 백엔드 서버가 실행 중이면 result_final.json을 POST로 전송함.
    # 서버가 꺼져 있어도 로컬 파일은 이미 저장되어 있으므로 문제없음.
    run_step(7, total_steps, "백엔드 서버 전송")

    ingestion_ok, saved_request_id = send_to_backend(final_result)
    if not ingestion_ok:
        sys.exit(1)

    # Artifact upload is deliberately sequenced after successful JSON ingestion.
    # A transport/storage failure here must not cause a retry of the already
    # committed evaluation POST, which could duplicate score and issue records.
    if saved_request_id is None:
        print("  [artifact] 업로드 건너뜀: 저장된 evaluation request ID를 확인할 수 없습니다.")
    else:
        upload_artifact(
            saved_request_id,
            OUTPUT_DIR / "result_artifact.json",
            OUTPUT_DIR / "result.html",
        )

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
