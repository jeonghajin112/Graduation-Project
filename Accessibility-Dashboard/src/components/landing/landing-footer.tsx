import "@/styles/landing-footer.css";

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
        <div className="ua-footer__main">
          <div className="ua-footer__brand">
            <button className="ua-footer__wordmark" type="button" onClick={returnToTop} aria-label="UNI ACCESS, 맨 위로 이동">
              <strong>UNI</strong><span className="ua-footer__dot" aria-hidden="true" /><span>ACCESS</span>
            </button>
            <p>누구에게나 편한 웹을 위한 접근성 분석.</p>
          </div>
        </div>
        <p className="ua-footer__copyright">© {new Date().getFullYear()} UNI ACCESS</p>
      </div>
    </footer>
  );
}
