/**
 * 마지막 섹션의 회색 면을 그대로 이어 간다:
 * 안내 문구, 가는 선, 워드마크와 저작권 한 줄.
 */
export function LandingFooter() {
  const returnToTop = () => {
    document.getElementById("uni-access-main")?.focus({ preventScroll: true });
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    });
  };

  return (
    <footer className="ua-footer">
      <div className="ua-footer__inner">
        <div className="ua-footer__notes">
          <p>
            분석 결과는 자동 검사로 찾은 문제이며, 한국형 웹 콘텐츠 접근성 지침(KWCAG) 2.2 준수를 보증하지 않습니다.
            자동으로 확인할 수 없는 항목은 사람이 직접 점검해야 합니다.
          </p>
          <p>이 페이지의 그림 속 점수와 건수는 기능을 설명하기 위한 예시입니다.</p>
        </div>

        <div className="ua-footer__bottom">
          <div className="ua-footer__brand">
            <button className="ua-footer__wordmark" type="button" onClick={returnToTop} aria-label="UNI ACCESS, 맨 위로 이동">
              uniaccess
            </button>
            <p>누구에게나 편한 웹을 위한 접근성 분석.</p>
          </div>
          <p>© {new Date().getFullYear()} UNI ACCESS</p>
        </div>
      </div>
    </footer>
  );
}
