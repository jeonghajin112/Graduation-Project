import type { EnterAppHandler } from "@/components/landing/landing-page";

export function LandingEndSection({ onEnterApp }: { onEnterApp: EnterAppHandler }) {
  return (
    <section className="ua-end" aria-labelledby="ua-end-title">
      <div className="ua-shell">
        <h2 className="ua-end__title" id="ua-end-title">내 사이트는<br />몇 점일까요?</h2>
        <p className="ua-lede">주소를 입력하면 라이브 리포트와 최종 리포트를 받아 볼 수 있어요.</p>
        <a className="ua-button ua-button--large" href="/analyze" onClick={onEnterApp}>새 페이지 분석</a>
      </div>
    </section>
  );
}
