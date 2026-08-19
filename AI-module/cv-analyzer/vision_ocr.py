"""
CV 모듈 - OCR 텍스트 추출
ai-analysis/cv/vision_ocr.py

[역할]
  스크린샷 이미지에서 텍스트와 그 위치(바운딩박스)를 추출
  다음 단계인 contrast_analyzer.py에서 각 텍스트 위치의 명암비를 측정할 때
  이 결과를 입력으로 사용

[왜 OCR이 필요한가]
  규칙 기반 모듈(run.js)은 HTML DOM을 검사하므로,
  이미지 안에 포함된 텍스트(예: 배너 이미지 속 안내 문구)는 검사할 수 없음.
  OCR로 이미지 속 텍스트의 위치를 알아내야
  그 텍스트가 배경과 충분한 명암비를 갖는지 측정할 수 있음.

[OCR 엔진 선택]
  Google Cloud Vision API를 사용
  한국어 인식 정확도가 높고, 복잡한 웹페이지 레이아웃에서도 안정적으로 동작함.

  어댑터 패턴(OCRBackend 인터페이스)으로 설계했기 때문에,
  나중에 다른 OCR 엔진(네이버 Clova OCR, AWS Textract 등)으로
  교체하려면 OCRBackend를 구현하는 새 클래스만 추가하면 됨.
  규칙 기반 모듈의 axe-core 어댑터(adapter.js)와 같은 설계 원리

[비용 절감 전략]
  Vision API 무료 티어는 월 1,000건이고, 초과 시 과금
  같은 이미지를 다시 분석하는 상황을 막기 위해
  이미지 파일의 MD5 해시값을 키로 사용하는 로컬 캐시를 구현.
  파일명이 달라도 이미지 내용이 같으면 캐시를 재사용하고,
  같은 파일명이라도 이미지가 바뀌면 새로 분석함.

[사용법]
  python vision_ocr.py <screenshot.png>

[파이프라인 위치]
  run.js (CV 전용 임시 캡처) → ★vision_ocr.py (텍스트 추출) → contrast_analyzer.py (명암비 측정) → cv_runner.py (통합·임시 캡처 정리는 run_all.py 담당)

[출력 형식]
  result_ocr.json:
  {
    "image_path": "screenshot.png",     ← 분석한 이미지 경로
    "backend": "google_vision",         ← 사용한 OCR 엔진 이름
    "texts": [
      {
        "text": "로그인",               ← 인식된 텍스트
        "bbox": {"x": 100, "y": 200,   ← 텍스트가 위치한 영역 (좌상단 좌표 + 크기)
                 "width": 80, "height": 24},
        "confidence": 0.95              ← 인식 신뢰도 (0.0 ~ 1.0)
      }, ...
    ]
  }
"""

import json
import sys
import os
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Optional
from abc import ABC, abstractmethod


# ── OCR 백엔드 인터페이스 (어댑터 패턴) ──────────────────────────────────────


class OCRBackend(ABC):
    
    @abstractmethod
    def extract_text(self, image_path: str) -> List[Dict[str, Any]]:
        """
        이미지에서 텍스트를 추출함.
        
        반환 형식 (모든 백엔드가 이 형식을 따라야 함):
          [
            {
              "text": "추출된 텍스트",
              "bbox": {"x": int, "y": int, "width": int, "height": int},
              "confidence": float  # 0.0 ~ 1.0
            }
          ]
        """
        pass
    
    @abstractmethod
    def get_name(self) -> str:
        """백엔드 이름 반환. 결과 JSON의 "backend" 필드에 기록됨."""
        pass


# ── Google Vision API 백엔드 ─────────────────────────────────────────────────


class VisionAPIBackend(OCRBackend):
    """
    Google Cloud Vision API를 사용하는 OCR 백엔드 구현체.
    
    [처리 흐름]
    1. 이미지 파일의 MD5 해시를 계산
    2. 캐시 폴더에 해당 해시의 결과가 있으면 → API 호출 없이 캐시를 반환
    3. 캐시가 없으면 → Vision API를 호출하여 텍스트를 추출
    4. API 응답에서 개별 단어의 텍스트 + 바운딩박스를 파싱
    5. 결과를 캐시에 저장하고 반환
    
    [Vision API 응답 구조]
    API가 돌려주는 text_annotations 배열:
      - [0번째]: 이미지 전체에서 인식된 텍스트를 한 덩어리로 합친 것 → 사용하지 않음
      - [1번째 이후]: 개별 단어/구문 + 해당 텍스트의 꼭짓점 좌표 4개 → 이걸 사용함
    
    [바운딩박스 변환]
    Vision API는 텍스트 영역을 꼭짓점 4개(사각형)로 표현함.
    기울어진 텍스트의 경우 이 사각형이 직사각형이 아닐 수 있으므로,
    4개 꼭짓점의 min/max를 구해서 이를 감싸는 최소 직사각형(x, y, width, height)으로 변환함.
    
    예시:
      Vision API 응답:  꼭짓점 (100,200), (180,200), (180,224), (100,224)
      변환 결과:        bbox = {"x": 100, "y": 200, "width": 80, "height": 24}
    """
    
    def __init__(self, credentials_path: Optional[str] = None, 
                 cache_dir: str = ".ocr_cache"):
        """
        매개변수:
          credentials_path: 서비스 계정 키 JSON 파일 경로.
                            None이면 GOOGLE_APPLICATION_CREDENTIALS 환경변수를 사용함.
          cache_dir: OCR 결과 캐시를 저장할 디렉토리 경로.
                     같은 이미지를 다시 분석할 때 API 호출을 건너뜀.
        """
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
        
        # 서비스 계정 키 경로를 환경변수에 설정함
        if credentials_path:
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
        
        # google-cloud-vision 라이브러리를 로드하고 API 클라이언트를 초기화함
        try:
            from google.cloud import vision
            self.client = vision.ImageAnnotatorClient()
            self.vision = vision
        except ImportError:
            raise ImportError(
                "google-cloud-vision이 설치되지 않았습니다.\n"
                "설치: pip install google-cloud-vision"
            )
        except Exception as e:
            raise RuntimeError(
                f"Vision API 초기화 실패: {e}\n"
                "GOOGLE_APPLICATION_CREDENTIALS 환경변수를 확인하세요."
            )
    
    def get_name(self) -> str:
        return "google_vision"
    
    def extract_text(self, image_path: str) -> List[Dict[str, Any]]:
        """
        Vision API의 text_detection 기능으로 텍스트 + 위치를 추출함.
        캐시가 있으면 API 호출을 건너뜀.
        
        [캐시 키 설계]
        이미지 파일 내용의 MD5 해시를 캐시 키로 사용함.
        - 파일명이 달라도 이미지 내용이 같으면 → 같은 캐시를 재사용함
        - 같은 파일명이라도 이미지 내용이 바뀌면 → 새로 API를 호출함
        이 방식으로 불필요한 API 호출을 방지하여 무료 티어(월 1,000건) 내에서 운용 가능함.
        """
        # ── 캐시 확인 ──
        with open(image_path, 'rb') as f:
            file_hash = hashlib.md5(f.read()).hexdigest()
        cache_path = self.cache_dir / f"{file_hash}.json"
        
        if cache_path.exists():
            print(f"  [캐시] OCR 결과 캐시 사용: {cache_path}")
            with open(cache_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        
        # ── Vision API 호출 ──
        with open(image_path, 'rb') as f:
            content = f.read()
        
        image = self.vision.Image(content=content)
        response = self.client.text_detection(image=image)
        
        # API 에러 처리
        if response.error.message:
            raise RuntimeError(f"Vision API 오류: {response.error.message}")
        
        texts = response.text_annotations
        
        # ── API 응답 파싱 ──
        # texts[0]은 이미지 전체 텍스트를 하나로 합친 것이므로 건너뜀.
        # texts[1:]부터가 개별 단어이며, 각 단어의 위치 좌표를 포함함.
        results = []
        for annotation in texts[1:]:
            text = annotation.description.strip()
            if not text:
                continue
            
            # bounding_poly 꼭짓점 4개 → (x, y, width, height) 직사각형으로 변환
            vertices = annotation.bounding_poly.vertices
            xs = [v.x for v in vertices]
            ys = [v.y for v in vertices]
            
            x_min, x_max = min(xs), max(xs)
            y_min, y_max = min(ys), max(ys)
            
            results.append({
                "text": text,
                "bbox": {
                    "x": x_min,
                    "y": y_min,
                    "width": x_max - x_min,
                    "height": y_max - y_min,
                },
                # Vision API의 text_detection 모드는 개별 단어의 신뢰도를 제공하지 않음.
                # document_text_detection 모드를 쓰면 제공되지만,
                # 응답 구조가 달라지고 우리 용도(텍스트 위치 추출)에는
                # text_detection이면 충분하므로 기본값 0.95를 사용함.
                "confidence": 0.95,
            })
        
        # ── 캐시 저장 ──
        with open(cache_path, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"  [캐시] OCR 결과 캐시 저장: {cache_path}")
        
        return results


# ── 메인 OCR 실행 함수 ──────────────────────────────────────────────────────


def run_ocr(image_path: str, 
            output_path: Optional[str] = None,
            credentials_path: Optional[str] = None) -> Dict[str, Any]:
    """
    이미지에서 OCR을 실행하고 결과를 JSON으로 반환/저장하는 진입점 함수.
    cv_runner.py에서 이 함수를 import하여 호출함.
    
    매개변수:
      image_path: 사용자 제공 또는 screenshot_capture.py가 저장한 이미지 경로
      output_path: 결과 JSON 저장 경로 (None이면 이미지명_ocr.json으로 자동 생성)
      credentials_path: Vision API 서비스 계정 키 경로 (None이면 환경변수 사용)
    
    반환값:
      {
        "image_path": "screenshot.png",
        "backend": "google_vision",
        "total_texts": 42,
        "texts": [ { "text": "...", "bbox": {...}, "confidence": 0.95 }, ... ]
      }
    """
    print(f"\n=== OCR 텍스트 추출 ===")
    print(f"이미지: {image_path}")
    
    # OCR 백엔드 생성 (현재는 Google Vision API를 사용함)
    backend = VisionAPIBackend(credentials_path=credentials_path)
    print(f"OCR 엔진: {backend.get_name()}")
    
    # OCR 실행 — 이미지에서 텍스트 + 위치 추출
    texts = backend.extract_text(image_path)
    print(f"추출된 텍스트: {len(texts)}개")
    
    # 결과 구성
    result = {
        "image_path": str(image_path),
        "backend": backend.get_name(),
        "total_texts": len(texts),
        "texts": texts,
    }
    
    # 결과를 JSON 파일로 저장
    if output_path is None:
        output_path = Path(image_path).stem + "_ocr.json"
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"결과 저장: {output_path}")
    
    return result


# ── CLI 실행 ─────────────────────────────────────────────────────────────────


def main():
    """
    커맨드라인에서 직접 실행할 때의 진입점.
    
    사용법:
      python vision_ocr.py <screenshot.png>
      python vision_ocr.py <screenshot.png> --credentials <서비스계정키.json>
    """
    if len(sys.argv) < 2:
        print("사용법: python vision_ocr.py <screenshot.png>")
        print("옵션:   --credentials <서비스계정키.json>")
        sys.exit(1)
    
    image_path = sys.argv[1]
    
    # --credentials 옵션 파싱
    credentials_path = None
    for i, arg in enumerate(sys.argv):
        if arg == "--credentials" and i + 1 < len(sys.argv):
            credentials_path = sys.argv[i + 1]
    
    result = run_ocr(image_path, credentials_path=credentials_path)
    
    # 상위 5개 텍스트 미리보기 출력
    print(f"\n--- 추출된 텍스트 미리보기 (상위 5개) ---")
    for t in result["texts"][:5]:
        print(f"  '{t['text']}' @ ({t['bbox']['x']}, {t['bbox']['y']})"
              f" 신뢰도 {t['confidence']}")


if __name__ == "__main__":
    main()
