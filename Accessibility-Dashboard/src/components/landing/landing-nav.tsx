import type { EnterAppHandler } from "@/components/landing/landing-page";

/** 반투명 흰 바에 워드마크와 주요 행동만 둔다. */
export function LandingNav({ onEnterApp }: { onEnterApp: EnterAppHandler }) {
  return (
    <header className="ua-lnav">
      <div className="ua-lnav__inner">
        <a className="ua-lnav__wordmark" href="#uni-access-main" aria-label="UNI ACCESS, 맨 위로">uniaccess</a>
        <a className="ua-lnav__cta" href="/analyze" onClick={onEnterApp}>새 페이지 분석</a>
      </div>
    </header>
  );
}
