import type { EnterAppHandler } from "@/components/landing/landing-page";

export function LandingEndSection({ onEnterApp }: { onEnterApp: EnterAppHandler }) {
  return (
    <section className="ua-end" aria-labelledby="ua-end-title">
      <div className="ua-shell">
        <h2 className="ua-end__title" id="ua-end-title">우리 기관 누리집은<br />몇 점일까요?</h2>
        <p className="ua-lede">주소를 넣으면 바로 결과를 받아 볼 수 있어요.</p>
        <a className="ua-button ua-button--large" href="/analyze" onClick={onEnterApp}>새 페이지 분석</a>
      </div>
    </section>
  );
}
