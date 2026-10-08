import { useEffect, useRef } from "react";
import type { EnterAppHandler } from "@/components/landing/landing-page";

const OPENING_STILL = "/landing/scroll-world/opening.webp";
const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * 히어로 제목과 사진 카드.
 * 데스크톱에서는 스크롤에 따라 카드가 화면을 가득 채우고, 그 순간 바로 아래 스크롤 필름이
 * 같은 장면(오프닝 첫 프레임)에서 이어받는다. 필름은 CSS에서 카드 구간의 마지막 한 화면과 겹쳐 시작한다.
 * 좁은 화면과 모션 축소 설정에서는 카드를 숨기고 필름의 첫 장면이 그 역할을 한다.
 */
export function LandingHero({ onEnterApp }: { onEnterApp: EnterAppHandler }) {
  const diveRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dive = diveRef.current;
    const frame = frameRef.current;
    if (!dive || !frame) return;
    const staticQuery = window.matchMedia("(max-width: 760px), (prefers-reduced-motion: reduce)");
    let raf = 0;
    const layout = () => {
      raf = 0;
      if (staticQuery.matches) { frame.style.cssText = ""; return; }
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const rect = dive.getBoundingClientRect();
      const g = smooth(Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height - vh))));
      const w0 = Math.min(1076, vw - 44);
      const h0 = (w0 * 9) / 16;
      frame.style.width = `${w0 + (vw - w0) * g}px`;
      frame.style.height = `${h0 + (vh - h0) * g}px`;
      frame.style.borderRadius = `${28 * (1 - g)}px`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(layout); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    staticQuery.addEventListener("change", schedule);
    layout();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      staticQuery.removeEventListener("change", schedule);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <>
      <section className="ua-hero" aria-labelledby="ua-hero-title">
        <h1 className="ua-hero__title" id="ua-hero-title">공공 서비스의 웹 접근성,<br />이제 한눈에.</h1>
        <p className="ua-hero__lede">주소만 넣으면 돼요. 문제를 찾아 <b>그 자리에 바로</b> 보여 주고, 고치는 방법도 알려 줘요.</p>
        <div className="ua-hero__actions">
          <a className="ua-button" href="/analyze" onClick={onEnterApp}>새 페이지 분석</a>
        </div>
      </section>
      <div className="ua-dive" ref={diveRef} aria-hidden="true">
        <div className="ua-dive__sticky">
          <div className="ua-dive__frame" ref={frameRef}>
            {/* lazy: phones hide this card, so they never fetch it; desktops get it from the preload in index.html. */}
            <img src={OPENING_STILL} width="1800" height="1013" alt="" decoding="async" loading="lazy" />
          </div>
        </div>
      </div>
    </>
  );
}
