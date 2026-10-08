import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useScroll } from "framer-motion";

import {
  mountScrollWorld,
  type ScrollWorldConfig
} from "@/components/landing/scroll-world-engine.js";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingMessageSection } from "@/components/landing/landing-message-section";
import { LandingLookSection } from "@/components/landing/landing-look-section";
import { LandingStatsSection } from "@/components/landing/landing-stats-section";
import { LandingReportSection } from "@/components/landing/landing-report-section";
import { LandingToolsSection } from "@/components/landing/landing-tools-section";
import { LandingEngineSection } from "@/components/landing/landing-engine-section";
import { LandingCompareSection } from "@/components/landing/landing-compare-section";
import { LandingFaqSection } from "@/components/landing/landing-faq-section";
import { LandingEndSection } from "@/components/landing/landing-end-section";
import { LandingFooter } from "@/components/landing/landing-footer";

// Latin 700 only: the landing wordmark is the sole DM Sans text.
import "@fontsource/dm-sans/latin-700.css";
import "@/styles/landing.css";
import "@/styles/landing-large-screen.css";

const ASSET_ROOT = "/landing/scroll-world";
const STATIC_HERO_QUERY = "(max-width: 760px), (prefers-reduced-motion: reduce)";
// 휴대폰 세로 화면은 16:9 오프닝 사진을 크게 잘라 내므로, 필름을 제품 화면 카드부터 시작한다.
const PHONE_FILM_QUERY = "(max-width: 760px)";

function matchesPhoneFilm() {
  return typeof window !== "undefined" && window.matchMedia(PHONE_FILM_QUERY).matches;
}

/**
 * 제품 소개 랜딩.
 * 히어로의 사진 카드가 화면을 채우면 같은 장면에서 스크롤 필름이 이어받고,
 * 필름이 끝나면 기능 소개 섹션이 차례로 이어진다. 상단바와 건너뛰기 링크는 페이지가 그린다.
 */
const LANDING_CONFIG = {
  brand: { name: "UNI ACCESS", href: "#uni-access-main", wordmark: { text: "uniaccess" } },
  mainId: "uni-access-main",
  chrome: false,
  nav: false,
  route: false,
  showSectionNumbers: false,
  mobileVideo: false,
  diveScroll: 1.4,
  maxScrollHeight: 1080,
  connScroll: 0.9,
  crossfade: 0.08,
  atmosphere: false,
  card: {
    width: 54,
    right: 4,
    radius: 24,
    in: 0.22,
    maxH: 82
  },
  // 원본 폭을 넘겨 늘리지 않도록 FHD/QHD 경계에서 다음 해상도 등급으로 전환합니다.
  clipVariants: [{ maxDevicePx: 2100, suffix: "-1080" }, { maxDevicePx: 3000, suffix: "-1440" }],
  sections: [
    {
      id: "opening",
      label: "시작",
      still: `${ASSET_ROOT}/opening.webp`,
      clip: `${ASSET_ROOT}/vid/opening.mp4?v=20261008-nts-full`,
      // 전체 화면의 사진 질감을 보존하도록 일반 데스크톱도 4K 원본을 사용한다.
      clipVariants: [],
      accent: "#0071e3",
      scroll: 1.6,
      linger: 0.3,
      // 제목은 위 히어로가 맡는다. 첫 장면은 히어로 카드에서 이어지는 영상만 보여 준다.
      title: "",
      tags: []
    },
    {
      id: "input",
      layout: "card",
      label: "주소 입력",
      still: `${ASSET_ROOT}/input.webp?v=20261008-nts-full`,
      clip: `${ASSET_ROOT}/vid/input.mp4?v=20261008-nts-full`,
      accent: "#0071e3",
      scroll: 1.3,
      linger: 0.2,
      title: "확인할 페이지 주소를 입력하세요",
      body: "URL을 입력하고 분석을 시작하면, 페이지의 접근성 문제를 확인할 수 있습니다.",
      tags: ["URL 입력", "자동 렌더링"]
    },
    {
      id: "analyze",
      layout: "card",
      label: "자동 분석",
      still: `${ASSET_ROOT}/analyze.webp?v=20261008-nts-full`,
      clip: `${ASSET_ROOT}/vid/analyze.mp4?v=20261008-nts-full`,
      accent: "#0071e3",
      scroll: 1.4,
      linger: 0.2,
      title: "페이지 연결, 접근성 검사, 결과 준비",
      body: "규칙 기반 검사와 텍스트 난이도, 시각 명암비 분석이 한 번에 실행됩니다.",
      tags: ["axe-core", "난이도", "명암비"]
    },
    {
      id: "report",
      layout: "card",
      label: "분석 결과",
      still: `${ASSET_ROOT}/report.webp?v=20261008-nts-full`,
      clip: `${ASSET_ROOT}/vid/report.mp4?v=20261008-nts-full`,
      accent: "#0071e3",
      scroll: 1.7,
      linger: 0.3,
      eyebrow: "라이브 리포트",
      title: "페이지와 분석 결과를 한눈에.",
      body: "넓어진 페이지 옆에서 점수 추이와 심각도를 확인하세요. 주소와 분석 시각, 재분석은 상단에 모았습니다.",
      tags: []
    },
    {
      id: "overview",
      layout: "card",
      label: "프로젝트",
      still: `${ASSET_ROOT}/overview.webp?v=20261008-nts-full`,
      clip: `${ASSET_ROOT}/vid/overview.mp4?v=20261008-nts-full`,
      accent: "#0071e3",
      scroll: 1.5,
      linger: 0.4,
      title: "접근성을 한 화면에서",
      body: "프로젝트의 페이지별 점수와 분석 상태를 모아 보고, 페이지 상세에서 최근 분석 추이를 확인하세요.",
      tags: [],
      cta: {
        primary: {
          label: "새 페이지 분석",
          href: "/analyze",
          action: "enter-app"
        }
      }
    }
  ],
  connectors: []
} satisfies ScrollWorldConfig;

const PHONE_LANDING_CONFIG = {
  ...LANDING_CONFIG,
  sections: LANDING_CONFIG.sections.filter((section) => section.id !== "opening")
} satisfies ScrollWorldConfig;

type LandingPageProps = {
  onEnterApp: () => void;
};

export type EnterAppHandler = (event: MouseEvent<HTMLAnchorElement>) => void;

export function LandingPage({ onEnterApp }: LandingPageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onEnterAppRef = useRef(onEnterApp);
  const { scrollY } = useScroll();
  const [isPhoneFilm, setIsPhoneFilm] = useState(matchesPhoneFilm);

  useEffect(() => {
    const query = window.matchMedia(PHONE_FILM_QUERY);
    const update = () => setIsPhoneFilm(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    onEnterAppRef.current = onEnterApp;
  }, [onEnterApp]);

  const enterApp = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    onEnterAppRef.current();
  }, []);

  // 페이지가 그리는 '새 페이지 분석' 링크: 새 탭 열기 등은 그대로 두고 일반 클릭만 앱으로 전환한다.
  const onEnterAppClick = useCallback<EnterAppHandler>((event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    enterApp();
  }, [enterApp]);

  // 처음 열 때만 맨 위로 올린다. 화면 폭이 휴대폰 기준을 넘나들어 필름을 다시 만들 때는 위치를 지킨다.
  const hasMountedFilmRef = useRef(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    if (!hasMountedFilmRef.current) {
      hasMountedFilmRef.current = true;
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    // landing.css 와 같은 조건: 이때는 히어로 카드가 없으므로 필름 첫 장면이 히어로 바로 아래에 놓인다.
    const staticHero = window.matchMedia(STATIC_HERO_QUERY);

    return mountScrollWorld(root, isPhoneFilm ? PHONE_LANDING_CONFIG : LANDING_CONFIG, {
      externalMain: true,
      // 필름은 히어로 아래에서 시작하므로, 필름 맨 위를 스크롤 0으로 삼는다.
      scrollOffset: () => root.getBoundingClientRect().top + window.scrollY,
      // 카드가 커지는 동안은 카드가 화면을 맡고, 카드가 화면을 채운 순간 필름이 같은 장면으로 이어받는다.
      hideBeforeStart: () => !staticHero.matches,
      subscribeScroll: (listener) => scrollY.on("change", listener),
      onEnterApp: enterApp
    });
  }, [scrollY, enterApp, isPhoneFilm]);

  return (
    <>
      {/* 건너뛰기 링크와 상단바(banner)는 main 밖에 둔다. */}
      <a className="ua-skip-link" href={`#${LANDING_CONFIG.mainId}`}>본문으로 바로가기</a>
      <LandingNav onEnterApp={onEnterAppClick} />
      <main id={LANDING_CONFIG.mainId} tabIndex={-1} className="ua-landing outline-none">
        <LandingHero onEnterApp={onEnterAppClick} />
        <div ref={rootRef} id="tour" className="uni-scroll-world" data-landing-root />
        {/* 스크롤 필름이 끝난 뒤 이어지는 일반 섹션 */}
        <LandingMessageSection />
        <LandingLookSection />
        <LandingStatsSection />
        <LandingReportSection />
        <LandingToolsSection />
        <LandingEngineSection />
        <LandingCompareSection />
        <LandingFaqSection />
        <LandingEndSection onEnterApp={onEnterAppClick} />
      </main>
      <LandingFooter />
    </>
  );
}
