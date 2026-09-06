"""
CV 모듈 - 통합 실행기
ai-analysis/cv/cv_runner.py

[역할]
  CV 모듈의 전체 파이프라인을 한 번에 실행하는 통합 실행기.
  스크린샷 이미지를 입력받아 OCR → 명암비 분석 → 수정 추천 → 결과 JSON 출력까지
  일괄 처리

[이 파일의 역할 한줄 요약]
  "스크린샷 속 텍스트가 배경과 충분한 명암비를 갖는지 자동으로 측정하고,
   미달이면 수정 색상까지 추천하는 파이프라인을 실행."

[내부 파이프라인 — 4단계]
  Step 1: 사용자 제공 또는 screenshot_capture.py가 저장한 이미지 확인
  Step 2: vision_ocr.py 호출 → Google Vision API로 이미지 내 텍스트 + 위치 추출
  Step 3: contrast_analyzer.py 호출 → 각 텍스트의 전경색/배경색 명암비 계산 + 판정
  Step 4: 명암비 미달 항목에 대한 수정 추천 색상 생성

[현재 실행 위치]
  run_all.py가 규칙 검사와 같은 렌더 시점의 임시 PNG를 CV에만 전달하고 즉시 삭제.
  ★cv_runner.py는 임시 캡처 또는 사용자 제공 이미지를 분석 → result_cv.json

[사용법]
  방법 1: 분석할 이미지가 이미 있는 경우
    python cv_runner.py page.png

  방법 2: Python 코드에서 임포트하여 사용
    from cv_runner import CVRunner
    runner = CVRunner()
    result = runner.analyze("page.png")

[출력]
  result_cv.json — CV 분석 결과 (입력 이미지 경로는 저장하지 않음)
"""

import json
import sys
import os
import time
from pathlib import Path
from typing import Dict, Any, Optional, List
from datetime import datetime


AI_MODULE_DIR = Path(__file__).resolve().parents[1]
if str(AI_MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_MODULE_DIR))

from standard_mapping import kwcag_items_for_wcag


# ── 같은 폴더의 모듈 임포트 ──────────────────────────────────────────────────
# cv_runner.py, vision_ocr.py, contrast_analyzer.py가 같은 cv/ 폴더에 있음

from vision_ocr import run_ocr
from contrast_analyzer import ContrastAnalyzer


def cv_contrast_kwcag_item() -> Dict[str, str]:
    items = kwcag_items_for_wcag("1.4.3")
    if len(items) != 1:
        raise RuntimeError("WCAG 1.4.3 must map to exactly one KWCAG 2.2 item")
    return {
        **items[0],
        "description": "텍스트와 배경 간의 명도 대비는 4.5:1 이상이어야 한다",
        "level": "AA",
        "wcag_ref": "1.4.3",
    }


class CVRunner:
    """
    CV 모듈 통합 실행기.
    
    [처리 흐름]
    1. 스크린샷 이미지 존재 여부 확인
    2. vision_ocr.py를 호출하여 이미지 내 텍스트 + 위치(바운딩박스) 추출
    3. contrast_analyzer.py를 호출하여 각 텍스트의 명암비 계산 + AA/AAA 판정
    4. 명암비 미달 항목마다 기준을 충족하는 대체 색상 추천 생성
    5. 모든 결과를 하나의 JSON(result_cv.json)으로 출력
    
    [이 모듈에서 AI가 개입하는 지점]
    Step 2의 OCR(텍스트 인식)에만 외부 AI(Google Vision API)를 사용함.
    Step 3~4의 명암비 계산과 판정은 WCAG 공식 + 임계값 비교로 이루어지는
    순수 규칙 기반 처리임.
    
    [점수 체계]
    이 모듈은 자체 점수(100점 만점)를 계산하지 않음.
    pass_rate(통과율)와 위반 건수 같은 원시 통계를 제공하고,
    run_all.py가 이를 받아서 가중치(20%)를 적용하여 총점에 합산
    """
    
    def __init__(self, credentials_path: Optional[str] = None):
        """
        매개변수:
          credentials_path: Google Vision API 서비스 계정 키 JSON 파일 경로.
                            None이면 GOOGLE_APPLICATION_CREDENTIALS 환경변수를 사용
        """
        self.credentials_path = credentials_path
        self.contrast_analyzer = ContrastAnalyzer()
    
    def analyze(self, 
                image_path: str,
                output_path: Optional[str] = None) -> Dict[str, Any]:
        """
        스크린샷 이미지를 받아서 CV 분석 전체(OCR → 명암비 → 수정 추천)를 실행
        
        매개변수:
          image_path: 사용자 제공 또는 screenshot_capture.py가 저장한 이미지 경로
          output_path: 결과 JSON 저장 경로. None이면 result_cv.json으로 자동 생성
        
        반환값:
          result_cv.json 형식의 딕셔너리. 구조는 아래 _build_result() 참조.
        """
        start_time = time.time()
        
        print("=" * 60)
        print("CV 모듈 - 시각 접근성 분석")
        print("=" * 60)
        
        # ── Step 1: 이미지 확인 ──
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"스크린샷 파일이 없습니다: {image_path}")
        
        print(f"\n[Step 1/4] 스크린샷 확인: {image_path}")
        print(f"  파일 크기: {image_path.stat().st_size / 1024:.1f} KB")
        
        # ── Step 2: OCR 텍스트 추출 ──
        # vision_ocr.py의 run_ocr() 함수를 호출함.
        # Google Vision API가 이미지에서 텍스트 + 바운딩박스(위치)를 추출함.
        # 같은 이미지를 다시 분석할 때는 MD5 캐시를 사용하여 API 호출을 건너뜀.
        print(f"\n[Step 2/4] OCR 텍스트 추출 (Google Vision API)")
        
        output_directory = Path(output_path).parent if output_path else Path.cwd()
        ocr_output = str(output_directory / "result_ocr.json")
        ocr_result = run_ocr(
            str(image_path), 
            output_path=ocr_output,
            credentials_path=self.credentials_path
        )

        # The integrated pipeline supplies an OS-temp PNG. Do not persist that
        # machine-local path in OCR/CV JSON or upload it as result metadata.
        ocr_result.pop("image_path", None)
        with open(ocr_output, 'w', encoding='utf-8') as f:
            json.dump(ocr_result, f, ensure_ascii=False, indent=2)
        
        ocr_texts = ocr_result.get("texts", [])
        print(f"  추출된 텍스트: {len(ocr_texts)}개")
        
        if not ocr_texts:
            print("  [경고] 텍스트가 추출되지 않았습니다. 빈 결과를 반환합니다.")
            result = self._build_empty_result(ocr_result)
            if output_path is None:
                output_path = "result_cv.json"
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            print(f"Result saved: {output_path}")
            return result
        
        # ── Step 3: 명암비 분석 ──
        # contrast_analyzer.py의 analyze_screenshot() 함수를 호출함.
        # OCR이 찾은 각 텍스트 위치에서 전경색/배경색을 픽셀로 추출하고,
        # WCAG 공식으로 명암비를 계산한 뒤 AA 기준(4.5:1) 통과 여부를 판정함.
        print(f"\n[Step 3/4] 명암비 분석")
        
        contrast_result = self.contrast_analyzer.analyze_screenshot(
            str(image_path), 
            ocr_texts
        )
        
        summary = contrast_result["summary"]
        print(f"  분석 완료: {summary['total']}개 텍스트")
        print(f"  통과: {summary['pass_count']}개 | 위반: {summary['fail_count']}개")
        print(f"  통과율: {summary['pass_rate']}%")
        print(f"  평균 명암비: {summary['avg_ratio']}:1")
        
        # ── Step 4: 수정 추천 생성 ──
        # 명암비 미달인 각 텍스트에 대해, 기준을 충족하는 대체 색상을 추천함.
        # 방안 1(글자를 더 어둡게)과 방안 2(배경을 더 밝게) 두 가지를 모두 생성함.
        print(f"\n[Step 4/4] 위반 항목 수정 추천 생성")
        
        violations_with_fix = []
        for v in contrast_result["violations"]:
            fg = tuple(v["foreground"])
            bg = tuple(v["background"])
            fix = self.contrast_analyzer.suggest_fix(fg, bg, v["threshold"])
            
            violations_with_fix.append({
                **v,
                "fix_suggestion": fix,
            })
        
        print(f"  수정 추천 생성: {len(violations_with_fix)}건")
        
        # ── 최종 결과 조합 ──
        elapsed = round(time.time() - start_time, 2)
        
        result = self._build_result(
            ocr_result=ocr_result,
            contrast_result=contrast_result,
            violations_with_fix=violations_with_fix,
            elapsed=elapsed,
        )
        
        # 결과를 JSON 파일로 저장함
        if output_path is None:
            output_path = str(image_path.stem).replace("result", "") 
            output_path = "result_cv.json"
        
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        
        print(f"\n{'=' * 60}")
        print(f"CV 분석 완료! ({elapsed}초)")
        print(f"결과 저장: {output_path}")
        print(f"{'=' * 60}")
        
        return result
    
    def _build_result(self,
                      ocr_result: Dict,
                      contrast_result: Dict,
                      violations_with_fix: List[Dict],
                      elapsed: float) -> Dict[str, Any]:
        """
        run_all.py 및 백엔드 연동용 최종 결과 JSON을 구성
        
        이 JSON은 run_all.py가 읽어서 다른 모듈 결과(규칙 기반, 난이도 분석)와
        합산하여 총점을 계산하는 데 사용
        백엔드는 run_all.py가 만든 result_final.json을 받아서 DB에 저장
        
        [포맷 설계 원칙]
        - snake_case 통일: run.js의 toApiFormat()과 동일한 네이밍 규칙
        - 요약(summary)과 상세(violations) 분리: 대시보드 렌더링 편의
        - KWCAG 항목 번호 포함: 5.4.3 텍스트 콘텐츠의 명도 대비
        """
        summary = contrast_result["summary"]
        
        return {
            # ── 메타 정보 ──
            "module": "cv_visual_contrast",       # ← 모듈 식별자
            "version": "1.0.0",
            "analyzed_at": datetime.now().isoformat(),
            "elapsed_seconds": elapsed,            # ← CV 분석 소요 시간
            "ocr_backend": ocr_result.get("backend", "unknown"),  # ← 사용한 OCR 엔진
            
            # ── KWCAG 매핑 ──
            # 이 CV 모듈이 검사하는 KWCAG 항목 정보.
            # 규칙 기반 모듈의 mapping.js를 공통 브릿지로 조회하여
            # WCAG 1.4.3에 대응하는 KWCAG 항목을 가져온다.
            "kwcag_item": cv_contrast_kwcag_item(),
            
            # ── 점수 요약 ──
            # run_all.py가 이 값을 읽어서 총점 계산에 사용함.
            # 총점 공식: ... + (CV pass_rate × 20%)
            # pass_rate가 80이면 → 80 × 0.2 = 16점이 총점에 기여함.
            "summary": {
                "total_texts_analyzed": summary["total"],  # ← 분석한 텍스트 총 개수
                "pass_count": summary["pass_count"],       # ← 명암비 통과 수
                "fail_count": summary["fail_count"],       # ← 명암비 미달 수
                "pass_rate": summary["pass_rate"],         # ← 통과율 (%) — 총점 계산에 사용됨
                "avg_contrast_ratio": summary["avg_ratio"],# ← 전체 평균 명암비
                "min_contrast_ratio": summary["min_ratio"],# ← 가장 낮은 명암비
                "worst_text": summary["worst_text"],       # ← 명암비가 가장 낮은 텍스트
            },
            
            # ── 위반 상세 (수정 추천 포함) ──
            # 프론트엔드 대시보드에서 위반 항목 목록 + 수정 가이드를 표시할 때 사용됨.
            # 각 위반 항목마다:
            #   - 어떤 텍스트가 문제인지 (text, location)
            #   - 현재 명암비가 얼마인지 (contrast_ratio)
            #   - 기준이 얼마인지 (required_ratio)
            #   - 어떻게 고치면 되는지 (fix_suggestion: 글자 어둡게 / 배경 밝게)
            "violations": [
                {
                    "text": v["text"],                      # ← 위반 텍스트 내용
                    "location": v["bbox"],                  # ← 스크린샷 내 위치 (x, y, w, h)
                    "contrast_ratio": v["ratio"],           # ← 현재 명암비
                    "contrast_display": v["ratio_display"], # ← 표시용 문자열 ("3.21:1")
                    "required_ratio": v["threshold"],       # ← 적용된 기준 (4.5 또는 3.0)
                    "is_large_text": v["is_large_text"],    # ← 큰 텍스트 여부
                    "foreground_color": v["foreground"],    # ← 추출된 전경색 RGB
                    "background_color": v["background"],    # ← 추출된 배경색 RGB
                    "fix_suggestion": {
                        "darken_text": {                    # ← 방안 1: 글자를 더 어둡게
                            "suggested_color": v["fix_suggestion"].get("option_1", {}).get("suggested_fg", []),
                            "suggested_hex": v["fix_suggestion"].get("option_1", {}).get("suggested_fg_hex", ""),
                            "new_ratio": v["fix_suggestion"].get("option_1", {}).get("new_ratio", 0),
                        },
                        "lighten_background": {             # ← 방안 2: 배경을 더 밝게
                            "suggested_color": v["fix_suggestion"].get("option_2", {}).get("suggested_bg", []),
                            "suggested_hex": v["fix_suggestion"].get("option_2", {}).get("suggested_bg_hex", ""),
                            "new_ratio": v["fix_suggestion"].get("option_2", {}).get("new_ratio", 0),
                        },
                    } if v["fix_suggestion"].get("needed") else None,
                }
                for v in violations_with_fix
            ],
            
            # ── 통과 항목 수 (상세는 생략, 필요시 확장 가능) ──
            "pass_count_detail": {
                "aa_normal": sum(1 for p in contrast_result["passes"] 
                               if p.get("aa_normal_text")),
                "aa_large": sum(1 for p in contrast_result["passes"] 
                               if p.get("aa_large_text")),
            },
        }
    
    def _build_empty_result(self, ocr_result: Dict) -> Dict[str, Any]:
        """
        OCR에서 텍스트가 하나도 추출되지 않았을 때 반환하는 빈 결과
        이미지에 텍스트가 없는 경우(예: 순수 이미지 페이지)에 해당
        빈 결과라도 JSON 구조는 동일하게 유지하여,
        run_all.py와 백엔드가 별도 예외 처리 없이 동일한 방식으로 읽을 수 있음.
        """
        return {
            "module": "cv_visual_contrast",
            "version": "1.0.0",
            "analyzed_at": datetime.now().isoformat(),
            "elapsed_seconds": 0,
            "ocr_backend": ocr_result.get("backend", "unknown"),
            "kwcag_item": cv_contrast_kwcag_item(),
            "summary": {
                "total_texts_analyzed": 0,
                "pass_count": 0,
                "fail_count": 0,
                "pass_rate": 0,
                "avg_contrast_ratio": 0,
                "min_contrast_ratio": 0,
                "worst_text": None,
            },
            "violations": [],
            "pass_count_detail": {"aa_normal": 0, "aa_large": 0},
            "note": "OCR에서 텍스트가 추출되지 않았습니다. "
                    "이미지에 텍스트가 없거나, OCR 엔진 설정을 확인하세요.",
        }


# ── CLI 실행 ─────────────────────────────────────────────────────────────────


def main():
    """
    커맨드라인에서 직접 실행할 때의 진입점.
    
    사용법:
      python cv_runner.py <screenshot.png>
      python cv_runner.py <screenshot.png> --credentials <서비스계정키.json>
      python cv_runner.py <screenshot.png> --output <결과파일.json>
    
    예시:
      python cv_runner.py page.png
      python cv_runner.py page.png --credentials vision_key.json
      python cv_runner.py page.png --output cv_result.json
    """
    if len(sys.argv) < 2:
        print("사용법: python cv_runner.py <screenshot.png>")
        print("옵션:   --credentials <서비스계정키.json>")
        print("        --output <결과파일.json>")
        sys.exit(1)
    
    image_path = sys.argv[1]
    
    # 옵션 파싱
    credentials = None
    output = None
    
    for i, arg in enumerate(sys.argv):
        if arg == "--credentials" and i + 1 < len(sys.argv):
            credentials = sys.argv[i + 1]
        elif arg == "--output" and i + 1 < len(sys.argv):
            output = sys.argv[i + 1]
    
    runner = CVRunner(credentials_path=credentials)
    runner.analyze(image_path, output_path=output)


if __name__ == "__main__":
    main()
