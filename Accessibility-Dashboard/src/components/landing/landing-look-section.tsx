import { useEffect, useRef } from "react";
import { mountLookDemo, type LookDemoSnapshot } from "@/components/landing/look-demo-engine";
import { useLandingPhone } from "@/components/landing/use-landing-phone";
import "@/styles/landing-look.css";

/**
 * 라이브 리포트 자세히 보기.
 * 국세청 분석 결과를 1920×1080 으로 찍은 고정 스냅샷 위에서 실제 라이브 리포트처럼 동작하는 데모를 보여 준다.
 * 위에는 기능 탭, 가운데는 16:9 앱 화면(분석한 페이지 스크롤, 마커 호버·클릭, 오른쪽 패널 필터·펼침, 그래프 툴팁).
 * 커서가 장면을 저절로 시연하다가 사용자가 직접 만지면 멈추고, 5초 동안 움직임이 없으면 다시 재생한다.
 * 스냅샷(public/landing/look-demo)과 동작 규칙은 look-demo-engine.js 주석을 볼 것.
 * 휴대폰에서는 앱 화면이 너무 작아 데모를 띄우지 않고, 기능 네 가지를 글로만 나열한다.
 */

const ASSET_ROOT = "/landing/look-demo";
const SNAPSHOT_URL = `${ASSET_ROOT}/snapshot.json?v=20261008-nts`;
const icon = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

// 장면 순서는 look-demo-engine.js 의 ITEMS 와 같다. body 와 icon 은 휴대폰 목록에서만 쓴다.
const FEATURES = [
  {
    id: "locate", title: "문제마다 마커", body: "문제가 있는 자리마다 표시를 붙여요. 누르면 무엇이 문제인지 보여 줘요.",
    icon: <svg {...icon}><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
  },
  {
    id: "cluster", title: "가까우면 하나로", body: "붙어 있는 문제는 표시 하나로 묶어요. 넘기면서 하나씩 볼 수 있어요.",
    icon: <svg {...icon}><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /><path d="M11 7h4a2 2 0 0 1 2 2v4" /></svg>
  },
  {
    id: "approx", title: "숨은 것은 대략", body: "닫힌 탭이나 메뉴 속 문제는 가장 가까운 자리에 점선으로 표시해요.",
    icon: <svg {...icon} strokeDasharray="3 3"><rect x="4" y="4" width="16" height="16" rx="3" /></svg>
  },
  {
    id: "offscreen", title: "빠짐없이 목록으로", body: "자리를 찾을 수 없는 문제도 목록에 빠짐없이 모아 둬요.",
    icon: <svg {...icon}><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></svg>
  }
] as const;

export function LandingLookSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const isPhone = useLandingPhone();

  // 섹션이 화면 가까이 왔을 때 스냅샷을 받아 데모를 붙인다. 휴대폰은 데모가 없으므로 받지 않는다.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || isPhone) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    const start = () => {
      fetch(SNAPSHOT_URL)
        .then(response => { if (!response.ok) throw new Error(`snapshot ${response.status}`); return response.json() as Promise<LookDemoSnapshot>; })
        .then(snapshot => { if (!cancelled) cleanup = mountLookDemo(section, { snapshot, assetRoot: ASSET_ROOT }); })
        .catch(() => { /* 스냅샷을 못 받으면 정지 화면만 남는다 */ });
    };
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "undefined") start();
    else {
      observer = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        observer?.disconnect();
        start();
      }, { rootMargin: "60% 0px" });
      observer.observe(section);
    }
    return () => { cancelled = true; observer?.disconnect(); cleanup?.(); };
  }, [isPhone]);

  return (
    <section className="ua-look" id="look" aria-labelledby="ua-look-title" ref={sectionRef}>
      <header className="ua-look__head">
        <p className="ua-look__eyebrow">라이브 리포트</p>
        <h2 className="ua-look__title" id="ua-look-title">페이지 위에서 자세히 보기.</h2>
        <p className="ua-look__lede">
          {isPhone
            ? "분석한 페이지 위에 문제를 바로 표시해요."
            : "국세청 페이지를 분석한 실제 리포트 화면이에요. 직접 스크롤하고 눌러 보세요."}
        </p>
      </header>
      {isPhone ? (
        <ul className="ua-look__list">
          {FEATURES.map((feature) => (
            <li key={feature.id}>
              <span className="ua-look__icon">{feature.icon}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ua-look__stack">
          <div className="ua-look__tabs" role="tablist" aria-label="라이브 리포트 기능" data-demo="tabs">
            {FEATURES.map((feature, index) => (
              <button key={feature.id} type="button" role="tab" className="ua-look__tab" id={`ua-look-tab-${feature.id}`}
                aria-controls="ua-look-panel" aria-selected={index === 0} tabIndex={index === 0 ? 0 : -1}>
                {feature.title}
              </button>
            ))}
          </div>
          <div className="ua-look__stage" role="tabpanel" id="ua-look-panel" aria-labelledby="ua-look-tab-locate" data-demo="panel">
            <div className="ua-demo-app" data-demo="app">
              <div className="ua-demo-view" data-demo="view" role="group" aria-label="분석 결과 화면">
                <div className="ua-demo-content" data-demo="content">
                  <img className="ua-demo-bg" src={`${ASSET_ROOT}/app.webp`} alt="분석 결과 화면. 가운데 국세청 페이지, 오른쪽 점수 추이·심각도 분포·화면에 표시되지 않은 문제" decoding="async" loading="lazy" />
                  <div className="ua-demo-tabs-hot" data-demo="tabs-hot" aria-hidden="true" />
                  <div className="ua-demo-frame" data-demo="frame">
                    <div className="ua-demo-page-scroll" data-demo="page-scroll" role="group" aria-label="분석한 국세청 페이지">
                      <div className="ua-demo-page" data-demo="page">
                        <img className="ua-demo-bg" src={`${ASSET_ROOT}/page.webp`} alt="국세청 누리집 (분석 당시 모습)" decoding="async" loading="lazy" />
                      </div>
                    </div>
                  </div>
                  <div className="ua-demo-rail" data-demo="rail" role="group" aria-label="분석 요약 패널" />
                  <div className="ua-demo-spot" data-demo="spot" aria-hidden="true" />
                  <div className="ua-demo-ring" data-demo="ring" aria-hidden="true" />
                </div>
              </div>
              <img className="ua-demo-sidebar" data-demo="sidebar" src={`${ASSET_ROOT}/sidebar.webp`} alt="" aria-hidden="true" decoding="async" loading="lazy" />
              <div className="ua-demo-side-hot" data-demo="side-hot" aria-hidden="true" />
              <div className="ua-demo-try" data-demo="try" aria-hidden="true">
                <svg viewBox="0 0 16 16"><path d="M8 1.5v13M4.5 5 8 1.5 11.5 5M4.5 11 8 14.5 11.5 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                직접 스크롤하고, 마커를 눌러 보세요
              </div>
              <div className="ua-demo-cursor" data-demo="cursor" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.6L10 19z" fill="#111" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /></svg>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
