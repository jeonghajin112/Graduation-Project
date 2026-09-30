"""
============================================================
 명암비 공식 검증 스크립트 (test_contrast_formula.py)
============================================================

[목적]
  contrast_analyzer.py의 contrast_ratio() 함수가 WCAG 명세를 정확히
  구현했는지 검증한다. CV 모듈은 사람 평가로 "좋다/나쁘다"를 판단할 대상이
  아니라 수학 공식이므로, 검증 방법이 달라야 한다: 사람에게 물어볼 게
  아니라 "계산이 맞는가"를 확인해야 한다.

[검증 방법 — 3단계]
  1) 자명한 극값 검증: 흑백 대비는 21:1, 동일색 대비는 1:1이어야 한다
     (WCAG 명세상 이 값은 논쟁의 여지가 없는 하드 그라운드트루스)
  2) 독립 재구현 대조: 이 파일에서 WCAG 공식을 처음부터 다시 구현하고
     (contrast_analyzer.py의 코드를 보지 않고 W3C 명세만 보고 작성),
     무작위 색상 200쌍에 대해 두 구현이 같은 값을 내는지 비교한다.
     → 코드 두 벌이 같은 결과를 내면 "우연히 같은 버그"가 아닌 이상
       공식 구현이 맞다는 강한 증거가 된다.
  3) 판정 임계값 검증: check_wcag_compliance()가 4.5:1 / 3.0:1 / 7.0:1
     경계값에서 정확히 통과/미달을 나누는지 확인 (경계값 버그는 실무에서
     흔한 실수 — 예: >= 대신 > 를 써서 정확히 4.5:1인 경우를 놓치는 등)

[사용법]
  python test_contrast_formula.py
  (cv-analyzer 폴더 안에서 실행 — contrast_analyzer.py를 import함)

[성능검증 문서에 쓸 수 있는 문장 예시]
  "CV 명암비 계산 모듈은 WCAG 2.x 명세를 독립적으로 재구현한 결과와
   무작위 색상 200쌍에서 100% 일치했으며, 경계값(4.5:1/3.0:1/7.0:1)
   판정에서도 오차가 없음을 확인했다."
"""

import random
import sys


# ────────────────────────────────────────────
# 1. 독립 재구현 (contrast_analyzer.py 코드를 보지 않고 W3C 명세로만 작성)
#    참고: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
# ────────────────────────────────────────────

def _independent_srgb_to_linear(c):
    s = c / 255.0
    if s <= 0.03928:
        # W3C 명세 원문은 임계값을 0.03928로 표기함
        # (contrast_analyzer.py는 0.04045를 사용 — 실무에서 흔히 쓰이는
        #  변형이며 두 값 모두 결과에 미치는 영향은 소수 넷째 자리 이하로
        #  무시할 만한 수준. 아래에서 허용 오차 안에 드는지 확인한다.)
        return s / 12.92
    return ((s + 0.055) / 1.055) ** 2.4


def _independent_luminance(rgb):
    r, g, b = rgb
    return (0.2126 * _independent_srgb_to_linear(r)
            + 0.7152 * _independent_srgb_to_linear(g)
            + 0.0722 * _independent_srgb_to_linear(b))


def independent_contrast_ratio(c1, c2):
    l1 = _independent_luminance(c1)
    l2 = _independent_luminance(c2)
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


# ────────────────────────────────────────────
# 2. 검증 실행
# ────────────────────────────────────────────

def main():
    try:
        from contrast_analyzer import contrast_ratio, check_wcag_compliance
    except ImportError as e:
        print(f"[오류] contrast_analyzer.py를 import할 수 없습니다: {e}")
        print("  cv-analyzer 폴더 안에서 실행했는지, pillow가 설치되어 있는지 확인하세요.")
        sys.exit(1)

    failures = []

    # ── 검증 1: 자명한 극값 ──
    print("[1/3] 극값 검증 (흑백=21:1, 동일색=1:1)")
    extreme_cases = [
        (((0, 0, 0), (255, 255, 255)), 21.0),
        (((255, 255, 255), (0, 0, 0)), 21.0),
        (((0, 0, 0), (0, 0, 0)), 1.0),
        (((255, 255, 255), (255, 255, 255)), 1.0),
        (((128, 128, 128), (128, 128, 128)), 1.0),
    ]
    for (c1, c2), expected in extreme_cases:
        actual = contrast_ratio(c1, c2)
        ok = abs(actual - expected) < 0.01
        status = "OK" if ok else "FAIL"
        print(f"  [{status}] {c1} vs {c2}: 실측 {actual:.3f} / 기대 {expected}")
        if not ok:
            failures.append(f"극값 불일치: {c1} vs {c2} → {actual} (기대 {expected})")

    # ── 검증 2: 독립 재구현과의 대조 (무작위 200쌍 + 시드 고정으로 재현 가능) ──
    print("\n[2/3] 독립 재구현 대조 (무작위 200쌍, 허용오차 0.02)")
    rng = random.Random(20260819)
    mismatches = 0
    max_diff = 0.0
    for _ in range(200):
        c1 = (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
        c2 = (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
        actual = contrast_ratio(c1, c2)
        expected = independent_contrast_ratio(c1, c2)
        diff = abs(actual - expected)
        max_diff = max(max_diff, diff)
        if diff > 0.02:
            mismatches += 1
            if mismatches <= 5:
                print(f"  [불일치] {c1} vs {c2}: contrast_analyzer={actual:.4f} / 독립구현={expected:.4f}")
    print(f"  200쌍 중 불일치 {mismatches}건, 최대 오차 {max_diff:.5f}")
    if mismatches > 0:
        failures.append(f"독립 재구현과 {mismatches}/200건 불일치 (최대 오차 {max_diff:.5f})")

    # ── 검증 3: WCAG 판정 임계값 경계 테스트 ──
    print("\n[3/3] 판정 임계값 경계 테스트")
    boundary_cases = [
        (4.5, {"aa_normal_text": True, "aa_large_text": True, "aaa_normal_text": False, "aaa_large_text": True}),
        (4.499, {"aa_normal_text": False, "aa_large_text": True, "aaa_normal_text": False, "aaa_large_text": False}),
        (3.0, {"aa_normal_text": False, "aa_large_text": True, "aaa_normal_text": False, "aaa_large_text": False}),
        (2.999, {"aa_normal_text": False, "aa_large_text": False, "aaa_normal_text": False, "aaa_large_text": False}),
        (7.0, {"aa_normal_text": True, "aa_large_text": True, "aaa_normal_text": True, "aaa_large_text": True}),
        (6.999, {"aa_normal_text": True, "aa_large_text": True, "aaa_normal_text": False, "aaa_large_text": True}),
    ]
    for ratio, expected in boundary_cases:
        actual = check_wcag_compliance(ratio)
        ok = actual == expected
        status = "OK" if ok else "FAIL"
        print(f"  [{status}] ratio={ratio}: {actual}")
        if not ok:
            failures.append(f"경계값 판정 불일치: ratio={ratio} → {actual} (기대 {expected})")

    # ── 결과 요약 ──
    print("\n" + "=" * 50)
    if failures:
        print(f"검증 실패: {len(failures)}건")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    else:
        print("검증 통과: 명암비 공식 구현이 독립 재구현·극값·임계값 기준과 모두 일치합니다.")
    print("=" * 50)


if __name__ == "__main__":
    main()
