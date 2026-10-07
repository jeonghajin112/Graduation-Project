import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Pause, Play, Plus } from "lucide-react";
import "@/styles/landing-look.css";

/**
 * 라이브 리포트 자세히 보기.
 * 넓은 화면에서는 섹션이 화면에 고정된 채 스크롤 구간을 지나며, 스크롤 위치에 따라 왼쪽 항목이
 * 차례로 펼쳐지고 오른쪽 화면이 그 기능 상태로 바뀐다. 항목을 누르거나 방향키로 옮기면 그 항목의
 * 스크롤 위치로 이동해 스크롤과 선택이 어긋나지 않는다. 900px 이하에서는 고정 없이 눌러서 고른다.
 * 오른쪽은 실제 라이브 리포트(국세청 페이지)를 녹화한 영상이다. 섹션이 화면 가까이 올 때만 영상을 불러오고,
 * 모션 축소 설정에서는 대표 이미지만 보여 준다.
 * 설명은 실제 동작(마커 배치·클러스터·일시정지·APPROXIMATE_AREA·미표시 목록)과 맞춰 둘 것.
 */

type LookItem = {
  id: "locate" | "cluster" | "pause" | "approx" | "offscreen";
  title: string;
  description: ReactNode;
  /** 녹화 영상과 대표 이미지 (public/landing/look) */
  video: string;
  poster: string;
};

const LOOK_MEDIA = "/landing/look";

const ITEMS: readonly LookItem[] = [
  {
    id: "locate",
    video: `${LOOK_MEDIA}/locate.mp4`,
    poster: `${LOOK_MEDIA}/locate.webp`,
    title: "문제 위치에 마커를",
    description: <>분석한 페이지를 그대로 띄우고 문제가 있는 요소 모서리에 마커를 붙여요. <b>점 색은 심각도</b>, 글자는 문제를 찾은 분석기예요.</>
  },
  {
    id: "cluster",
    video: `${LOOK_MEDIA}/cluster.mp4`,
    poster: `${LOOK_MEDIA}/cluster.webp`,
    title: "가까운 문제는 하나로",
    description: <>마커가 겹치면 하나로 모아 <b>개수</b>를 보여 줘요. 설명창의 ‹ › 로 넘기면 강조 표시가 각 요소를 따라가고, 화면을 확대하면 묶음이 저절로 풀려요.</>
  },
  {
    id: "pause",
    video: `${LOOK_MEDIA}/pause.mp4`,
    poster: `${LOOK_MEDIA}/pause.webp`,
    title: "보는 동안 페이지가 멈춰요",
    description: <>자동으로 넘어가는 슬라이드도 마커에 마우스를 올리거나 <b>키보드 초점</b>을 옮기면 잠시 멈춰요. 움직임 없이 차분히 확인할 수 있어요.</>
  },
  {
    id: "approx",
    video: `${LOOK_MEDIA}/approx.mp4`,
    poster: `${LOOK_MEDIA}/approx.webp`,
    title: "숨은 요소는 대략적 위치로",
    description: <>닫힌 탭이나 접힌 메뉴 속 문제는 가장 가까운 보이는 영역에 <b>점선 마커</b>로 표시해요. 투명한 요소는 그 자리에 바로 표시해요.</>
  },
  {
    id: "offscreen",
    video: `${LOOK_MEDIA}/offscreen.mp4`,
    poster: `${LOOK_MEDIA}/offscreen.webp`,
    title: "표시 못 한 문제도 빠짐없이",
    description: <>위치를 찾을 수 없는 문제는 <b>KWCAG 항목별로</b> 묶어 오른쪽 목록에 모아요. 분석 이후 페이지에서 사라진 문제도 여기서 확인해요.</>
  }
];

const SCROLL_QUERY = "(min-width: 901px)";

export function LandingLookSection() {
  const [active, setActive] = useState(0);
  const [nearView, setNearView] = useState(false);
  // 움직이는 화면은 사용자가 멈출 수 있어야 하고(WCAG 2.2.2), 섹션을 벗어나면 재생하지 않는다.
  const [inView, setInView] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  // 영상은 섹션이 화면 가까이 왔을 때 처음 불러온다. 모션 축소 설정에서는 대표 이미지만 쓴다.
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => setReducedMotion(reduced.matches);
    syncMotion();
    reduced.addEventListener("change", syncMotion);
    const section = sectionRef.current;
    let observer: IntersectionObserver | undefined;
    if (section && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) setNearView(true);
        setInView(entry.isIntersecting);
      }, { rootMargin: "50% 0px" });
      observer.observe(section);
    } else {
      setNearView(true);
      setInView(true);
    }
    return () => { reduced.removeEventListener("change", syncMotion); observer?.disconnect(); };
  }, []);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const showVideo = nearView && !reducedMotion;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (inView && !userPaused) void video.play().catch(() => {});
    else video.pause();
  }, [inView, userPaused, showVideo, active]);
  const item = ITEMS[active];

  // 스크롤 구간 안의 진행도로 펼칠 항목을 고른다.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const scrollMode = window.matchMedia(SCROLL_QUERY);
    let raf = 0;
    const update = () => {
      raf = 0;
      if (!scrollMode.matches) return;
      const rect = section.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height - window.innerHeight)));
      const next = Math.min(ITEMS.length - 1, Math.floor(progress * ITEMS.length));
      setActive(current => (current === next ? current : next));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    scrollMode.addEventListener("change", schedule);
    update();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      scrollMode.removeEventListener("change", schedule);
      cancelAnimationFrame(raf);
    };
  }, []);

  // 고른 항목의 스크롤 위치(그 항목 구간의 가운데)로 이동한다. 좁은 화면에서는 바로 고른다.
  const select = useCallback((index: number) => {
    setActive(index);
    const section = sectionRef.current;
    if (!section || !window.matchMedia(SCROLL_QUERY).matches) return;
    const top = section.getBoundingClientRect().top + window.scrollY;
    const distance = section.offsetHeight - window.innerHeight;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: top + (distance * (index + 0.5)) / ITEMS.length, behavior: reduced ? "instant" : "smooth" });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: ITEMS.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = (next + ITEMS.length) % ITEMS.length;
    select(target);
    tabRefs.current[target]?.focus({ preventScroll: true });
  };

  return (
    <section className="ua-look" id="look" aria-labelledby="ua-look-title" ref={sectionRef}>
      <div className="ua-look__inner">
        <header className="ua-look__head">
          <p className="ua-look__eyebrow">라이브 리포트</p>
          <h2 className="ua-look__title" id="ua-look-title">페이지 위에서 자세히 보기.</h2>
        </header>

        <div className="ua-look__body">
          <div className="ua-look__pills" role="tablist" aria-label="라이브 리포트 기능" aria-orientation="vertical">
            {ITEMS.map((entry, index) => {
              const selected = index === active;
              return (
                <button
                  key={entry.id}
                  ref={element => { tabRefs.current[index] = element; }}
                  type="button"
                  role="tab"
                  id={`ua-look-tab-${entry.id}`}
                  className={`ua-look__pill${selected ? " is-active" : ""}`}
                  aria-selected={selected}
                  aria-controls="ua-look-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(index)}
                  onKeyDown={event => onKeyDown(event, index)}
                >
                  <span className="ua-look__pill-icon" aria-hidden="true"><Plus size={14} strokeWidth={1.8} /></span>
                  <span className="ua-look__pill-title">{entry.title}</span>
                  <span className="ua-look__pill-description">
                    <span className="ua-look__pill-clip">{entry.description}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="ua-look__panel" id="ua-look-panel" role="tabpanel" aria-labelledby={`ua-look-tab-${item.id}`}>
            {showVideo ? (
              <>
                <video className="ua-look__video" key={item.video} ref={videoRef} src={item.video} poster={item.poster}
                  muted loop playsInline preload="auto" aria-hidden="true" />
                <button className="ua-look__playback" type="button" onClick={() => setUserPaused((paused) => !paused)}
                  aria-label={userPaused ? "예시 영상 재생" : "예시 영상 일시정지"}>
                  {userPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                </button>
              </>
            ) : (
              <img className="ua-look__video" src={item.poster} alt="" width="1920" height="1248" decoding="async" />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
