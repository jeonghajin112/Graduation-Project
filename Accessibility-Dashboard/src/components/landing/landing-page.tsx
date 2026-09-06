import { useEffect, useLayoutEffect, useRef } from "react";
import { useScroll } from "framer-motion";

import {
  mountScrollWorld,
  type ScrollWorldConfig
} from "@/components/landing/scroll-world-engine.js";
import { LandingEngineSection } from "@/components/landing/landing-engine-section";
import { LandingMessageSection } from "@/components/landing/landing-message-section";
import { LandingFindingsSection } from "@/components/landing/landing-findings-section";
import { LandingFaqSection } from "@/components/landing/landing-faq-section";
import { LandingFooter } from "@/components/landing/landing-footer";

import "@/styles/landing-large-screen.css";

const ASSET_ROOT = "/landing/scroll-world";

const LANDING_CONFIG = {
  brand: { name: "UNI ACCESS", href: "#uni-access-main", wordmark: { strong: "UNI", light: "ACCESS" } },
  cta: { label: "새 페이지 분석", href: "/analyze", action: "enter-app" },
  skipLabel: "본문으로 바로가기",
  mainId: "uni-access-main",
  hint: "SCROLL DOWN",
  nav: false,
  route: false,
  showSectionNumbers: false,
  mobileVideo: false,
  diveScroll: 1.4,
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
      clip: `${ASSET_ROOT}/vid/opening.mp4`,
      accent: "#0071e3",
      scroll: 1.6,
      linger: 0.3,
      eyebrow: "통합형 웹 접근성 평가 플랫폼",
      title: "복잡한 웹 접근성, 이제 한눈에.",
      body: "코드부터 문장, 화면까지. 누구에게나 편한 웹을 만드세요.",
      tags: []
    },
    {
      id: "input",
      layout: "card",
      label: "주소 입력",
      still: `${ASSET_ROOT}/input.webp`,
      clip: `${ASSET_ROOT}/vid/input.mp4`,
      accent: "#0071e3",
      scroll: 1.3,
      linger: 0.2,
      title: "확인할 페이지 주소를 입력하세요",
      body: "URL을 넣고 분석 시작을 누르면 UNI ACCESS가 페이지를 직접 엽니다.",
      tags: ["URL 입력", "자동 렌더링"]
    },
    {
      id: "analyze",
      layout: "card",
      label: "자동 분석",
      still: `${ASSET_ROOT}/analyze.webp`,
      clip: `${ASSET_ROOT}/vid/analyze.mp4`,
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
      label: "페이지 보기",
      still: `${ASSET_ROOT}/report.webp`,
      clip: `${ASSET_ROOT}/vid/report.mp4`,
      accent: "#0071e3",
      scroll: 1.7,
      linger: 0.3,
      eyebrow: "실제 페이지",
      title: "실제 페이지를 그대로 확인하세요.",
      body: "입력한 사이트를 직접 열어, 익숙한 화면에서 확인할 수 있습니다.",
      tags: []
    },
    {
      id: "overview",
      layout: "card",
      label: "프로젝트",
      still: `${ASSET_ROOT}/overview.webp`,
      clip: `${ASSET_ROOT}/vid/overview.mp4`,
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
        },
        secondary: {
          label: "페이지 보기",
          href: "#report",
          section: "report"
        }
      }
    }
  ],
  connectors: []
} satisfies ScrollWorldConfig;

type LandingPageProps = {
  onEnterApp: () => void;
};

export function LandingPage({ onEnterApp }: LandingPageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onEnterAppRef = useRef(onEnterApp);
  const { scrollY } = useScroll();

  useEffect(() => {
    onEnterAppRef.current = onEnterApp;
  }, [onEnterApp]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    window.scrollTo({ top: 0, behavior: "auto" });

    return mountScrollWorld(root, LANDING_CONFIG, {
      subscribeScroll: (listener) => scrollY.on("change", listener),
      onEnterApp: () => {
        window.scrollTo({ top: 0, behavior: "auto" });
        onEnterAppRef.current();
      }
    });
  }, [scrollY]);

  return (
    <>
      <div ref={rootRef} className="uni-scroll-world" data-landing-root />
      {/* 스크롤 필름이 끝난 뒤 이어지는 일반 섹션 */}
      <LandingMessageSection />
      <LandingFindingsSection />
      <LandingEngineSection />
      <LandingFaqSection />
      <LandingFooter />
    </>
  );
}
