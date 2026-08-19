"""
CV 모듈 - 명암비 분석기
ai-analysis/cv/contrast_analyzer.py

[역할]
  스크린샷 이미지에서 OCR로 찾아낸 각 텍스트 영역의
  전경색(글자색)과 배경색을 추출하고,
  WCAG 명암비 공식으로 두 색상의 대비를 계산하여
  접근성 기준(AA/AAA) 통과 여부를 판정

[WCAG 명암비 기준 — 이 모듈의 판정 기준]
  - AA 일반 텍스트(18pt 미만):   4.5:1 이상
  - AA 큰 텍스트(18pt 이상):     3.0:1 이상
  - AAA 일반 텍스트:             7.0:1 이상
  - AAA 큰 텍스트:               4.5:1 이상
  KWCAG 5.3.3(콘텐츠의 명도 대비)은 WCAG AA 수준을 요구하므로,
  이 모듈의 기본 판정 기준은 AA(4.5:1 / 3.0:1)

[사용법]
  from contrast_analyzer import ContrastAnalyzer
  analyzer = ContrastAnalyzer()

  # 방법 1: 두 RGB 색상을 직접 입력하여 명암비 계산
  result = analyzer.calculate_ratio((255, 255, 255), (0, 0, 0))
  # → {'ratio': 21.0, 'aa_normal': True, 'aa_large': True, ...}

  # 방법 2: 스크린샷 + OCR 바운딩박스를 입력하여 자동 측정
  results = analyzer.analyze_screenshot('screenshot.png', ocr_results)
  # → 각 텍스트 영역별 명암비 + 판정 결과 + 위반/통과 분류

[파이프라인 위치]
  screenshot_capture.py → vision_ocr.py → ★contrast_analyzer.py → cv_runner.py
  
  vision_ocr.py가 전달하는 것: 텍스트 내용 + 바운딩박스(x, y, width, height)
  이 모듈이 하는 것: 바운딩박스 위치의 픽셀에서 색상 추출 → 명암비 계산 → 판정
  cv_runner.py에 전달하는 것: 위반 목록 + 통과 목록 + 요약 통계
"""

import json
import sys
from pathlib import Path
from typing import Tuple, List, Dict, Any, Optional
from collections import Counter

from PIL import Image


# ── WCAG 명암비 계산 핵심 함수들 ─────────────────────────────────────────────
# WCAG 2.x 공식 기반.
# 참고: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio


def srgb_to_linear(c: int) -> float:
    """
    sRGB 채널값(0~255)을 선형 RGB 값(0.0~1.0)으로 변환
    
    [왜 이 변환이 필요한가]
    모니터는 sRGB 색공간을 사용하는데, sRGB에는 감마 보정이 적용되어 있음.
    즉, RGB(128, 128, 128)이 물리적으로 정확히 중간 밝기가 아님.
    WCAG 명암비 공식은 물리적 휘도(luminance) 기반이므로,
    먼저 감마 보정을 제거해서 "실제 밝기"에 비례하는 선형 값으로 바꿔야
    정확한 명암비를 계산할 수 있음.
    
    [공식]
    - 낮은 값(≤0.04045): 선형 구간이므로 단순 나눗셈
    - 높은 값(>0.04045): 감마 2.4를 제거하는 역변환 적용
    """
    # 0~255 정수를 0.0~1.0 실수로 정규화
    s = c / 255.0
    
    # WCAG 표준 감마 역변환 공식
    if s <= 0.04045:
        return s / 12.92
    else:
        return ((s + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb: Tuple[int, int, int]) -> float:
    """
    RGB 색상의 상대 휘도(relative luminance)를 계산함.
    
    [공식]
    L = 0.2126 × R_linear + 0.7152 × G_linear + 0.0722 × B_linear
    
    [계수의 의미]
    사람의 눈은 색상마다 밝기 민감도가 다름:
      - 초록색(G)에 가장 민감함 → 계수 0.7152 (가장 큼)
      - 빨간색(R)은 중간        → 계수 0.2126
      - 파란색(B)에 가장 둔감함  → 계수 0.0722 (가장 작음)
    이 계수는 국제조명위원회(CIE)의 인간 시각 민감도 연구에서 나온 값
    
    [반환값]
    0.0(완전한 검정) ~ 1.0(완전한 흰색)
    """
    r_lin = srgb_to_linear(rgb[0])
    g_lin = srgb_to_linear(rgb[1])
    b_lin = srgb_to_linear(rgb[2])
    
    return 0.2126 * r_lin + 0.7152 * g_lin + 0.0722 * b_lin


def contrast_ratio(color1: Tuple[int, int, int], 
                   color2: Tuple[int, int, int]) -> float:
    """
    두 색상의 WCAG 명암비(contrast ratio)를 계산
    
    [공식]
    명암비 = (L_밝은쪽 + 0.05) / (L_어두운쪽 + 0.05)
    
    [+0.05를 더하는 이유]
    1. 완전한 검정(L=0)일 때 분모가 0이 되는 것을 방지
    2. 현실에서 완벽한 검정은 존재하지 않음 (모니터도 약간의 빛을 방출)
    
    [반환값 범위]
    1.0 (두 색상이 동일) ~ 21.0 (흰색 vs 검정, 최대 대비)
    
    [예시]
    흰색(255,255,255) vs 검정(0,0,0)  → 21.0:1
    흰색(255,255,255) vs 회색(128,128,128) → 약 3.95:1  (AA 미달)
    """
    lum1 = relative_luminance(color1)
    lum2 = relative_luminance(color2)
    
    # 밝은 쪽이 분자, 어두운 쪽이 분모
    lighter = max(lum1, lum2)
    darker = min(lum1, lum2)
    
    return (lighter + 0.05) / (darker + 0.05)


def check_wcag_compliance(ratio: float) -> Dict[str, bool]:
    """
    계산된 명암비가 WCAG AA/AAA 각 기준을 통과하는지 판정
    
    [기준 요약]
    AA  일반 텍스트(18pt 미만):  4.5:1 이상 → 대부분의 웹사이트가 따라야 하는 기준
    AA  큰 텍스트(18pt 이상):    3.0:1 이상 → 큰 글씨는 기준이 완화됨
    AAA 일반 텍스트:             7.0:1 이상 → 가장 엄격한 기준
    AAA 큰 텍스트:               4.5:1 이상
    
    KWCAG 5.3.3은 AA 수준을 요구하므로,
    이 프로젝트에서는 aa_normal_text(4.5:1)를 주요 판정 기준으로 사용
    """
    return {
        "aa_normal_text": ratio >= 4.5,
        "aa_large_text": ratio >= 3.0,
        "aaa_normal_text": ratio >= 7.0,
        "aaa_large_text": ratio >= 4.5,
    }


# ── 이미지에서 색상 추출 ────────────────────────────────────────────────────


def extract_dominant_color(image: Image.Image, 
                           bbox: Tuple[int, int, int, int],
                           sample_type: str = "foreground") -> Tuple[int, int, int]:
    """
    스크린샷 이미지의 특정 영역에서 대표 색상을 추출
    
    [왜 단순 평균색이 아닌가]
    텍스트 영역의 모든 픽셀 평균을 구하면
    글자색과 배경색이 섞여서 실제 어느 쪽도 아닌 중간값이 나옴.
    예: 흰 배경에 검은 글씨 → 평균은 회색 → 실제 명암비와 전혀 다른 결과
    그래서 전경색과 배경색을 분리 추출하는 전략을 사용
    
    [전경색(글자색) 추출 전략]
    바운딩박스 내부 픽셀에서 가장 어두운 색상 클러스터를 추출
    텍스트는 보통 배경보다 어두우므로, 어두운 쪽이 글자색일 가능성이 높음.
    
    [배경색 추출 전략]
    바운딩박스를 상하좌우 20% 확장한 영역에서 가장 빈번한(최빈) 색상을 추출
    배경은 넓은 영역에 균일하게 퍼져 있으므로, 가장 많이 나타나는 색 = 배경색
    
    [색상 양자화]
    비슷한 색상을 묶기 위해 RGB 각 채널을 8 단위로 반올림
    예: (123, 45, 67) → (120, 40, 64)
    이렇게 하면 안티앨리어싱 등으로 미세하게 다른 색들이 하나로 합쳐져서
    대표 색상을 더 정확하게 추출 가능
    
    [매개변수]
    - image: PIL Image 객체 (스크린샷 전체 이미지)
    - bbox: (x, y, width, height) — vision_ocr.py가 찾은 텍스트의 바운딩박스
    - sample_type: "foreground"(글자색) 또는 "background"(배경색)
    """
    x, y, w, h = bbox
    img_w, img_h = image.size
    
    if sample_type == "background":
        # 배경: 바운딩박스를 상하좌우 20% 확장한 영역에서 최빈 색상을 추출
        pad_x = max(int(w * 0.2), 5)
        pad_y = max(int(h * 0.2), 5)
        crop_box = (
            max(0, x - pad_x),
            max(0, y - pad_y),
            min(img_w, x + w + pad_x),
            min(img_h, y + h + pad_y)
        )
    else:
        # 전경: 바운딩박스 내부 영역 그대로 사용함
        crop_box = (
            max(0, x),
            max(0, y),
            min(img_w, x + w),
            min(img_h, y + h)
        )
    
    # 영역이 너무 작으면 기본값 반환 (전경=검정, 배경=흰색)
    if crop_box[2] <= crop_box[0] or crop_box[3] <= crop_box[1]:
        return (0, 0, 0) if sample_type == "foreground" else (255, 255, 255)
    
    cropped = image.crop(crop_box)
    
    try:
        # RGBA 이미지인 경우 알파 채널을 제거하고 RGB로 변환
        if cropped.mode != 'RGB':
            cropped = cropped.convert('RGB')
        
        # 성능 최적화: 이미지를 작은 크기로 축소한 뒤 픽셀을 분석
        small = cropped.resize((min(cropped.width, 50), min(cropped.height, 50)))
        pixels = list(small.getdata())
        
        if not pixels:
            return (0, 0, 0) if sample_type == "foreground" else (255, 255, 255)
        
        # 색상 양자화: RGB 각 채널을 8 단위로 반올림하여 비슷한 색을 하나로 묶음
        quantized = []
        for r, g, b in pixels:
            quantized.append((r // 8 * 8, g // 8 * 8, b // 8 * 8))
        
        color_counts = Counter(quantized)
        
        if sample_type == "background":
            # 배경: 가장 많이 나타나는 색상 = 배경색
            dominant = color_counts.most_common(1)[0][0]
        else:
            # 전경(글자색): 어두운 색상들 중에서 가장 빈번한 것을 선택
            # 밝기순으로 정렬한 뒤, 하위 30%(어두운 쪽)에서 최빈 색상을 추출
            sorted_colors = sorted(color_counts.items(), 
                                   key=lambda x: sum(x[0]))  # R+G+B 합 = 밝기 근사
            dark_cutoff = max(1, len(sorted_colors) // 3)
            dark_colors = sorted_colors[:dark_cutoff]
            dominant = max(dark_colors, key=lambda x: x[1])[0]
        
        return dominant
        
    except Exception as e:
        print(f"  [경고] 색상 추출 실패: {e}")
        return (0, 0, 0) if sample_type == "foreground" else (255, 255, 255)


# ── 메인 분석 클래스 ─────────────────────────────────────────────────────────


class ContrastAnalyzer:
    """
    스크린샷 이미지 + OCR 결과를 받아서 각 텍스트 영역의 명암비를 측정하는 분석기.
    
    [처리 흐름]
    1. vision_ocr.py로부터 텍스트 내용 + 바운딩박스(위치) 목록을 받음
    2. 각 바운딩박스 위치에서 전경색(글자색)과 배경색을 픽셀 분석으로 추출
    3. WCAG 명암비 공식으로 두 색상의 대비율을 계산
    4. KWCAG 5.3.3 기준(AA: 4.5:1 / 큰 텍스트: 3.0:1)으로 통과/위반을 판정
    5. 위반 항목에 대해서는 기준을 충족하는 대체 색상을 추천
    
    [이 모듈에서 AI가 사용되는 부분]
    없음. 명암비 계산과 판정은 전부 WCAG 공식 + 임계값 비교로 이루어지는
    순수 규칙 기반 처리임. AI(Google Vision API)는 이전 단계(vision_ocr.py)의
    텍스트 위치 인식에만 사용됨.
    """
    
    # KWCAG 5.3.3 (콘텐츠의 명도 대비) 기준값
    # KWCAG는 WCAG AA 수준을 요구함
    KWCAG_NORMAL_THRESHOLD = 4.5   # 일반 텍스트: 4.5:1 이상
    KWCAG_LARGE_THRESHOLD = 3.0    # 큰 텍스트(18pt 이상): 3.0:1 이상
    
    def __init__(self):
        pass
    
    def calculate_ratio(self, 
                        fg: Tuple[int, int, int], 
                        bg: Tuple[int, int, int]) -> Dict[str, Any]:
        """
        두 RGB 색상의 명암비를 계산하고 WCAG 판정 결과를 반환
        
        매개변수:
          fg: 전경색(글자색) RGB 튜플. 예: (0, 0, 0) = 검정
          bg: 배경색 RGB 튜플.       예: (255, 255, 255) = 흰색
        
        반환 예시:
          {
            "foreground": [0, 0, 0],       ← 입력된 전경색
            "background": [255, 255, 255], ← 입력된 배경색
            "ratio": 21.0,                 ← 계산된 명암비
            "ratio_display": "21.00:1",    ← 표시용 문자열
            "aa_normal_text": true,        ← AA 일반 텍스트 통과 여부
            "aa_large_text": true,         ← AA 큰 텍스트 통과 여부
            "aaa_normal_text": true,       ← AAA 일반 텍스트 통과 여부
            "aaa_large_text": true,        ← AAA 큰 텍스트 통과 여부
            "kwcag_pass": true             ← KWCAG 5.3.3 기준 통과 여부
          }
        """
        ratio = contrast_ratio(fg, bg)
        compliance = check_wcag_compliance(ratio)
        
        return {
            "foreground": list(fg),
            "background": list(bg),
            "ratio": round(ratio, 2),
            "ratio_display": f"{ratio:.2f}:1",
            **compliance,
            "kwcag_pass": ratio >= self.KWCAG_NORMAL_THRESHOLD,
        }
    
    def analyze_screenshot(self, 
                           image_path: str, 
                           ocr_results: List[Dict]) -> Dict[str, Any]:
        """
        스크린샷 이미지 + OCR 결과를 받아서
        모든 텍스트 영역의 명암비를 한꺼번에 분석
        
        [처리 과정]
        1. OCR 결과 목록을 순회하며 각 텍스트의 바운딩박스를 읽음
        2. 바운딩박스 위치에서 전경색/배경색을 이미지 픽셀로부터 추출
        3. 명암비를 계산하고, 텍스트 크기에 따라 적용할 기준을 선택
           - 텍스트 높이 24px 이상 → 큰 텍스트 → 기준 3.0:1
           - 텍스트 높이 24px 미만 → 일반 텍스트 → 기준 4.5:1
        4. 기준 미달이면 violations(위반), 통과면 passes(통과)로 분류
        5. 위반 목록은 명암비가 낮은 순(가장 심각한 것이 먼저)으로 정렬
        
        매개변수:
          image_path: 스크린샷 이미지 파일 경로
          ocr_results: vision_ocr.py의 출력 중 texts 배열. 각 항목 형태:
            {
              "text": "로그인",
              "bbox": {"x": 100, "y": 200, "width": 80, "height": 24},
              "confidence": 0.95
            }
        
        반환값:
          {
            "image_path": "screenshot.png",
            "total_texts": 15,            ← 분석한 텍스트 총 개수
            "violations": [...],          ← 명암비 미달 항목 목록
            "passes": [...],              ← 명암비 통과 항목 목록
            "summary": {
              "total": 15,                ← 분석 대상 텍스트 수
              "pass_count": 12,           ← 통과 수
              "fail_count": 3,            ← 위반 수
              "pass_rate": 80.0,          ← 통과율 (%)
              "avg_ratio": 8.45,          ← 전체 평균 명암비
              "min_ratio": 2.31,          ← 가장 낮은 명암비
              "worst_text": "자세히 보기"  ← 명암비가 가장 낮은 텍스트
            }
          }
        """
        image = Image.open(image_path)
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        violations = []
        passes = []
        all_ratios = []
        
        for i, ocr_item in enumerate(ocr_results):
            text = ocr_item.get("text", "").strip()
            bbox_raw = ocr_item.get("bbox", {})
            confidence = ocr_item.get("confidence", 0)
            
            # 텍스트가 없거나 너무 짧으면 건너뜀
            if not text or len(text) < 1:
                continue
            
            # bbox 딕셔너리를 (x, y, width, height) 튜플로 변환
            bbox = (
                bbox_raw.get("x", 0),
                bbox_raw.get("y", 0),
                bbox_raw.get("width", 0),
                bbox_raw.get("height", 0),
            )
            
            # 바운딩박스 크기가 0 이하이면 유효하지 않으므로 건너뜀
            if bbox[2] <= 0 or bbox[3] <= 0:
                continue
            
            # 해당 바운딩박스 위치에서 전경색/배경색을 픽셀 분석으로 추출함
            fg_color = extract_dominant_color(image, bbox, "foreground")
            bg_color = extract_dominant_color(image, bbox, "background")
            
            # 추출된 두 색상의 명암비를 WCAG 공식으로 계산함
            result = self.calculate_ratio(fg_color, bg_color)
            
            # "큰 텍스트" 여부를 바운딩박스 높이로 추정함
            # CSS 기준: 18pt ≈ 24px, 14pt bold ≈ 18.67px
            # OCR 바운딩박스 높이가 24px 이상이면 큰 텍스트로 간주함
            is_large_text = bbox[3] >= 24
            
            # 텍스트 크기에 따라 적용할 명암비 기준을 선택함
            threshold = (self.KWCAG_LARGE_THRESHOLD if is_large_text 
                        else self.KWCAG_NORMAL_THRESHOLD)
            is_pass = result["ratio"] >= threshold
            
            item = {
                "text": text,
                "bbox": bbox_raw,
                "confidence": confidence,
                "is_large_text": is_large_text,
                "threshold": threshold,
                "threshold_display": f"{threshold:.1f}:1",
                **result,
            }
            
            if is_pass:
                passes.append(item)
            else:
                violations.append(item)
            
            all_ratios.append(result["ratio"])
        
        # 위반 항목을 명암비 낮은 순으로 정렬함 (가장 심각한 위반이 맨 앞)
        violations.sort(key=lambda x: x["ratio"])
        
        # 요약 통계 계산
        total = len(all_ratios)
        summary = {
            "total": total,
            "pass_count": len(passes),
            "fail_count": len(violations),
            "pass_rate": round(len(passes) / total * 100, 1) if total > 0 else 0,
            "avg_ratio": round(sum(all_ratios) / total, 2) if total > 0 else 0,
            "min_ratio": round(min(all_ratios), 2) if all_ratios else 0,
            "worst_text": violations[0]["text"] if violations else None,
        }
        
        return {
            "image_path": str(image_path),
            "total_texts": total,
            "violations": violations,
            "passes": passes,
            "summary": summary,
        }
    
    def suggest_fix(self, 
                    fg: Tuple[int, int, int], 
                    bg: Tuple[int, int, int],
                    target_ratio: float = 4.5) -> Dict[str, Any]:
        """
        명암비가 기준에 미달할 때, 기준을 충족하는 대체 색상 조합을 추천
        
        [두 가지 방안을 모두 제시하는 이유]
        실무에서는 브랜드 가이드라인 등으로 글자색이나 배경색 중
        한쪽을 못 바꾸는 경우가 있으므로, 양쪽 모두 제안
        색상 변화가 더 적은 쪽이 실용적
        
        [추천 전략]
        - 방안 1: 전경색(글자)을 단계적으로 더 어둡게 조정
        - 방안 2: 배경색을 단계적으로 더 밝게 조정
        
        매개변수:
          fg, bg: 현재 전경/배경 RGB 색상
          target_ratio: 목표 명암비. 기본값 4.5 (KWCAG AA 일반 텍스트 기준)
        
        반환 예시 (미달인 경우):
          {
            "needed": true,
            "current_ratio": 2.31,
            "target_ratio": 4.5,
            "option_1": {                              ← 글자를 어둡게
              "description": "전경색(글자)을 더 어둡게",
              "suggested_fg_hex": "#1A1A1A",
              "new_ratio": 4.58
            },
            "option_2": {                              ← 배경을 밝게
              "description": "배경색을 더 밝게",
              "suggested_bg_hex": "#FAFAFA",
              "new_ratio": 4.52
            }
          }
        """
        current_ratio = contrast_ratio(fg, bg)
        
        if current_ratio >= target_ratio:
            return {
                "needed": False,
                "current_ratio": round(current_ratio, 2),
                "message": "이미 기준을 충족합니다."
            }
        
        # 방안 1: 전경색을 단계적으로 어둡게 해서 목표 도달
        adjusted_fg = self._darken_to_target(fg, bg, target_ratio)
        
        # 방안 2: 배경색을 단계적으로 밝게 해서 목표 도달
        adjusted_bg = self._lighten_to_target(fg, bg, target_ratio)
        
        return {
            "needed": True,
            "current_ratio": round(current_ratio, 2),
            "target_ratio": target_ratio,
            "option_1": {
                "description": "전경색(글자)을 더 어둡게",
                "original_fg": list(fg),
                "suggested_fg": list(adjusted_fg),
                "suggested_fg_hex": self._rgb_to_hex(adjusted_fg),
                "new_ratio": round(contrast_ratio(adjusted_fg, bg), 2),
            },
            "option_2": {
                "description": "배경색을 더 밝게",
                "original_bg": list(bg),
                "suggested_bg": list(adjusted_bg),
                "suggested_bg_hex": self._rgb_to_hex(adjusted_bg),
                "new_ratio": round(contrast_ratio(fg, adjusted_bg), 2),
            },
        }
    
    def _darken_to_target(self, 
                          fg: Tuple[int, int, int], 
                          bg: Tuple[int, int, int], 
                          target: float) -> Tuple[int, int, int]:
        """
        전경색을 RGB 각 채널에서 1씩 줄여가며(더 어둡게)
        목표 명암비에 도달하는 색상을 찾음.
        최대 256단계까지 시도하며, 못 찾으면 검정(0,0,0)을 반환
        """
        r, g, b = fg
        for step in range(256):
            candidate = (max(0, r - step), max(0, g - step), max(0, b - step))
            if contrast_ratio(candidate, bg) >= target:
                return candidate
        return (0, 0, 0)
    
    def _lighten_to_target(self, 
                           fg: Tuple[int, int, int], 
                           bg: Tuple[int, int, int], 
                           target: float) -> Tuple[int, int, int]:
        """
        배경색을 RGB 각 채널에서 1씩 늘려가며(더 밝게)
        목표 명암비에 도달하는 색상을 찾음.
        최대 256단계까지 시도하며, 못 찾으면 흰색(255,255,255)을 반환
        """
        r, g, b = bg
        for step in range(256):
            candidate = (min(255, r + step), min(255, g + step), min(255, b + step))
            if contrast_ratio(fg, candidate) >= target:
                return candidate
        return (255, 255, 255)
    
    @staticmethod
    def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
        """RGB 튜플을 HEX 문자열로 변환함. 예: (255, 0, 0) → '#FF0000'"""
        return f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


# ── CLI 실행 ─────────────────────────────────────────────────────────────────


def main():
    """
    커맨드라인에서 직접 실행할 때의 진입점.
    두 가지 모드를 지원
    
    모드 1 — 두 색상의 명암비 직접 계산:
      python contrast_analyzer.py 0,0,0 255,255,255
      → 검정과 흰색의 명암비 21.0:1 출력
    
    모드 2 — 스크린샷 + OCR JSON으로 전체 분석:
      python contrast_analyzer.py screenshot.png ocr_result.json
      → 스크린샷 내 모든 텍스트의 명암비 분석 결과 출력
    """
    if len(sys.argv) < 3:
        print("사용법:")
        print("  색상 비교:  python contrast_analyzer.py R,G,B R,G,B")
        print("  이미지 분석: python contrast_analyzer.py <screenshot.png> <ocr.json>")
        sys.exit(1)
    
    arg1, arg2 = sys.argv[1], sys.argv[2]
    analyzer = ContrastAnalyzer()
    
    # 모드 판별: 첫 인자에 콤마가 있으면 색상 모드, 없으면 이미지 모드
    if "," in arg1:
        fg = tuple(int(x) for x in arg1.split(","))
        bg = tuple(int(x) for x in arg2.split(","))
        
        result = analyzer.calculate_ratio(fg, bg)
        print(f"\n전경색: RGB{fg}")
        print(f"배경색: RGB{bg}")
        print(f"명암비: {result['ratio_display']}")
        print(f"KWCAG 통과: {'✅' if result['kwcag_pass'] else '❌'}")
        print(f"AA 일반: {'✅' if result['aa_normal_text'] else '❌'}")
        print(f"AA 큰글씨: {'✅' if result['aa_large_text'] else '❌'}")
        print(f"AAA 일반: {'✅' if result['aaa_normal_text'] else '❌'}")
        print(f"AAA 큰글씨: {'✅' if result['aaa_large_text'] else '❌'}")
        
        # 미달이면 수정 추천 색상을 출력함
        if not result['kwcag_pass']:
            fix = analyzer.suggest_fix(fg, bg)
            print(f"\n수정 추천:")
            print(f"  방안1: 글자색 → {fix['option_1']['suggested_fg_hex']}"
                  f" (명암비 {fix['option_1']['new_ratio']}:1)")
            print(f"  방안2: 배경색 → {fix['option_2']['suggested_bg_hex']}"
                  f" (명암비 {fix['option_2']['new_ratio']}:1)")
    else:
        # 이미지 + OCR JSON 모드
        image_path = arg1
        ocr_path = arg2
        
        with open(ocr_path, 'r', encoding='utf-8') as f:
            ocr_data = json.load(f)
        
        ocr_results = ocr_data.get("texts", ocr_data) if isinstance(ocr_data, dict) else ocr_data
        
        result = analyzer.analyze_screenshot(image_path, ocr_results)
        
        print(f"\n=== 명암비 분석 결과 ===")
        print(f"분석 이미지: {image_path}")
        print(f"총 텍스트: {result['summary']['total']}개")
        print(f"통과: {result['summary']['pass_count']}개")
        print(f"위반: {result['summary']['fail_count']}개")
        print(f"통과율: {result['summary']['pass_rate']}%")
        print(f"평균 명암비: {result['summary']['avg_ratio']}:1")
        
        if result['violations']:
            print(f"\n--- 위반 항목 (명암비 낮은 순) ---")
            for v in result['violations'][:10]:
                print(f"  '{v['text']}' → {v['ratio_display']}"
                      f" (기준 {v['threshold_display']}) ❌")
        
        # 결과를 JSON 파일로 저장함
        output_path = Path(image_path).stem + "_contrast.json"
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"\n결과 저장: {output_path}")


if __name__ == "__main__":
    main()
